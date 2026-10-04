import { readFileSync } from 'node:fs';
import type {
  AgentWorkerEvent,
  AttachedImage,
  ConversationAuthority,
  ConversationBotBinding,
  ProjectAuthority,
} from '../../../shared/types/agent';
import type { BotChat, BotProfile } from '../../../shared/types/bot';
import type { BotEvent, BotQueueItem, BotSessionRecord } from '../../../shared/types/botIpc';
import { buildBotModeInstruction, buildBotSystemPrompt } from './botPrompt';
import type { BotStore } from './botStore';
import type { BotChatStore } from './chatStore';

/** bot 会话同时在跑的轮次上限（私聊、群聊、委派、例行合计，Code 会话不计） */
export const BOT_MAX_RUNNING_TURNS = 4;

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
}

export interface BotDeliverOptions {
  images?: AttachedImage[];
  deliveryId?: string;
  queueIfBusy?: boolean;
  onlyIfIdle?: boolean;
}

export type BotDeliverResult =
  | { ok: true; conversationId: string; queued?: boolean; turnId?: string }
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
  private readonly independentSpecs = new Map<string, BotSpawnSpec>();
  private readonly liveProfiles = new Map<string, BotProfile>();
  private readonly activeDeliveries = new Map<string, string>();
  private disposed = false;
  private readonly deliveries = new Map<string, Map<string, 'sent' | 'started'>>();
  private readonly startedListeners = new Set<
    (event: { conversationId: string; deliveryId: string }) => void
  >();

  onDeliveryStarted(
    listener: (event: { conversationId: string; deliveryId: string }) => void
  ): () => void {
    this.startedListeners.add(listener);
    return () => this.startedListeners.delete(listener);
  }

  hasStartedDelivery(conversationId: string, deliveryId: string): boolean {
    if (this.deliveries.get(conversationId)?.get(deliveryId) === 'started') return true;
    const file = this.deps.authority.conversation(conversationId)?.sessionFile;
    if (!file) return false;
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        try {
          const entry = JSON.parse(line);
          if (entry?.type !== 'message' || entry.message?.role !== 'user') continue;
          const content = entry.message.content;
          const texts =
            typeof content === 'string'
              ? [content]
              : Array.isArray(content)
                ? content.flatMap((part: { type?: string; text?: unknown }) =>
                    part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []
                  )
                : [];
          if (
            texts.some((text: string) =>
              text.trimStart().startsWith(`<delegation-result id="${deliveryId}"`)
            )
          ) {
            this.rememberDelivery(conversationId, deliveryId, 'started');
            return true;
          }
        } catch {
          /* torn line */
        }
      }
    } catch {
      /* no persisted session yet */
    }
    return false;
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
    this.cancelQueued((item) => item.conversationId === id);
    await this.withLock(id, async () => {
      this.deps.runtime.abort?.(id);
      this.cancelActive(id);
      // 等旧 generation 结束再允许后续发送，避免迟到的完成事件污染新一轮。
      await this.deps.runtime.release(id);
      this.live.delete(id);
      this.running.delete(id);
      this.slots.delete(id);
      this.lastAssistant.delete(id);
    });
    this.deps.emit({ kind: 'queue', chatId });
    this.pump();
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
          return { ok: true, conversationId };
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
      this.live.clear();
      this.running.clear();
      this.slots.clear();
      this.lastAssistant.clear();
      for (const id of interrupted) this.finish(id, undefined, false, 'worker-exited');
      this.pump();
      return;
    }
    if (!('identity' in event) || !event.identity || 'parent' in event.identity) return;
    const id = event.identity.sessionId;
    if (!this.isBotConversation(id)) return;
    switch (event.type) {
      case 'status': {
        const slot = this.slots.get(id);
        if (event.status === 'running') {
          if (!this.running.has(id) && !slot?.sawRunning) this.lastAssistant.delete(id);
          this.running.add(id);
          if (slot) slot.sawRunning = true;
          this.deliveryStarted(id);
          return;
        }
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

  private steer(delivery: Delivery): BotDeliverResult {
    const sent = this.deps.runtime.steer(
      delivery.conversationId,
      delivery.text,
      delivery.images,
      delivery.deliveryId
    );
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
    this.lastAssistant.delete(conversationId);
    if (delivery.deliveryId) this.activeDeliveries.set(conversationId, delivery.deliveryId);
    else this.activeDeliveries.delete(conversationId);
    const fail = (error: string): Fail => {
      this.slots.delete(conversationId);
      return { ok: false, error };
    };
    if (!this.live.has(conversationId)) {
      const spec = this.spawnSpec(delivery);
      if (!spec.ok) return fail(spec.error);
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
    }
    const sent = this.deps.runtime.prompt(
      conversationId,
      delivery.text,
      delivery.images,
      delivery.deliveryId
    );
    if (!sent.ok) return fail(sent.error ?? 'prompt-failed');
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
      },
    };
  }

  private release(conversationId: string): void {
    if (!this.slots.delete(conversationId)) return;
    this.pump();
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
        const started = await this.start(next);
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

  private cancelQueued(predicate: (item: Delivery) => boolean): void {
    const canceled = this.queue.filter(predicate);
    this.queue = this.queue.filter((item) => !predicate(item));
    for (const item of canceled) {
      this.finish(item.conversationId, undefined, false, 'canceled', '', item.deliveryId ?? null);
      this.deps.emit({ kind: 'queue', chatId: item.chatId });
    }
  }

  private cancelActive(id: string): void {
    if (this.turnActive(id)) this.finish(id, undefined, false, 'canceled');
    this.running.delete(id);
    this.slots.delete(id);
    this.lastAssistant.delete(id);
  }

  private clearSession(id: string): void {
    this.running.delete(id);
    this.slots.delete(id);
    this.lastAssistant.delete(id);
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
