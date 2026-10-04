import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { SessionIdentity } from '@shared/builtinAgents';
import { BUILTIN_AGENT_TYPES, IPC_CHANNELS } from '@shared/types';
import type { AttachedImage } from '@shared/types/agent';
import {
  type BotChat,
  type BotChatWorkspace,
  GROUP_TASK_TEXT_MAX,
  GROUP_TASK_TITLE_MAX,
  isBotId,
} from '@shared/types/bot';
import type {
  BotAbilitySuggestResult,
  BotActionResult,
  BotChatSessionsResult,
  BotChatsListResult,
  BotChatWriteResult,
  BotEvent,
  BotGetResult,
  BotNewSessionResult,
  BotPersonaSuggestResult,
  BotSendResult,
  BotsListResult,
  BotTimelineResult,
  BotWriteIpcResult,
} from '@shared/types/botIpc';
import { isUsageRangeDays } from '@shared/usage/types';
import { app, ipcMain, shell } from 'electron';
import {
  abortCompleteText,
  abortSession,
  agentTypeRegistrySnapshot,
  classifyChoice,
  completeText,
  isAgentWorkerReady,
  promptSession,
  readSettingsState,
  releaseParentSession,
  resolveModelSelection,
  resolveVirtualClassifier,
  respondApproval,
  spawnSession,
  steerSession,
} from '../services/agentHost';
import {
  type AbilityCompleter,
  suggestAbilities,
  suggestPersona,
} from '../services/bots/abilitySuggester';
import { BotMemoryService } from '../services/bots/botMemory';
import {
  BOT_READONLY_DISABLED_TOOLS,
  mergeBotInstruction,
  pickBotModel,
} from '../services/bots/botPrompt';
import { type BotRuntimePort, BotSessionHost } from '../services/bots/botSessionHost';
import { BotStore } from '../services/bots/botStore';
import { BotUsageService } from '../services/bots/botUsage';
import { BotChatStore } from '../services/bots/chatStore';
import { turnDelegationTargets } from '../services/bots/delegationBatch';
import { DelegationService } from '../services/bots/delegationService';
import { DelegationStore } from '../services/bots/delegationStore';
import { GroupChatService } from '../services/bots/groupChat';
import { parseGroupHistoryQuery, queryGroupHistory } from '../services/bots/groupHistory';
import { GroupTaskStore } from '../services/bots/groupTaskStore';
import { GroupTaskService } from '../services/bots/groupTasks';
import { removeBotMemorySpace } from '../services/bots/memoryCleanup';
import { RoutineRunner } from '../services/bots/routineRunner';
import { RoutineScheduler } from '../services/bots/routineScheduler';
import { BotRoutineStore } from '../services/bots/routineStore';
import { createSmartRouter } from '../services/bots/smartRouter';
import { resolveGlobalInstruction } from '../services/instructionStore';
import { readStoredOauthCredentialKeys } from '../services/oauthProviders';
import { remoteCandidates, resolveRemoteModels } from '../services/remoteModels';
import { removeConversationSessionFiles } from '../services/sessionFileCleanup';
import { botAssistantModelCandidates } from '../services/titleSummary';
import { getUsagePricing, loadUsageSession } from '../services/usage/usageService';
import { sendToAllWindows } from '../windows/createAppWindow';
import { isMainWebContents } from '../windows/MainWindow';
import {
  getSourceAuthorityRegistry,
  readSessionHistoryFile,
  setBotWorkerEventObserver,
} from './agent';
import { listArtifacts, openArtifact, readArtifact, searchChats } from './botsContent';
import {
  type ChatWorkspaceInput,
  parseAbilitySuggestRequest,
  parseBotDraftInput,
  parseBotUpdateInput,
  parseChatCreateInput,
  parseChatUpdateInput,
  parseOpenWorkspaceInput,
  parsePersonaSuggestRequest,
  parseSendInput,
  parseSessionHistoryInput,
  parseTimelineInput,
} from './botsInput';
import { agentSessionIndex } from './capabilities';

interface BotServices {
  bots: BotStore;
  chats: BotChatStore;
  host: BotSessionHost;
  groups: GroupChatService;
  memory: BotMemoryService;
  delegations: DelegationService;
  routines: BotRoutineStore;
  scheduler: RoutineScheduler;
  runner: RoutineRunner;
  tasks: GroupTaskService;
  usage: BotUsageService;
}

type GroupSender = (
  chat: BotChat,
  text: string,
  options: { images?: AttachedImage[]; deliveryId: string }
) => Promise<BotSendResult>;

let services: BotServices | null = null;
let groupSender: GroupSender | null = null;

const DISABLED = { ok: false as const, error: 'disabled' };
const INVALID = { ok: false as const, error: 'invalid' };
const UNAVAILABLE = { ok: false as const, error: 'unavailable' };

/** 群聊模块挂点：未注册时群聊发送返回 group-not-ready */
export function setBotGroupSender(sender: GroupSender | null): void {
  groupSender = sender;
}

export function botModeEnabled(): boolean {
  return readSettingsState()?.botModeEnabled === true;
}

export function emitBotEvent(event: BotEvent): void {
  if (event.kind === 'catalog' || event.kind === 'chat') services?.scheduler.refresh();
  try {
    sendToAllWindows(IPC_CHANNELS.BOT_EVENT, event);
  } catch {
    // renderer 已销毁
  }
  for (const observer of botEventObservers) {
    try {
      observer(event);
    } catch (error) {
      console.warn('[bots] event observer failed', error);
    }
  }
}

const botEventObservers = new Set<(event: BotEvent) => void>();

/** 窗口之外的 Bot 事件订阅方（手机转发） */
export function observeBotEvents(observer: (event: BotEvent) => void): () => void {
  botEventObservers.add(observer);
  return () => botEventObservers.delete(observer);
}

const sessionDir = () => path.join(app.getPath('userData'), 'agent', 'sessions');

function rootIdentity(conversationId: string): SessionIdentity | undefined {
  const identity = agentSessionIndex.currentIdentity(conversationId);
  return identity && !('parent' in identity) ? identity : undefined;
}

function createRuntime(botsRoot: string): BotRuntimePort {
  return {
    async spawn(spec) {
      const identity = rootIdentity(spec.conversationId) ?? {
        sessionId: spec.conversationId,
        generation: randomUUID(),
      };
      agentSessionIndex.prepareParent(identity);
      let keys: ReadonlySet<string>;
      try {
        keys = await readStoredOauthCredentialKeys();
      } catch {
        return { ok: false, error: 'model credentials unavailable' };
      }
      const model = pickBotModel(
        spec.bot.engine,
        readSettingsState() ?? {},
        (ref) => resolveModelSelection(ref.providerId, ref.modelId, keys, { allowVirtual: true }).ok
      );
      if (!model) return { ok: false, error: 'no-usable-model' };
      return spawnSession(
        identity,
        {
          sessionId: spec.conversationId,
          providerId: model.providerId,
          modelId: model.modelId,
          cwd: spec.cwd,
          ...(spec.resumeFile ? { resumeFile: spec.resumeFile } : {}),
          reasoningEnabled: model.reasoningEnabled,
          thinkingLevel: model.thinkingLevel,
          approvalMode: spec.bot.approvalMode,
        },
        keys,
        undefined,
        spec.projectId,
        {
          extraDisabledTools: spec.bot.tools === 'readonly' ? BOT_READONLY_DISABLED_TOOLS : [],
          bot: {
            systemPrompt: spec.systemPrompt,
            instruction: mergeBotInstruction(
              resolveGlobalInstruction(),
              spec.instructionText,
              path.join(botsRoot, spec.bot.id, 'BOT_MODE.md')
            ),
            skillIds: spec.bot.skillIds,
            mcpServerIds: spec.bot.mcpServerIds,
            ...(spec.groupTasks ? { groupTasks: true } : {}),
          },
        }
      );
    },
    prompt(conversationId, text, images, deliveryId) {
      const identity = rootIdentity(conversationId);
      return identity
        ? promptSession(identity, text, images, deliveryId)
        : { ok: false, error: 'stale session generation' };
    },
    steer(conversationId, text, images, deliveryId) {
      const identity = rootIdentity(conversationId);
      return identity
        ? steerSession(identity, text, images, deliveryId)
        : { ok: false, error: 'stale session generation' };
    },
    async release(conversationId) {
      const identity = rootIdentity(conversationId);
      if (identity && agentSessionIndex.isAlive(conversationId)) {
        const released = await releaseParentSession(identity);
        if (!released.ok) throw new Error(released.error ?? 'release-failed');
      }
    },
    abort(conversationId) {
      const identity = rootIdentity(conversationId);
      if (identity) abortSession(identity);
    },
    removeSessionFiles(conversation) {
      removeConversationSessionFiles({
        sessionDir: sessionDir(),
        conversationId: conversation.conversationId,
        ...(conversation.sessionFile ? { sessionFile: conversation.sessionFile } : {}),
      });
    },
  };
}

/** 首次使用时才建；开关关闭时不创建任何 Bot 服务 */
export function getBotServices(): BotServices | null {
  if (!botModeEnabled()) return null;
  if (services) return services;
  const authority = getSourceAuthorityRegistry();
  if (!authority) return null;
  const userData = app.getPath('userData');
  const botsRoot = path.join(userData, 'bots');
  const bots = new BotStore(botsRoot);
  const chats = new BotChatStore(path.join(userData, 'bot-chats'));
  const usage = new BotUsageService({
    bots,
    conversations: () => authority.botConversations(),
    load: loadUsageSession,
    pricing: getUsagePricing,
  });
  const host = new BotSessionHost({
    bots,
    chats,
    authority,
    runtime: createRuntime(botsRoot),
    emit: emitBotEvent,
    budget: usage,
  });
  const delegationStore = new DelegationStore(
    path.join(userData, 'bot-chats', 'delegations.jsonl')
  );
  const taskStore = new GroupTaskStore(path.join(userData, 'bot-chats'));
  const groups = new GroupChatService({
    bots,
    chats,
    host,
    emit: emitBotEvent,
    delegatedTargets: (conversationId, turnKey) =>
      turnDelegationTargets(delegationStore.list(), conversationId, turnKey),
    groupState: (chatId) => ({
      delegations: delegationStore
        .list(chatId)
        .filter((record) => record.state === 'queued' || record.state === 'running')
        .map((record) => ({
          from: record.parentBotId,
          to: record.targetBotId,
          state: record.state,
          task: record.task,
        })),
      tasks: taskStore
        .list(chatId)
        .filter((task) => task.status === 'todo' || task.status === 'doing'),
    }),
    responder: createSmartRouter({
      settings: () => readSettingsState(),
      judge: async ({ preferred, ...request }, signal) => {
        const state = readSettingsState();
        if (!state || !isAgentWorkerReady()) return null;
        const candidates = await remoteCandidates(state, preferred);
        if (candidates.length === 0 || signal.aborted) return null;
        const requestId = randomUUID();
        const abort = () => abortCompleteText(requestId);
        signal.addEventListener('abort', abort, { once: true });
        try {
          return await completeText({ requestId, ...request, candidates, maxTokens: 1024 });
        } finally {
          signal.removeEventListener('abort', abort);
        }
      },
      classify: async (config, question, signal) => {
        const resolved = resolveVirtualClassifier(config, await readStoredOauthCredentialKeys());
        if (!resolved?.classifier || !isAgentWorkerReady()) return null;
        return classifyChoice(
          { classifier: resolved.classifier, ...question, timeoutMs: config.timeoutMs },
          signal
        );
      },
    }),
  });
  host.onDiscard((scope) => {
    if (scope.chatId) groups.discard(scope.chatId);
    groups.clearCompacted(scope);
  });
  let delegationsRef: DelegationService | undefined;
  const tasks = new GroupTaskService({
    store: taskStore,
    chats,
    bots,
    emit: emitBotEvent,
    send: (chatId, text) => groups.send(chatId, text, { deliveryId: randomUUID() }),
    cancelDelegation: (id) => {
      delegationsRef?.cancel(id);
    },
  });
  host.onDiscard((scope) => {
    if (scope.botId) tasks.releaseBot(scope.botId);
  });
  const delegations = new DelegationService({
    bots,
    chats,
    host,
    authority,
    store: delegationStore,
    emit: emitBotEvent,
    tasks,
    deliverGroupResult: async (record, text, deliveryId) => {
      if (
        !record.chatId ||
        chats.get(record.chatId)?.sessions[record.parentBotId]?.conversationId !==
          record.parentConversationId
      )
        return { ok: false, error: 'parent-session-changed' };
      return groups.runAs(record.chatId, record.parentBotId, text, undefined, {
        onlyIfIdle: true,
        deliveryId,
      });
    },
  });
  delegationsRef = delegations;
  const routines = new BotRoutineStore(botsRoot);
  const runner = new RoutineRunner({
    host,
    chats,
    groups,
    deny: (identity, requestId) => {
      if (agentSessionIndex.isCurrent(identity)) respondApproval(identity, requestId, 'deny');
    },
  });
  const scheduler = new RoutineScheduler({
    store: routines,
    eligible: (routine) => {
      const bot = bots.get(routine.botId),
        chat = chats.get(routine.chatId);
      return Boolean(
        bot &&
          bot.archivedAt === undefined &&
          chat &&
          chat.archivedAt === undefined &&
          chat.members.includes(routine.botId)
      );
    },
    run: (routine) => runner.run(routine),
    emit: emitBotEvent,
  });
  setBotWorkerEventObserver((event) => {
    runner.observe(event);
    host.observe(event);
    if (event.type === 'status' && event.status === 'running')
      delegations.observeRunning(event.identity.sessionId);
  });
  const memory = new BotMemoryService({
    bots,
    chats,
    watermarksFile: path.join(userData, 'bot-chats', 'memory-watermarks.json'),
    isCodeProject: (id) => {
      const project = authority.project(id);
      return project?.state === 'active' && project.kind !== 'bot-home';
    },
    schedule: async (payload) =>
      (await import('../services/memoryHost')).scheduleMemoryDistill(payload),
  });
  host.onDiscard((scope) => {
    if (scope.conversationId) memory.remove(scope.conversationId);
  });
  setBotGroupSender((chat, text, options) => groups.send(chat.id, text, options));
  services = {
    bots,
    chats,
    host,
    groups,
    memory,
    delegations,
    routines,
    scheduler,
    runner,
    tasks,
    usage,
  };
  if (botModeEnabled()) scheduler.start();
  return services;
}

export function syncBotModeServices(): void {
  if (botModeEnabled()) getBotServices()?.scheduler.start();
  else if (services) {
    const previous = services;
    previous.host.freeze();
    previous.scheduler.stop();
    previous.groups.dispose();
    previous.delegations.disable();
    previous.host.dispose();
    previous.runner.dispose();
    previous.memory.dispose();
    setBotWorkerEventObserver(null);
    setBotGroupSender(null);
    services = null;
  }
}

function reservedNames(): string[] {
  return [
    ...BUILTIN_AGENT_TYPES.map((type) => type.name),
    ...agentTypeRegistrySnapshot()
      .candidates.filter((candidate) => candidate.source !== 'bot')
      .map((candidate) => candidate.displayName),
  ];
}

function resolveWorkspaceInput(
  bots: BotServices,
  chatId: string,
  input: ChatWorkspaceInput
): BotChatWorkspace | { error: string } {
  if (input.kind === 'member-home') return { kind: 'member-home' };
  const authority = getSourceAuthorityRegistry();
  if (input.kind === 'chat-home') {
    const project = authority?.ensureBotHomeProject(bots.chats.workspaceDir(chatId));
    return project ? { kind: 'chat-home', projectId: project.projectId } : { error: 'unavailable' };
  }
  const project = authority?.project(input.projectId);
  if (project?.state !== 'active') return { error: 'workspace-unavailable' };
  if (project.kind === 'ssh' || project.kind === 'bot-home') {
    return { error: 'workspace-unsupported' };
  }
  return { kind: 'project', projectId: project.projectId };
}

function activeMembers(bots: BotServices, members: readonly string[]): boolean {
  return members.every((id) => {
    const bot = bots.bots.get(id);
    return bot !== undefined && bot.archivedAt === undefined;
  });
}

type Handler = (sender: number, request: unknown, bots: BotServices) => unknown;

/**
 * 开关关闭时一律返回 whenDisabled 且不创建任何 Bot 服务（列表类返回空 + enabled:false）；
 * write 另要求主窗口。
 */
function handle(
  channel: string,
  kind: 'read' | 'write',
  handler: Handler,
  whenDisabled: unknown = DISABLED
): void {
  ipcMain.handle(channel, async (event, request: unknown) => {
    if (kind === 'write' && !isMainWebContents(event.sender.id)) return UNAVAILABLE;
    if (!botModeEnabled()) return whenDisabled;
    try {
      const bots = getBotServices();
      return bots ? await handler(event.sender.id, request, bots) : UNAVAILABLE;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'unavailable' };
    }
  });
}

const botIdOf = (request: unknown): string | null => {
  const botId =
    request && typeof request === 'object' && 'botId' in request ? request.botId : undefined;
  return isBotId(botId) ? botId : null;
};
const chatIdOf = (request: unknown): string | null => {
  const chatId =
    request && typeof request === 'object' && 'chatId' in request ? request.chatId : undefined;
  return isBotId(chatId) ? chatId : null;
};

/** 设置里的技能 / MCP 条目 → 推荐候选（只取 id、名称、描述） */
function catalogItems(value: unknown): { id: string; name: string; description?: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const { id, name, description, enabled } = item as Record<string, unknown>;
    // 全局停用的条目成员也用不上，不作为候选
    if (typeof id !== 'string' || typeof name !== 'string' || enabled === false) return [];
    return [{ id, name, ...(typeof description === 'string' ? { description } : {}) }];
  });
}

/** Bot 辅助任务的一次性补全：Bot 助理模型 → 默认模型 */
function assistantCompleter(maxTokens: number): AbilityCompleter {
  return async (completion, signal) => {
    const state = readSettingsState();
    if (!state || !isAgentWorkerReady()) return null;
    const candidates = await resolveRemoteModels(botAssistantModelCandidates(state));
    if (candidates.length === 0) return null;
    const requestId = randomUUID();
    signal.addEventListener('abort', () => abortCompleteText(requestId), { once: true });
    return completeText({ requestId, ...completion, candidates, maxTokens });
  };
}

/** 桌面 BOT_SEND 与手机 bot-send 共用 */
export async function sendBotMessage(
  { chats, host }: BotServices,
  request: unknown
): Promise<BotSendResult> {
  const input = parseSendInput(request);
  const chat = input ? chats.get(input.chatId) : undefined;
  if (!input || !chat) return INVALID;
  if (chat.archivedAt !== undefined) return { ok: false, error: 'chat-archived' };
  const options = {
    deliveryId: input.deliveryId,
    ...(input.images ? { images: input.images } : {}),
  };
  if (chat.kind === 'group') {
    return groupSender
      ? groupSender(chat, input.text, options)
      : { ok: false, error: 'group-not-ready' };
  }
  return host.deliver(chat.id, chat.members[0], input.text, options);
}

/** 桌面 BOT_CHAT_TIMELINE 与手机 bot-timeline 共用 */
export function readBotTimeline({ chats }: BotServices, request: unknown): BotTimelineResult {
  const input = parseTimelineInput(request);
  if (!input || !chats.get(input.chatId)) return INVALID;
  return {
    ok: true,
    entries: chats.readEntries(input.chatId, input),
    lastSeq: chats.lastSeq(input.chatId),
  };
}

const objectInput = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const optionalText = (value: unknown, max: number): value is string | undefined =>
  value === undefined || (typeof value === 'string' && value.length <= max);

/** 看板写入口的公共收窄：chatId + 已存在的群 + 任务 id */
function taskTarget(
  { chats }: BotServices,
  request: unknown
): { input: Record<string, unknown>; chatId: string; id: string } | undefined {
  const input = objectInput(request);
  if (!input || !isBotId(input.chatId) || !isBotId(input.id)) return undefined;
  return chats.get(input.chatId)?.kind === 'group'
    ? { input, chatId: input.chatId, id: input.id }
    : undefined;
}

/** worker 的 group_tasks 调用：只对群聊里该成员的当前会话开放 */
export function groupTasksTool(
  services: BotServices | null | undefined,
  conversationId: string,
  binding: { botId: string; chatId: string | null },
  params: Record<string, unknown>
): unknown {
  const chat = services && binding.chatId ? services.chats.get(binding.chatId) : undefined;
  if (
    !services ||
    chat?.kind !== 'group' ||
    chat.sessions[binding.botId]?.conversationId !== conversationId
  )
    return { ok: false, error: 'Tasks are only available in the current group chat session.' };
  return services.tasks.tool(chat.id, binding.botId, params);
}

/** worker 的 group_history 调用：chatId 只取会话权威绑定，且必须是该成员在该群的当前会话 */
export function groupHistoryTool(
  services: BotServices | null | undefined,
  conversationId: string,
  binding: { botId: string; chatId: string | null },
  params: Record<string, unknown>
): unknown {
  const chat = services && binding.chatId ? services.chats.get(binding.chatId) : undefined;
  if (
    !services ||
    chat?.kind !== 'group' ||
    !chat.members.includes(binding.botId) ||
    chat.sessions[binding.botId]?.conversationId !== conversationId
  )
    return { ok: false, error: 'History is only available in the current group chat session.' };
  const query = parseGroupHistoryQuery(params);
  if (typeof query === 'string') return { ok: false, error: query };
  return queryGroupHistory(
    services.chats.readEntries(chat.id, { limit: Number.MAX_SAFE_INTEGER }),
    (id) => services.bots.get(id)?.name,
    query
  );
}

export function registerBotHandlers(): void {
  syncBotModeServices();
  handle(
    IPC_CHANNELS.BOT_DELEGATIONS_LIST,
    'read',
    (_sender, request, { delegations }) => {
      const input = objectInput(request ?? {});
      if (!input || (input.chatId !== undefined && !isBotId(input.chatId))) return INVALID;
      return {
        ok: true,
        delegations: delegations.list(typeof input.chatId === 'string' ? input.chatId : undefined),
        enabled: true,
      };
    },
    { ok: true, delegations: [], enabled: false }
  );
  handle(IPC_CHANNELS.BOT_DELEGATION_CANCEL, 'write', (_sender, request, { delegations }) => {
    const input = objectInput(request);
    return input && isBotId(input.id) ? delegations.cancel(input.id) : INVALID;
  });
  handle(IPC_CHANNELS.BOT_DELEGATION_RETRY, 'write', (_sender, request, { delegations }) => {
    const input = objectInput(request);
    return input && isBotId(input.id) ? delegations.retry(input.id) : INVALID;
  });
  handle(
    IPC_CHANNELS.BOT_ROUTINES_LIST,
    'read',
    (_sender, request, { routines }) => {
      const input = objectInput(request ?? {});
      if (!input || (input.botId !== undefined && !isBotId(input.botId))) return INVALID;
      return {
        ok: true,
        routines: typeof input.botId === 'string' ? routines.list(input.botId) : routines.listAll(),
        enabled: true,
      };
    },
    { ok: true, routines: [], enabled: false }
  );
  handle(
    IPC_CHANNELS.BOT_ROUTINE_SAVE,
    'write',
    (_sender, request, { routines, chats, bots, scheduler }) => {
      const input = objectInput(request);
      if (
        !input ||
        !isBotId(input.botId) ||
        !isBotId(input.chatId) ||
        typeof input.title !== 'string' ||
        typeof input.prompt !== 'string' ||
        typeof input.schedule !== 'string' ||
        (input.id !== undefined && !isBotId(input.id)) ||
        (input.enabled !== undefined && typeof input.enabled !== 'boolean')
      )
        return INVALID;
      if (!bots.get(input.botId) || !chats.get(input.chatId)?.members.includes(input.botId))
        return INVALID;
      const result = routines.save(input.botId, {
        title: input.title,
        prompt: input.prompt,
        schedule: input.schedule,
        chatId: input.chatId,
        ...(typeof input.id === 'string' ? { id: input.id } : {}),
        ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
      });
      if (!result.ok) return { ok: false, error: result.reason };
      scheduler.refresh();
      emitBotEvent({ kind: 'routine' });
      return result;
    }
  );
  handle(IPC_CHANNELS.BOT_ROUTINE_DELETE, 'write', (_sender, request, { routines, scheduler }) => {
    const input = objectInput(request);
    if (
      !input ||
      !isBotId(input.botId) ||
      !isBotId(input.id) ||
      !routines.remove(input.botId, input.id)
    )
      return INVALID;
    scheduler.refresh();
    emitBotEvent({ kind: 'routine' });
    return { ok: true };
  });
  handle(
    IPC_CHANNELS.BOT_ROUTINE_RUN_NOW,
    'write',
    (_sender, request, { routines, scheduler, bots, chats }) => {
      const input = objectInput(request);
      if (!input || !isBotId(input.botId) || !isBotId(input.id)) return INVALID;
      const routine = routines.list(input.botId).find((item) => item.id === input.id);
      if (!routine) return INVALID;
      const bot = bots.get(routine.botId),
        chat = chats.get(routine.chatId);
      if (
        !bot ||
        bot.archivedAt !== undefined ||
        !chat ||
        chat.archivedAt !== undefined ||
        !chat.members.includes(bot.id)
      )
        return UNAVAILABLE;
      void scheduler
        .runNow(input.botId, input.id)
        .catch((error) => console.warn('[bots] routine failed', error));
      return { ok: true };
    }
  );
  handle(
    IPC_CHANNELS.BOT_TASKS_LIST,
    'read',
    (_sender, request, { chats, tasks }) => {
      const chatId = chatIdOf(request);
      if (!chatId || chats.get(chatId)?.kind !== 'group') return INVALID;
      return { ok: true, tasks: tasks.list(chatId), enabled: true };
    },
    { ok: true, tasks: [], enabled: false }
  );
  handle(IPC_CHANNELS.BOT_TASK_SAVE, 'write', (_sender, request, { chats, tasks }) => {
    const input = objectInput(request);
    if (
      !input ||
      !isBotId(input.chatId) ||
      chats.get(input.chatId)?.kind !== 'group' ||
      typeof input.title !== 'string' ||
      input.title.length > GROUP_TASK_TITLE_MAX ||
      !optionalText(input.detail, GROUP_TASK_TEXT_MAX) ||
      (input.id !== undefined && !isBotId(input.id))
    )
      return INVALID;
    const detail = typeof input.detail === 'string' ? input.detail : undefined;
    return typeof input.id === 'string'
      ? tasks.update(input.chatId, 'human', input.id, {
          title: input.title,
          ...(detail !== undefined ? { detail } : {}),
        })
      : tasks.add(input.chatId, 'human', {
          title: input.title,
          ...(detail ? { detail } : {}),
        });
  });
  handle(IPC_CHANNELS.BOT_TASK_ASSIGN, 'write', (_sender, request, services) => {
    const target = taskTarget(services, request);
    if (!target || !isBotId(target.input.botId)) return INVALID;
    return services.tasks.assign(target.chatId, target.id, target.input.botId);
  });
  handle(IPC_CHANNELS.BOT_TASK_COMPLETE, 'write', (_sender, request, services) => {
    const target = taskTarget(services, request);
    if (!target || !optionalText(target.input.result, GROUP_TASK_TEXT_MAX)) return INVALID;
    const result = typeof target.input.result === 'string' ? target.input.result : undefined;
    return services.tasks.complete(target.chatId, 'human', target.id, result);
  });
  handle(IPC_CHANNELS.BOT_TASK_CANCEL, 'write', (_sender, request, services) => {
    const target = taskTarget(services, request);
    return target ? services.tasks.cancel(target.chatId, 'human', target.id) : INVALID;
  });
  handle(IPC_CHANNELS.BOT_TASK_DELETE, 'write', (_sender, request, services) => {
    const target = taskTarget(services, request);
    return target ? services.tasks.remove(target.chatId, target.id) : INVALID;
  });
  handle(
    IPC_CHANNELS.BOTS_LIST,
    'read',
    (_sender, _request, { bots }): BotsListResult => ({
      ok: true,
      bots: bots.list(),
      enabled: true,
    }),
    { ok: true, bots: [], enabled: false } satisfies BotsListResult
  );

  handle(IPC_CHANNELS.BOT_GET, 'read', (_sender, request, { bots }): BotGetResult => {
    const botId = botIdOf(request);
    const bot = botId ? bots.get(botId) : undefined;
    return bot ? { ok: true, bot, persona: bots.readPersona(bot.id) } : INVALID;
  });

  handle(IPC_CHANNELS.BOT_CREATE, 'write', (_sender, request, { bots }): BotWriteIpcResult => {
    const draft = parseBotDraftInput(request);
    if (!draft || draft.name === undefined) return INVALID;
    const result = bots.create(draft, reservedNames());
    if (!result.ok) return { ok: false, error: result.reason };
    emitBotEvent({ kind: 'catalog' });
    return result;
  });

  handle(
    IPC_CHANNELS.BOT_SUGGEST_ABILITIES,
    'write',
    (_sender, request, { bots }): Promise<BotAbilitySuggestResult> | BotAbilitySuggestResult => {
      const parsed = parseAbilitySuggestRequest(request);
      if (!parsed) return INVALID;
      const state = readSettingsState();
      return suggestAbilities(
        {
          ...parsed,
          skills: catalogItems(state?.skills),
          mcpServers: catalogItems(state?.mcpServers),
          members: bots
            .list()
            .filter((bot) => bot.id !== parsed.botId && !bot.archivedAt)
            .map((bot) => ({ id: bot.id, name: bot.name, title: bot.title, scope: bot.scope })),
        },
        assistantCompleter(2048)
      );
    }
  );

  handle(
    IPC_CHANNELS.BOT_SUGGEST_PERSONA,
    'write',
    (_sender, request): Promise<BotPersonaSuggestResult> | BotPersonaSuggestResult => {
      const parsed = parsePersonaSuggestRequest(request);
      if (!parsed) return INVALID;
      return suggestPersona(parsed, assistantCompleter(4096));
    }
  );

  handle(IPC_CHANNELS.BOT_UPDATE, 'write', (_sender, request, { bots }): BotWriteIpcResult => {
    const parsed = parseBotUpdateInput(request);
    if (!parsed) return INVALID;
    const result = bots.update(parsed.botId, parsed.draft, reservedNames(), parsed.expectedVersion);
    if (!result.ok) return { ok: false, error: result.reason };
    emitBotEvent({ kind: 'catalog' });
    return result;
  });

  handle(IPC_CHANNELS.BOT_ARCHIVE, 'write', (_sender, request, { bots }): BotWriteIpcResult => {
    const botId = botIdOf(request);
    const archived = (request as { archived?: unknown } | null)?.archived;
    if (!botId || typeof archived !== 'boolean') return INVALID;
    const result = bots.setArchived(botId, archived);
    if (!result.ok) return { ok: false, error: result.reason };
    emitBotEvent({ kind: 'catalog' });
    return result;
  });

  handle(
    IPC_CHANNELS.BOT_DELETE,
    'write',
    async (_sender, request, { host, chats, groups }): Promise<BotActionResult> => {
      const botId = botIdOf(request);
      if (!botId) return INVALID;
      if (!chats.list().some((chat) => chat.bossBotId === botId)) {
        for (const chat of chats.list()) {
          const state = chat.kind === 'group' ? groups.state(chat.id) : undefined;
          if (state?.ok && state.current === botId) {
            const stopped = await groups.stop(chat.id);
            if (!stopped.ok) return stopped;
          }
        }
      }
      const result = host.discardBot(botId);
      if (result.ok) await removeBotMemorySpace(app.getPath('userData'), `bot:${botId}`);
      return result.ok
        ? result
        : {
            ok: false,
            error: result.reason,
            reason: result.reason,
            ...(result.chatIds ? { chatIds: result.chatIds } : {}),
          };
    }
  );

  handle(
    IPC_CHANNELS.BOT_CHATS_LIST,
    'read',
    (_sender, _request, { chats, host }): BotChatsListResult => ({
      ok: true,
      chats: chats.list(),
      queue: host.queueState(),
      enabled: true,
    }),
    { ok: true, chats: [], queue: [], enabled: false } satisfies BotChatsListResult
  );

  handle(
    IPC_CHANNELS.BOT_CHAT_CREATE,
    'write',
    (_sender, request, services): BotChatWriteResult => {
      const input = parseChatCreateInput(request);
      if (!input || !activeMembers(services, input.members)) return INVALID;
      if (input.kind === 'direct') {
        const existing = services.chats
          .list()
          .find((chat) => chat.kind === 'direct' && chat.members[0] === input.members[0]);
        if (existing) return { ok: true, chat: existing };
      }
      const chatId = randomUUID();
      const workspace = resolveWorkspaceInput(services, chatId, input.workspace);
      if ('error' in workspace) return { ok: false, error: workspace.error };
      const chat = services.chats.create({ ...input, workspace }, chatId);
      if (!chat) {
        if (workspace.kind === 'chat-home') {
          getSourceAuthorityRegistry()?.removeBotHomeProject(workspace.projectId);
          rmSync(path.dirname(services.chats.workspaceDir(chatId)), {
            recursive: true,
            force: true,
          });
        }
        return INVALID;
      }
      emitBotEvent({ kind: 'chat', chatId });
      return { ok: true, chat };
    }
  );

  handle(
    IPC_CHANNELS.BOT_CHAT_UPDATE,
    'write',
    async (_sender, request, services): Promise<BotChatWriteResult> => {
      const input = parseChatUpdateInput(request);
      const current = input ? services.chats.get(input.chatId) : undefined;
      if (!input || !current) return INVALID;
      if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
        return { ok: false, error: 'conflict' };
      }
      const added = (input.members ?? []).filter((id) => !current.members.includes(id));
      if (!activeMembers(services, added)) return INVALID;
      let workspace: BotChatWorkspace | undefined;
      if (input.workspace) {
        const resolved = resolveWorkspaceInput(services, current.id, input.workspace);
        if ('error' in resolved) return { ok: false, error: resolved.error };
        workspace = resolved;
      }
      const workspaceChanged =
        workspace !== undefined && JSON.stringify(workspace) !== JSON.stringify(current.workspace);
      const routing = current.kind === 'group' ? services.groups.state(current.id) : undefined;
      if (
        routing?.ok &&
        (workspaceChanged ||
          input.archived === true ||
          (routing.current && input.members && !input.members.includes(routing.current)))
      ) {
        const stopped = await services.groups.stop(current.id);
        if (!stopped.ok) return stopped;
      }
      const before = current.sessions;
      const at = Date.now();
      const chat = services.chats.update(current.id, (draft) => {
        if (input.title !== undefined) draft.title = input.title;
        if (input.pinned !== undefined) draft.pinned = input.pinned;
        if (input.archived === true) draft.archivedAt = at;
        if (input.archived === false) delete draft.archivedAt;
        if (input.members) draft.members = input.members;
        if (input.bossBotId !== undefined) draft.bossBotId = input.bossBotId;
        if (input.routing) draft.routing = { ...draft.routing, ...input.routing };
        if (workspace) draft.workspace = workspace;
        if (workspaceChanged) draft.sessions = {};
        return draft;
      });
      if (!chat) return INVALID;
      for (const [botId, session] of Object.entries(before)) {
        if (workspaceChanged || !chat.members.includes(botId)) {
          services.host.retireSession(session.conversationId);
        }
      }
      for (const botId of current.members)
        if (!chat.members.includes(botId)) services.tasks.releaseMember(chat.id, botId);
      emitBotEvent({ kind: 'chat', chatId: chat.id });
      return { ok: true, chat };
    }
  );

  handle(
    IPC_CHANNELS.BOT_CHAT_DELETE,
    'write',
    async (_sender, request, { host, chats, groups, tasks }): Promise<BotActionResult> => {
      const chatId = chatIdOf(request);
      if (!chatId || !chats.get(chatId)) return INVALID;
      if (chats.get(chatId)?.kind === 'group') {
        const stopped = await groups.stop(chatId);
        if (!stopped.ok) return stopped;
      }
      if (!host.discardChat(chatId)) return INVALID;
      tasks.forget(chatId);
      await removeBotMemorySpace(app.getPath('userData'), `chat:${chatId}`);
      return { ok: true };
    }
  );

  handle(
    IPC_CHANNELS.BOT_CHAT_NEW_SESSION,
    'write',
    async (_sender, request, { chats, host, memory }): Promise<BotNewSessionResult> => {
      const chatId = chatIdOf(request);
      const chat = chatId ? chats.get(chatId) : undefined;
      if (chat?.kind !== 'direct') return INVALID;
      const old = chat.sessions[chat.members[0]];
      if (old) await host.stopTurn(chat.id, chat.members[0]);
      const conversation = old && getSourceAuthorityRegistry()?.conversation(old.conversationId);
      if (conversation) await memory.distill(conversation);
      return host.ensureSession(chat.id, chat.members[0], { fresh: true });
    }
  );

  handle(
    IPC_CHANNELS.BOT_CHAT_SESSIONS,
    'read',
    (_sender, request, { chats, host }): BotChatSessionsResult => {
      const chatId = chatIdOf(request);
      return chatId && chats.get(chatId)
        ? { ok: true, sessions: host.sessionsOf(chatId) }
        : INVALID;
    }
  );

  handle(IPC_CHANNELS.BOT_CHAT_STOP, 'write', (_sender, request, { groups }) => {
    const chatId = chatIdOf(request);
    return chatId ? groups.stop(chatId) : INVALID;
  });
  handle(IPC_CHANNELS.BOT_CHAT_STATE, 'read', (_sender, request, { groups }) => {
    const chatId = chatIdOf(request);
    return chatId ? groups.state(chatId) : INVALID;
  });

  handle(
    IPC_CHANNELS.BOT_CHAT_TIMELINE,
    'read',
    (_sender, request, services): BotTimelineResult => readBotTimeline(services, request)
  );

  handle(IPC_CHANNELS.BOT_SEND, 'write', (_sender, request, services) =>
    sendBotMessage(services, request)
  );

  handle(IPC_CHANNELS.BOT_OPEN_WORKSPACE, 'write', async (_sender, request, services) => {
    const input = parseOpenWorkspaceInput(request);
    if (!input) return INVALID;
    const dir =
      'botId' in input
        ? services.bots.get(input.botId) && services.bots.homeDir(input.botId)
        : services.host.workspacePath(input.chatId);
    if (!dir) return UNAVAILABLE;
    try {
      mkdirSync(dir, { recursive: true });
      const failure = await shell.openPath(dir);
      return failure ? { ok: false, error: failure } : { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'unavailable' };
    }
  });

  handle(IPC_CHANNELS.BOT_SESSION_HISTORY, 'read', async (_sender, request) => {
    const input = parseSessionHistoryInput(request);
    const conversation = input
      ? getSourceAuthorityRegistry()?.conversation(input.conversationId)
      : undefined;
    if (!input || !conversation?.bot) {
      return { ok: false, code: 'not-found', error: 'Not a bot conversation.' };
    }
    return readSessionHistoryFile(conversation.sessionFile, input.beforeIndex);
  });

  handle(IPC_CHANNELS.BOT_SEARCH, 'read', (_sender, request, services) =>
    searchChats(services, request)
  );
  handle(IPC_CHANNELS.BOT_ARTIFACTS_LIST, 'read', (_sender, request, services) =>
    listArtifacts(services, request)
  );
  handle(IPC_CHANNELS.BOT_ARTIFACT_READ, 'read', (_sender, request, services) =>
    readArtifact(services, request)
  );
  handle(IPC_CHANNELS.BOT_ARTIFACT_OPEN, 'write', (_sender, request, services) =>
    openArtifact(services, request)
  );
  handle(
    IPC_CHANNELS.BOT_USAGE_SUMMARY,
    'read',
    async (_sender, days, services) =>
      isUsageRangeDays(days) ? { ok: true, rows: await services.usage.summary(days) } : INVALID,
    { ok: true, rows: [] }
  );
  handle(
    IPC_CHANNELS.BOT_USAGE,
    'read',
    async (_sender, _request, services) => ({ ok: true, ...(await services.usage.overview()) }),
    { ok: true, day: '', bots: {} }
  );
}
