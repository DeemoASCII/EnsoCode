import { randomUUID } from 'node:crypto';
import type {
  AgentWorkerEvent,
  AttachedImage,
  ConversationAuthority,
  ConversationBotBinding,
  ProjectAuthority,
} from '../../../shared/types/agent';
import type { BotChat, BotProfile } from '../../../shared/types/bot';
import type {
  BotEvent,
  BotQueueItem,
  BotSessionRecord,
  BotSilence,
} from '../../../shared/types/botIpc';
import { BOT_BUDGET_ERROR, type BotBudgetVerdict } from '../../../shared/usage/botUsage';
import type { BotNotesSnapshot } from './botNotes';
import { buildBotModeInstruction, buildBotSystemPrompt } from './botPrompt';
import type { BotStore } from './botStore';
import type { BotChatStore } from './chatStore';
import { StartedDeliveryIndex } from './startedDeliveries';

/** bot 会话同时在跑的轮次上限（私聊、群聊、委派、例行合计，Code 会话不计） */
export const BOT_MAX_RUNNING_TURNS = 4;
/** 运行中的轮次超过该时长没有任何输出（流式、工具进度、子代理）即视为静默 */
export const BOT_SILENCE_MS = 90_000;

type ActionResult = { ok: boolean; error?: string };
type Fail = { ok: false; error: string };

/** SourceAuthorityRegistry 的 Main 专用子集 */
export interface BotAuthorityPort {
  project(projectId: string): ProjectAuthority | undefined;
  conversation(conversationId: string): ConversationAuthority | undefined;
  ensureBotHomeProject(dir: string): ProjectAuthority | undefined;
  botHomeProject(dir: string): ProjectAuthority | undefined;
  removeBotHomeProject(projectId: string): boolean;
  createBotConversation(
    projectId: string,
    bot: ConversationBotBinding
  ): ConversationAuthority | undefined;
  endBotConversation(conversationId: string): ConversationAuthority | undefined;
  removeBotConversation(conversationId: string): ConversationAuthority | undefined;
  botConversations(): ConversationAuthority[];
}

export interface BotSpawnSpec {
  conversationId: string;
  projectId: string;
  cwd: string;
  resumeFile?: string;
  bot: BotProfile;
  /** 替换 pi 角色段 */
  systemPrompt: string;
  /** Bot 模式说明，追加在全局指令之后 */
  instructionText: string;
  /** 群聊成员会话：挂 group_tasks 工具 */
  groupTasks?: boolean;
  /** 私聊 / 群聊成员会话（委派会话走 independentSpecs，不挂）：挂 routine_propose */
  routines?: boolean;
}

export interface BotRuntimePort {
  spawn(spec: BotSpawnSpec): Promise<ActionResult>;
  prompt(
    conversationId: string,
    text: string,
    images?: AttachedImage[],
    deliveryId?: string
  ): ActionResult;
  steer(
    conversationId: string,
    text: string,
    images?: AttachedImage[],
    deliveryId?: string
  ): ActionResult;
  release(conversationId: string): Promise<void>;
  abort?(conversationId: string): void;
  removeSessionFiles(conversation: ConversationAuthority): void;
}

export interface BotSessionHostDeps {
  bots: BotStore;
  chats: BotChatStore;
  authority: BotAuthorityPort;
  runtime: BotRuntimePort;
  emit: (event: BotEvent) => void;
  maxRunningTurns?: number;
  /** 轮次只收到 idle/failed 状态而迟迟没有 turn-completed/turn-failed 时的兜底结算延迟 */
  settleGraceMs?: number;
  /** 成员日预算：投递前与每条带用量的 assistant 消息结束后检查，超额拒绝 / 停止当前回合 */
  budget?: { exceeded(botId: string): Promise<BotBudgetVerdict | null> };
  /** 核心笔记：成员 memory 关闭时返回 undefined */
  notes?: { snapshot(botId: string, chatId: string | null): BotNotesSnapshot | undefined };
  /** 静默看门狗阈值，缺省 BOT_SILENCE_MS */
  silenceMs?: number;
  now?: () => number;
}

export interface BotDeliverOptions {
  images?: AttachedImage[];
  deliveryId?: string;
  queueIfBusy?: boolean;
  onlyIfIdle?: boolean;
}

export type BotDeliverResult =
  | {
      ok: true;
      conversationId: string;
      queued?: boolean;
      turnId?: string;
      /** 同一 deliveryId 已被该会话处理过，本次没有发出 */
      duplicate?: true;
    }
  | Fail;

export interface BotTurnFinished {
  deliveryId?: string;
  /** 委派会话为 null */
  chatId: string | null;
  botId: string;
  conversationId: string;
  /** 排队投递在发给 worker 时失败则缺省 */
  turnId?: string;
  text: string;
  ok: boolean;
  error?: string;
  delegationId?: string;
  /** 本宿主发起该轮时分配的键；委派记录的 batchId 与之相同 */
  turnKey?: string;
}

interface Delivery extends BotDeliverOptions {
  chatId: string;
  botId: string;
  conversationId: string;
  text: string;
}

interface LastAssistant {
  index: number;
  text: string;
  stopReason?: string;
  errorMessage?: string;
}

type Workspace = { ok: true; cwd: string; projectId: string } | Fail;

/** (chatId, botId) → 根会话：建会话、spawn/恢复、投递、并发排队、回合结果回调 */
export class BotSessionHost {
  private readonly live = new Set<string>();
  private readonly running = new Set<string>();
  /** 由本宿主发起、尚未结束的轮次；sawRunning 防止 spawn 后的 idle 误释放 */
  private readonly slots = new Map<string, { sawRunning: boolean }>();
  private queue: Delivery[] = [];
  private readonly lastAssistant = new Map<string, LastAssistant>();
  private readonly bindings = new Map<string, ConversationBotBinding | null>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<(event: BotTurnFinished) => void>();
  private readonly maxRunning: number;
  private readonly settleGraceMs: number;
  private readonly settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly independentSpecs = new Map<string, BotSpawnSpec>();
  private readonly liveProfiles = new Map<string, BotProfile>();
  private readonly activeDeliveries = new Map<string, string>();
  private readonly turnKeys = new Map<string, string>();
  private disposed = false;
  private readonly budgetChecks = new Set<string>();
  /** 会话已看到的笔记版本（spawn 时进系统提示词，之后变化在投递前追加一次） */
  private readonly notesSeen = new Map<string, string>();
  private readonly deliveries = new Map<string, Map<string, 'sent' | 'started'>>();
  /** jsonl 里已开始处理的委派结果：首次全量、之后只读追加部分 */
  private readonly persistedStarts = new StartedDeliveryIndex();
  private readonly startedListeners = new Set<
    (event: { conversationId: string; deliveryId: string }) => void
  >();
  /** 运行中轮次的最后输出时间；silent = 已判静默（值为最后输出时间） */
  private readonly lastOutput = new Map<string, number>();
  private readonly silent = new Map<string, number>();
  /** 等待人类答复的审批 / 提问：期间不算静默 */
  private readonly waiting = new Map<string, Set<string>>();
  private watchdog: ReturnType<typeof setInterval> | undefined;

  onDeliveryStarted(
    listener: (event: { conversationId: string; deliveryId: string }) => void
  ): () => void {
    this.startedListeners.add(listener);
    return () => this.startedListeners.delete(listener);
  }

  hasStartedDelivery(conversationId: string, deliveryId: string): boolean {
    if (this.deliveries.get(conversationId)?.get(deliveryId) === 'started') return true;
    const file = this.deps.authority.conversation(conversationId)?.sessionFile;
    if (!file || !this.persistedStarts.has(file, deliveryId)) return false;
    this.rememberDelivery(conversationId, deliveryId, 'started');
    return true;
  }
  private readonly sentListeners = new Set<
    (event: { conversationId: string; deliveryId: string }) => void
  >();

  onDeliverySent(
    listener: (event: { conversationId: string; deliveryId: string }) => void
  ): () => void {
    this.sentListeners.add(listener);
    return () => this.sentListeners.delete(listener);
  }
  private readonly discardListeners = new Set<
    (scope: { chatId?: string; botId?: string; conversationId?: string }) => void
  >();

  onDiscard(
    listener: (scope: { chatId?: string; botId?: string; conversationId?: string }) => void
  ): () => void {
    this.discardListeners.add(listener);
    return () => this.discardListeners.delete(listener);
  }

  constructor(private readonly deps: BotSessionHostDeps) {
    this.maxRunning = deps.maxRunningTurns ?? BOT_MAX_RUNNING_TURNS;
    this.settleGraceMs = deps.settleGraceMs ?? 2000;
  }

  onTurnFinished(listener: (event: BotTurnFinished) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isBotConversation(conversationId: string): boolean {
    return this.binding(conversationId) !== null;
  }

  runningCount(): number {
    return new Set([...this.slots.keys(), ...this.running]).size;
  }

  isBusy(conversationId: string): boolean {
    return (
      this.turnActive(conversationId) ||
      this.queue.some((item) => item.conversationId === conversationId)
    );
  }

  activeDeliveryId(conversationId: string): string | undefined {
    return this.turnActive(conversationId) ? this.activeDeliveries.get(conversationId) : undefined;
  }

  /** 由本宿主发起、尚未结束的轮次的键 */
  turnKey(conversationId: string): string | undefined {
    return this.slots.has(conversationId) ? this.turnKeys.get(conversationId) : undefined;
  }

  registerDelegation(conversationId: string, bot: BotProfile): boolean {
    const conversation = this.deps.authority.conversation(conversationId);
    const project = conversation && this.deps.authority.project(conversation.projectId);
    if (
      !conversation?.bot?.delegationId ||
      !project ||
      project.state !== 'active' ||
      project.kind === 'ssh'
    )
      return false;
    this.independentSpecs.set(conversationId, {
      conversationId,
      projectId: project.projectId,
      cwd: project.canonicalPath,
      bot,
      ...(conversation.sessionFile ? { resumeFile: conversation.sessionFile } : {}),
      systemPrompt: buildBotSystemPrompt(bot, this.deps.bots.readPersona(bot.id)),
      instructionText: buildBotModeInstruction({
        self: bot,
        kind: 'direct',
        roster: this.deps.bots.list(),
      }),
    });
    return true;
  }

  effectiveBot(conversationId: string): BotProfile | undefined {
    return (
      (this.live.has(conversationId) ? this.liveProfiles.get(conversationId) : undefined) ??
      this.independentSpecs.get(conversationId)?.bot ??
      this.deps.bots.get(this.binding(conversationId)?.botId ?? '')
    );
  }

  async abortConversation(conversationId: string): Promise<void> {
    this.cancelQueued((item) => item.conversationId === conversationId);
    this.deps.runtime.abort?.(conversationId);
    await this.withLock(conversationId, async () => {
      this.cancelActive(conversationId);
      await this.deps.runtime.release(conversationId);
      this.live.delete(conversationId);
      this.running.delete(conversationId);
      this.slots.delete(conversationId);
    });
    this.pump();
  }

  queueState(): BotQueueItem[] {
    return this.queue.map((item, position) => ({
      chatId: item.chatId,
      botId: item.botId,
      conversationId: item.conversationId,
      position,
    }));
  }

  async stopTurn(chatId: string, botId: string): Promise<void> {
    const id = this.deps.chats.get(chatId)?.sessions[botId]?.conversationId;
    if (!id) return;
    await this.stopConversation(id, 'canceled');
    this.deps.emit({ kind: 'queue', chatId });
    this.pump();
  }

  /** 中止会话当前回合并清掉它的排队投递，回合以 reason 结算 */
  private async stopConversation(id: string, reason: string): Promise<void> {
    this.cancelQueued((item) => item.conversationId === id, reason);
    await this.withLock(id, async () => {
      this.deps.runtime.abort?.(id);
      this.cancelActive(id, reason);
      // 等旧 generation 结束再允许后续发送，避免迟到的完成事件污染新一轮。
      await this.deps.runtime.release(id);
      this.live.delete(id);
      this.running.delete(id);
      this.slots.delete(id);
      this.lastAssistant.delete(id);
    });
  }

  private async overBudget(botId: string, chatId: string | null): Promise<boolean> {
    if (!this.deps.budget) return false;
    const verdict = await this.deps.budget.exceeded(botId).catch((error) => {
      console.warn('[bots] budget check failed', error);
      return null;
    });
    if (verdict) this.deps.emit({ kind: 'budget', ...(chatId ? { chatId } : {}) });
    return verdict !== null;
  }

  /** 一条 assistant 消息结束且带用量：超额则停掉该成员这一回合 */
  private async enforceBudget(id: string): Promise<void> {
    const binding = this.binding(id);
    if (!binding || this.budgetChecks.has(id)) return;
    this.budgetChecks.add(id);
    try {
      if (!(await this.overBudget(binding.botId, binding.chatId)) || !this.turnActive(id)) return;
      await this.stopConversation(id, BOT_BUDGET_ERROR);
      if (binding.chatId) this.deps.emit({ kind: 'queue', chatId: binding.chatId });
      this.pump();
    } finally {
      this.budgetChecks.delete(id);
    }
  }

  sessionsOf(chatId: string): BotSessionRecord[] {
    const chat = this.deps.chats.get(chatId);
    const current = new Set(Object.values(chat?.sessions ?? {}).map((s) => s.conversationId));
    return this.deps.authority
      .botConversations()
      .filter((conversation) => conversation.bot?.chatId === chatId)
      .map((conversation) => ({
        conversationId: conversation.conversationId,
        botId: conversation.bot!.botId,
        lifecycle: conversation.lifecycle,
        current: current.has(conversation.conversationId),
      }));
  }

  /** 聊天工作区在本机的目录；direct 的 member-home 取唯一成员 home */
  workspacePath(chatId: string): string | undefined {
    const chat = this.deps.chats.get(chatId);
    if (!chat) return undefined;
    const workspace = this.resolveWorkspace(chat, chat.members[0]);
    return workspace.ok ? workspace.cwd : undefined;
  }

  ensureSession(
    chatId: string,
    botId: string,
    options: { fresh?: boolean } = {}
  ): { ok: true; conversationId: string } | Fail {
    const chat = this.deps.chats.get(chatId);
    if (!chat) return { ok: false, error: 'chat-not-found' };
    if (!chat.members.includes(botId)) return { ok: false, error: 'not-member' };
    const bot = this.deps.bots.get(botId);
    if (!bot) return { ok: false, error: 'bot-not-found' };
    if (bot.archivedAt !== undefined) return { ok: false, error: 'bot-archived' };
    const workspace = this.resolveWorkspace(chat, botId);
    if (!workspace.ok) return workspace;
    const current = chat.sessions[botId];
    const existing = current && this.deps.authority.conversation(current.conversationId);
    if (
      !options.fresh &&
      existing &&
      existing.lifecycle !== 'ended' &&
      existing.projectId === workspace.projectId &&
      existing.bot?.botId === botId &&
      existing.bot.chatId === chatId
    ) {
      return { ok: true, conversationId: existing.conversationId };
    }
    if (current) this.retireSession(current.conversationId);
    const binding = { botId, chatId };
    const created = this.deps.authority.createBotConversation(workspace.projectId, binding);
    if (!created) return { ok: false, error: 'authority-unavailable' };
    this.bindings.set(created.conversationId, binding);
    const cursor = this.deps.chats.lastSeq(chatId);
    const updated = this.deps.chats.update(chatId, (draft) => {
      draft.sessions[botId] = { conversationId: created.conversationId, cursor };
      return draft;
    });
    if (!updated) {
      this.deps.authority.removeBotConversation(created.conversationId);
      return { ok: false, error: 'chat-update-failed' };
    }
    this.deps.emit({ kind: 'chat', chatId });
    return { ok: true, conversationId: created.conversationId };
  }

  /** 返回 ok 前确认命令已交给 worker；排队时 queued=true，之后失败经 onTurnFinished 回报 */
  async deliver(
    chatId: string,
    botId: string,
    text: string,
    options: BotDeliverOptions = {}
  ): Promise<BotDeliverResult> {
    if (this.disposed) return { ok: false, error: 'disabled' };
    const session = this.ensureSession(chatId, botId);
    if (!session.ok) return session;
    const { conversationId } = session;
    return this.deliverConversation(conversationId, text, options);
  }

  async deliverConversation(
    conversationId: string,
    text: string,
    options: BotDeliverOptions = {}
  ): Promise<BotDeliverResult> {
    if (this.disposed) return { ok: false, error: 'disabled' };
    const binding = this.binding(conversationId);
    if (!binding) return { ok: false, error: 'not-bot-session' };
    const { botId } = binding;
    const chatId = binding.chatId ?? '';
    const delivery: Delivery = { ...options, chatId, botId, conversationId, text };
    return this.withLock(conversationId, async (): Promise<BotDeliverResult> => {
      if (this.disposed) return { ok: false, error: 'disabled' };
      if (options.deliveryId) {
        if (this.hasStartedDelivery(conversationId, options.deliveryId))
          return { ok: true, conversationId, duplicate: true };
        if (
          this.deliveries.get(conversationId)?.has(options.deliveryId) ||
          this.queue.some(
            (item) =>
              item.conversationId === conversationId && item.deliveryId === options.deliveryId
          )
        )
          return { ok: true, conversationId, queued: true };
      }
      if (
        options.onlyIfIdle &&
        (this.isBusy(conversationId) || this.runningCount() >= this.maxRunning)
      )
        return { ok: false, error: 'session-busy' };
      if (await this.overBudget(botId, binding.chatId))
        return { ok: false, error: BOT_BUDGET_ERROR };
      if (this.turnActive(conversationId) && !options.queueIfBusy) return this.steer(delivery);
      if (
        this.turnActive(conversationId) ||
        this.queue.some((item) => item.conversationId === conversationId) ||
        this.runningCount() >= this.maxRunning
      ) {
        this.queue.push(delivery);
        this.deps.emit({ kind: 'queue', chatId });
        return { ok: true, conversationId, queued: true };
      }
      const started = await this.start(delivery);
      if (!started.ok) this.pump();
      return started;
    });
  }

  /** 工作区变更 / 成员移出：结束旧会话（只读保留），下次投递开新会话 */
  resetSessions(chatId: string, botIds?: readonly string[]): void {
    const chat = this.deps.chats.get(chatId);
    if (!chat) return;
    const targets = Object.keys(chat.sessions).filter((id) => !botIds || botIds.includes(id));
    if (targets.length === 0) return;
    for (const botId of targets) this.retireSession(chat.sessions[botId].conversationId);
    this.deps.chats.update(chatId, (draft) => {
      for (const botId of targets) delete draft.sessions[botId];
      return draft;
    });
    this.deps.emit({ kind: 'chat', chatId });
  }

  /** 删除聊天：会话记录、会话文件、独立工作区与聊天目录一并清理 */
  discardChat(chatId: string): boolean {
    const chat = this.deps.chats.get(chatId);
    if (!chat) return false;
    for (const listener of this.discardListeners) listener({ chatId });
    for (const conversation of this.deps.authority.botConversations()) {
      if (conversation.bot?.chatId === chatId) this.discardConversation(conversation);
    }
    // 改选过工作区的群也可能留有独立目录项目，按路径找
    const home = this.deps.authority.botHomeProject(this.deps.chats.workspaceDir(chatId));
    if (home) this.deps.authority.removeBotHomeProject(home.projectId);
    this.deps.chats.remove(chatId);
    this.deps.emit({ kind: 'chat', chatId });
    return true;
  }

  /** 彻底删除成员：群主须先换人；私聊、委派会话、成员 home 一并删除，群里的发言保留 */
  discardBot(botId: string): { ok: true } | { ok: false; reason: string; chatIds?: string[] } {
    if (!this.deps.bots.get(botId)) return { ok: false, reason: 'not-found' };
    const chats = this.deps.chats.list();
    const bossOf = chats.filter((chat) => chat.bossBotId === botId).map((chat) => chat.id);
    if (bossOf.length > 0) return { ok: false, reason: 'boss', chatIds: bossOf };
    for (const listener of this.discardListeners) listener({ botId });
    for (const chat of chats) {
      if (chat.kind === 'direct' && chat.members.includes(botId)) this.discardChat(chat.id);
      else if (chat.sessions[botId]) this.resetSessions(chat.id, [botId]);
    }
    for (const conversation of this.deps.authority.botConversations()) {
      if (conversation.bot?.botId === botId && conversation.bot.chatId === null) {
        this.discardConversation(conversation);
      }
    }
    const home = this.deps.authority.botHomeProject(this.deps.bots.homeDir(botId));
    if (home) this.deps.authority.removeBotHomeProject(home.projectId);
    this.deps.bots.remove(botId);
    this.deps.emit({ kind: 'catalog' });
    return { ok: true };
  }

  observe(event: AgentWorkerEvent | { type: 'worker-exited' }): void {
    if (this.disposed) return;
    if (event.type === 'worker-exited') {
      const interrupted = [...this.slots.keys()];
      for (const id of [...this.settleTimers.keys()]) this.cancelSettle(id);
      this.live.clear();
      this.running.clear();
      this.slots.clear();
      this.lastAssistant.clear();
      this.waiting.clear();
      for (const id of [...this.lastOutput.keys()]) this.quiet(id);
      for (const id of interrupted) this.finish(id, undefined, false, 'worker-exited');
      this.pump();
      return;
    }
    if (!('identity' in event) || !event.identity) return;
    this.noteOutput(event);
    if ('parent' in event.identity) return;
    const id = event.identity.sessionId;
    if (!this.isBotConversation(id)) return;
    switch (event.type) {
      case 'status': {
        const slot = this.slots.get(id);
        if (event.status === 'running') {
          this.cancelSettle(id);
          if (!this.running.has(id) && !slot?.sawRunning) this.lastAssistant.delete(id);
          this.running.add(id);
          if (slot) slot.sawRunning = true;
          this.deliveryStarted(id);
          return;
        }
        this.running.delete(id);
        // idle 先于 turn-completed 到达，正常由后者结算；中断等路径只有 idle/failed，到期兜底
        if (slot && (slot.sawRunning || event.status === 'failed'))
          this.scheduleSettle(id, slot, event.status === 'failed' ? event.error : undefined);
        else if (!slot) this.pump();
        return;
      }
      case 'message-upsert': {
        if (event.message.role !== 'assistant') return;
        const previous = this.lastAssistant.get(id);
        if (previous && event.index < previous.index) return;
        const text = event.message.content
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('');
        this.lastAssistant.set(id, {
          index: event.index,
          text,
          ...(event.message.stopReason ? { stopReason: event.message.stopReason } : {}),
          ...(event.message.errorMessage ? { errorMessage: event.message.errorMessage } : {}),
        });
        if (
          this.deps.budget &&
          event.message.usage &&
          event.message.stopReason &&
          this.turnActive(id)
        )
          void this.enforceBudget(id);
        return;
      }
      case 'turn-completed': {
        if (!this.turnActive(id)) return;
        this.deliveryStarted(id);
        const last = this.lastAssistant.get(id);
        const failed = last?.stopReason === 'error' || last?.stopReason === 'aborted';
        this.running.delete(id);
        this.finish(
          id,
          event.turnId,
          !failed,
          failed ? (last?.errorMessage ?? last?.stopReason) : undefined,
          last?.text ?? event.digest?.assistantText ?? ''
        );
        this.lastAssistant.delete(id);
        this.release(id);
        return;
      }
      case 'turn-failed':
        if (!this.turnActive(id)) return;
        this.running.delete(id);
        this.finish(id, event.turnId, false, event.error, this.lastAssistant.get(id)?.text ?? '');
        this.lastAssistant.delete(id);
        this.release(id);
        return;
      case 'parent-ended':
      case 'parent-rejected': {
        const hadSlot = this.slots.has(id);
        this.live.delete(id);
        this.running.delete(id);
        this.lastAssistant.delete(id);
        if (hadSlot) {
          this.finish(id, undefined, false, event.reason);
          this.release(id);
        }
        return;
      }
      default:
        return;
    }
  }

  private binding(conversationId: string): ConversationBotBinding | null {
    const cached = this.bindings.get(conversationId);
    if (cached !== undefined) return cached;
    const binding = this.deps.authority.conversation(conversationId)?.bot ?? null;
    if (binding) this.bindings.set(conversationId, binding);
    return binding;
  }

  private turnActive(conversationId: string): boolean {
    return this.slots.has(conversationId) || this.running.has(conversationId);
  }

  /** 当前处于静默的运行中轮次 */
  silences(): BotSilence[] {
    return [...this.silent].flatMap(([conversationId, since]) => {
      const binding = this.binding(conversationId);
      return binding
        ? [
            {
              conversationId,
              chatId: binding.chatId,
              botId: binding.botId,
              ...(binding.delegationId ? { delegationId: binding.delegationId } : {}),
              since,
            },
          ]
        : [];
    });
  }

  /** 看门狗巡检：由定时器驱动，测试可直接调用 */
  checkSilence(): void {
    const now = this.now();
    const limit = this.deps.silenceMs ?? BOT_SILENCE_MS;
    for (const [id, at] of this.lastOutput) {
      if (!this.turnActive(id)) this.quiet(id);
      else if (!this.waiting.get(id)?.size && !this.silent.has(id) && now - at >= limit) {
        this.silent.set(id, at);
        this.emitSilence(id);
      }
    }
    if (this.lastOutput.size === 0) this.stopWatchdog();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** 任何流式事件、工具进度或子代理事件都算本会话的输出 */
  private noteOutput(event: AgentWorkerEvent): void {
    if (!('identity' in event) || !event.identity) return;
    const identity = event.identity;
    const raw = 'parent' in identity ? identity.parent.sessionId : identity.sessionId;
    const sep = raw.indexOf('::');
    const id = sep === -1 ? raw : raw.slice(0, sep);
    if (!this.turnActive(id)) return;
    if (event.type === 'approval-request' || event.type === 'ask-request') {
      const requestId =
        event.type === 'approval-request' ? event.request.requestId : event.ask.requestId;
      const set = this.waiting.get(id) ?? new Set();
      set.add(requestId);
      this.waiting.set(id, set);
    } else if (event.type === 'approval-resolved' || event.type === 'ask-resolved') {
      this.waiting.get(id)?.delete(event.requestId);
    }
    this.touch(id);
  }

  private touch(id: string): void {
    this.lastOutput.set(id, this.now());
    if (this.silent.delete(id)) this.emitSilence(id);
    if (!this.watchdog && !this.disposed) {
      const limit = this.deps.silenceMs ?? BOT_SILENCE_MS;
      this.watchdog = setInterval(() => this.checkSilence(), Math.min(5_000, limit / 6));
      this.watchdog.unref?.();
    }
  }

  /** 轮次结束：不再巡检，已静默的撤销 */
  private quiet(id: string): void {
    this.lastOutput.delete(id);
    this.waiting.delete(id);
    if (this.silent.delete(id)) this.emitSilence(id);
  }

  private emitSilence(id: string): void {
    const chatId = this.binding(id)?.chatId;
    this.deps.emit({ kind: 'silence', ...(chatId ? { chatId } : {}), conversationId: id });
  }

  private stopWatchdog(): void {
    clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  private notesFor(conversationId: string, botId: string): BotNotesSnapshot | undefined {
    if (!this.deps.notes) return undefined;
    const chatId = this.deps.authority.conversation(conversationId)?.bot?.chatId;
    const chat = chatId ? this.deps.chats.get(chatId) : undefined;
    return this.deps.notes.snapshot(botId, chat?.kind === 'group' ? chat.id : null);
  }

  /** 运行中会话的笔记变了：在本次投递前追加一次 <notes-updated> */
  private withNotesUpdate(delivery: Delivery): { text: string; seen?: string } {
    const snap = this.notesFor(delivery.conversationId, delivery.botId);
    if (!snap || snap.version === (this.notesSeen.get(delivery.conversationId) ?? ''))
      return { text: delivery.text };
    return {
      text: snap.update ? `${snap.update}\n\n${delivery.text}` : delivery.text,
      seen: snap.version,
    };
  }

  private steer(delivery: Delivery): BotDeliverResult {
    const notes = this.withNotesUpdate(delivery);
    const sent = this.deps.runtime.steer(
      delivery.conversationId,
      notes.text,
      delivery.images,
      delivery.deliveryId
    );
    if (sent.ok && notes.seen !== undefined)
      this.notesSeen.set(delivery.conversationId, notes.seen);
    if (sent.ok) this.deliverySent(delivery);
    return sent.ok
      ? { ok: true, conversationId: delivery.conversationId }
      : { ok: false, error: sent.error ?? 'steer-failed' };
  }

  private async start(delivery: Delivery): Promise<BotDeliverResult> {
    if (this.disposed) return { ok: false, error: 'disabled' };
    const { conversationId } = delivery;
    const conversation = this.deps.authority.conversation(conversationId);
    const bot = this.deps.bots.get(delivery.botId);
    const chat = conversation?.bot?.chatId
      ? this.deps.chats.get(conversation.bot.chatId)
      : undefined;
    if (
      !conversation ||
      conversation.lifecycle === 'ended' ||
      !bot ||
      bot.archivedAt !== undefined ||
      this.deps.authority.project(conversation.projectId)?.state !== 'active' ||
      (conversation.bot?.chatId &&
        (!chat || chat.archivedAt !== undefined || !chat.members.includes(bot.id)))
    )
      return { ok: false, error: 'session-unavailable' };
    this.slots.set(conversationId, { sawRunning: false });
    this.turnKeys.set(conversationId, randomUUID());
    this.lastAssistant.delete(conversationId);
    this.touch(conversationId);
    if (delivery.deliveryId) this.activeDeliveries.set(conversationId, delivery.deliveryId);
    else this.activeDeliveries.delete(conversationId);
    const fail = (error: string): Fail => {
      this.slots.delete(conversationId);
      this.quiet(conversationId);
      return { ok: false, error };
    };
    let notes: { text: string; seen?: string } = { text: delivery.text };
    if (!this.live.has(conversationId)) {
      const spec = this.spawnSpec(delivery);
      if (!spec.ok) return fail(spec.error);
      const snap = this.notesFor(conversationId, bot.id);
      if (snap?.section)
        spec.spec = {
          ...spec.spec,
          systemPrompt: `${spec.spec.systemPrompt}\n\n${snap.section}`,
        };
      const spawned = await this.deps.runtime.spawn(spec.spec);
      if (!spawned.ok) return fail(spawned.error ?? 'spawn-failed');
      if (
        this.disposed ||
        this.deps.authority.conversation(conversationId)?.lifecycle === 'ended'
      ) {
        await this.deps.runtime.release(conversationId);
        return fail(this.disposed ? 'disabled' : 'canceled');
      }
      this.liveProfiles.set(conversationId, spec.spec.bot);
      this.live.add(conversationId);
      this.notesSeen.set(conversationId, snap?.version ?? '');
    } else notes = this.withNotesUpdate(delivery);
    const sent = this.deps.runtime.prompt(
      conversationId,
      notes.text,
      delivery.images,
      delivery.deliveryId
    );
    if (!sent.ok) return fail(sent.error ?? 'prompt-failed');
    if (notes.seen !== undefined) this.notesSeen.set(conversationId, notes.seen);
    this.deliverySent(delivery);
    return { ok: true, conversationId };
  }

  private deliverySent(delivery: Delivery): void {
    if (!delivery.deliveryId) return;
    this.rememberDelivery(delivery.conversationId, delivery.deliveryId, 'sent');
    for (const listener of this.sentListeners)
      listener({ conversationId: delivery.conversationId, deliveryId: delivery.deliveryId });
  }

  private rememberDelivery(
    conversationId: string,
    deliveryId: string,
    state: 'sent' | 'started'
  ): void {
    const records = this.deliveries.get(conversationId) ?? new Map();
    if (records.get(deliveryId) !== 'started') records.set(deliveryId, state);
    this.deliveries.set(conversationId, records);
  }

  private deliveryStarted(conversationId: string): void {
    const deliveryId = this.activeDeliveries.get(conversationId);
    if (!deliveryId || this.deliveries.get(conversationId)?.get(deliveryId) === 'started') return;
    this.rememberDelivery(conversationId, deliveryId, 'started');
    for (const listener of this.startedListeners) listener({ conversationId, deliveryId });
  }

  private spawnSpec(delivery: Delivery): { ok: true; spec: BotSpawnSpec } | Fail {
    const independent = this.independentSpecs.get(delivery.conversationId);
    if (independent) return { ok: true, spec: independent };
    const chat = this.deps.chats.get(delivery.chatId);
    const bot = this.deps.bots.get(delivery.botId);
    const conversation = this.deps.authority.conversation(delivery.conversationId);
    if (!chat || !bot || !conversation || conversation.lifecycle === 'ended') {
      return { ok: false, error: 'session-unavailable' };
    }
    const workspace = this.resolveWorkspace(chat, bot.id);
    if (!workspace.ok) return workspace;
    if (workspace.projectId !== conversation.projectId) {
      return { ok: false, error: 'workspace-changed' };
    }
    const roster = chat.members
      .map((id) => this.deps.bots.get(id))
      .filter((member): member is BotProfile => member !== undefined);
    return {
      ok: true,
      spec: {
        conversationId: conversation.conversationId,
        projectId: conversation.projectId,
        cwd: workspace.cwd,
        ...(conversation.sessionFile ? { resumeFile: conversation.sessionFile } : {}),
        bot,
        systemPrompt: buildBotSystemPrompt(bot, this.deps.bots.readPersona(bot.id)),
        instructionText: buildBotModeInstruction({ self: bot, kind: chat.kind, roster }),
        ...(chat.kind === 'group' ? { groupTasks: true } : {}),
        routines: true,
      },
    };
  }

  private release(conversationId: string): void {
    this.cancelSettle(conversationId);
    this.turnKeys.delete(conversationId);
    this.quiet(conversationId);
    if (!this.slots.delete(conversationId)) return;
    this.pump();
  }

  private scheduleSettle(id: string, slot: { sawRunning: boolean }, error?: string): void {
    this.cancelSettle(id);
    const timer = setTimeout(() => {
      this.settleTimers.delete(id);
      if (this.disposed || this.slots.get(id) !== slot || this.running.has(id)) return;
      this.finish(id, undefined, false, error ?? 'interrupted', this.lastAssistant.get(id)?.text);
      this.lastAssistant.delete(id);
      this.release(id);
    }, this.settleGraceMs);
    timer.unref?.();
    this.settleTimers.set(id, timer);
  }

  private cancelSettle(id: string): void {
    clearTimeout(this.settleTimers.get(id));
    this.settleTimers.delete(id);
  }

  private pump(): void {
    if (this.disposed) return;
    const touched = new Set<string>();
    while (this.queue.length > 0) {
      const index = this.queue.findIndex(
        (item) => !item.queueIfBusy || !this.turnActive(item.conversationId)
      );
      if (index < 0) break;
      const next = this.queue[index];
      const active = this.turnActive(next.conversationId);
      if (!active && this.runningCount() >= this.maxRunning) break;
      this.queue.splice(index, 1);
      touched.add(next.chatId);
      if (active) {
        // 走同一把锁：同会话前一条可能还在 spawn
        void this.withLock(next.conversationId, async () => {
          const steered = this.steer(next);
          if (!steered.ok)
            this.finish(
              next.conversationId,
              undefined,
              false,
              steered.error,
              '',
              next.deliveryId ?? null
            );
        });
        continue;
      }
      this.slots.set(next.conversationId, { sawRunning: false });
      if (next.deliveryId) this.activeDeliveries.set(next.conversationId, next.deliveryId);
      void this.withLock(next.conversationId, async () => {
        this.slots.delete(next.conversationId);
        const started: BotDeliverResult = (await this.overBudget(next.botId, next.chatId || null))
          ? { ok: false, error: BOT_BUDGET_ERROR }
          : await this.start(next);
        if (!started.ok) {
          this.finish(
            next.conversationId,
            undefined,
            false,
            started.error,
            '',
            next.deliveryId ?? null
          );
          this.pump();
        }
      });
    }
    for (const chatId of touched) this.deps.emit({ kind: 'queue', chatId });
  }

  private finish(
    conversationId: string,
    turnId: string | undefined,
    ok: boolean,
    error?: string,
    text = '',
    deliveryId: string | null | undefined = this.activeDeliveries.get(conversationId)
  ): void {
    const binding = this.binding(conversationId);
    if (!binding) return;
    const turnKey = this.turnKeys.get(conversationId);
    const event: BotTurnFinished = {
      ...(deliveryId ? { deliveryId } : {}),
      chatId: binding.chatId,
      botId: binding.botId,
      conversationId,
      ...(turnId ? { turnId } : {}),
      text,
      ok,
      ...(error ? { error } : {}),
      ...(binding.delegationId ? { delegationId: binding.delegationId } : {}),
      ...(turnKey ? { turnKey } : {}),
    };
    if (deliveryId === this.activeDeliveries.get(conversationId))
      this.activeDeliveries.delete(conversationId);
    if (deliveryId && this.deliveries.get(conversationId)?.get(deliveryId) !== 'started')
      this.deliveries.get(conversationId)?.delete(deliveryId);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (cause) {
        console.warn('[bots] turn listener failed', cause);
      }
    }
  }

  /** 结束会话（只读保留）并释放 worker 里的实例；丢弃它的排队投递 */
  retireSession(conversationId: string): void {
    this.cancelQueued((item) => item.conversationId === conversationId);
    this.cancelActive(conversationId);
    if (this.live.has(conversationId) || this.slots.has(conversationId)) {
      void this.deps.runtime.release(conversationId).catch(() => {});
    }
    this.live.delete(conversationId);
    this.clearSession(conversationId);
    this.deps.authority.endBotConversation(conversationId);
    this.pump();
  }

  freeze(): void {
    this.disposed = true;
    this.stopWatchdog();
  }

  dispose(): void {
    this.freeze();
    this.cancelQueued(() => true);
    for (const id of new Set([...this.live, ...this.slots.keys()])) {
      this.cancelActive(id);
      this.deps.runtime.abort?.(id);
      void this.deps.runtime.release(id).catch(console.warn);
      this.clearSession(id);
    }
    this.live.clear();
    this.bindings.clear();
    this.independentSpecs.clear();
    this.liveProfiles.clear();
    this.listeners.clear();
    this.discardListeners.clear();
    this.sentListeners.clear();
    this.startedListeners.clear();
    this.deliveries.clear();
  }

  private cancelQueued(predicate: (item: Delivery) => boolean, reason = 'canceled'): void {
    const canceled = this.queue.filter(predicate);
    this.queue = this.queue.filter((item) => !predicate(item));
    for (const item of canceled) {
      this.finish(item.conversationId, undefined, false, reason, '', item.deliveryId ?? null);
      this.deps.emit({ kind: 'queue', chatId: item.chatId });
    }
  }

  private cancelActive(id: string, reason = 'canceled'): void {
    this.cancelSettle(id);
    if (this.turnActive(id)) this.finish(id, undefined, false, reason);
    this.running.delete(id);
    this.slots.delete(id);
    this.lastAssistant.delete(id);
    this.quiet(id);
  }

  private clearSession(id: string): void {
    this.cancelSettle(id);
    this.running.delete(id);
    this.slots.delete(id);
    this.lastAssistant.delete(id);
    this.quiet(id);
    this.activeDeliveries.delete(id);
    this.bindings.delete(id);
    this.independentSpecs.delete(id);
    this.liveProfiles.delete(id);
    this.deliveries.delete(id);
  }

  private discardConversation(conversation: ConversationAuthority): void {
    for (const listener of this.discardListeners)
      listener({ conversationId: conversation.conversationId });
    this.retireSession(conversation.conversationId);
    const removed = this.deps.authority.removeBotConversation(conversation.conversationId);
    if (removed) this.deps.runtime.removeSessionFiles(removed);
    if (removed?.sessionFile) this.persistedStarts.forget(removed.sessionFile);
  }

  private resolveWorkspace(chat: BotChat, botId: string | undefined): Workspace {
    const { authority } = this.deps;
    switch (chat.workspace.kind) {
      case 'member-home': {
        if (!botId) return { ok: false, error: 'workspace-unavailable' };
        const project = authority.ensureBotHomeProject(this.deps.bots.homeDir(botId));
        return project
          ? { ok: true, cwd: project.canonicalPath, projectId: project.projectId }
          : { ok: false, error: 'workspace-unavailable' };
      }
      case 'chat-home': {
        const project = authority.ensureBotHomeProject(this.deps.chats.workspaceDir(chat.id));
        if (!project) return { ok: false, error: 'workspace-unavailable' };
        if (project.projectId !== chat.workspace.projectId) {
          this.deps.chats.update(chat.id, (draft) => {
            draft.workspace = { kind: 'chat-home', projectId: project.projectId };
            return draft;
          });
        }
        return { ok: true, cwd: project.canonicalPath, projectId: project.projectId };
      }
      case 'project': {
        const project = authority.project(chat.workspace.projectId);
        if (project?.state !== 'active') return { ok: false, error: 'workspace-unavailable' };
        if (project.kind === 'ssh' || project.kind === 'bot-home') {
          return { ok: false, error: 'workspace-unsupported' };
        }
        return { ok: true, cwd: project.canonicalPath, projectId: project.projectId };
      }
    }
  }

  private async withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.catch(() => {});
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return run;
  }
}
