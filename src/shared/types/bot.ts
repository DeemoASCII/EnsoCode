import { MISSED_RUNS_MAX, parseCron } from '../bots/cron';
import { APPROVAL_MODES, type ApprovalMode, THINKING_LEVELS, type ThinkingLevel } from './agent';

export type BotId = string;
export type BotChatId = string;
export type BotList = 'any' | BotId[];

export interface BotEngine {
  providerId: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
}

export interface BotProfile {
  id: BotId;
  /** 群内 @ 用，唯一（大小写不敏感） */
  name: string;
  title: string;
  /** 一句话职责：路由提示与委派目录 */
  scope: string;
  avatar: { color: string };
  /** 缺省跟随全局默认模型 */
  engine?: BotEngine;
  approvalMode: ApprovalMode;
  tools: 'all' | 'readonly';
  skillIds: string[];
  mcpServerIds: string[];
  delegation: { canDelegateTo: BotList; acceptFrom: BotList };
  memory: { enabled: boolean };
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export type BotChatWorkspace =
  | { kind: 'member-home' }
  | { kind: 'chat-home'; projectId: string }
  | { kind: 'project'; projectId: string };

/** 人类消息不 @ 任何人时：boss 群主回复；smart 由便宜模型/分类器选一位成员 */
export const BOT_ROUTING_MODES = ['boss', 'smart'] as const;
export type BotRoutingMode = (typeof BOT_ROUTING_MODES)[number];

export interface BotChatRouting {
  mode: BotRoutingMode;
  maxHops: number;
  maxTurnsPerBot: number;
}

export interface BotChatSession {
  conversationId: string;
  /** 已投递给该成员的最后一条时间线 seq */
  cursor: number;
  distilledTo?: string;
}

export interface BotChat {
  id: BotChatId;
  kind: 'direct' | 'group';
  title: string;
  members: BotId[];
  bossBotId: BotId | null;
  workspace: BotChatWorkspace;
  routing: BotChatRouting;
  pinned: boolean;
  archivedAt?: number;
  sessions: Record<BotId, BotChatSession>;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export const DELEGATION_STATES = ['queued', 'running', 'completed', 'failed', 'canceled'] as const;
export type DelegationState = (typeof DELEGATION_STATES)[number];
export type BotPermissions = Pick<
  BotProfile,
  'tools' | 'approvalMode' | 'skillIds' | 'mcpServerIds'
>;

export interface Delegation {
  id: string;
  parentConversationId: string;
  parentBotId: BotId;
  targetBotId: BotId;
  chatId: BotChatId | null;
  task: string;
  context: string;
  childConversationId: string;
  state: DelegationState;
  failure?: 'interrupted' | 'timeout' | 'denied' | 'error';
  error?: string;
  result?: string;
  deliveredAt?: number;
  depth: number;
  createdAt: number;
  finishedAt?: number;
  effectivePermissions?: BotPermissions;
  /** 发起时父会话所在轮次的键；同父会话同 batchId 的委派结果合并回传 */
  batchId?: string;
}

export function parseDelegation(value: unknown): Delegation | undefined {
  if (
    !isObject(value) ||
    !isBotId(value.id) ||
    !isBotId(value.parentBotId) ||
    !isBotId(value.targetBotId) ||
    !isText(value.parentConversationId) ||
    !isText(value.childConversationId) ||
    (value.chatId !== null && !isBotChatId(value.chatId)) ||
    !isText(value.task) ||
    typeof value.context !== 'string' ||
    value.context.length > 8000 ||
    !DELEGATION_STATES.includes(value.state as DelegationState) ||
    !Number.isInteger(value.depth) ||
    Number(value.depth) < 1 ||
    Number(value.depth) > 2 ||
    !isTime(value.createdAt) ||
    (value.deliveredAt !== undefined && !isTime(value.deliveredAt)) ||
    (value.finishedAt !== undefined && !isTime(value.finishedAt))
  )
    return undefined;
  const record: Delegation = {
    id: value.id,
    parentConversationId: value.parentConversationId,
    parentBotId: value.parentBotId,
    targetBotId: value.targetBotId,
    chatId: value.chatId,
    task: value.task,
    context: value.context,
    childConversationId: value.childConversationId,
    state: value.state as DelegationState,
    depth: Number(value.depth),
    createdAt: value.createdAt,
  };
  if (
    value.failure === 'interrupted' ||
    value.failure === 'timeout' ||
    value.failure === 'denied' ||
    value.failure === 'error'
  )
    record.failure = value.failure;
  if (typeof value.error === 'string') record.error = value.error;
  if (typeof value.result === 'string') record.result = value.result;
  if (isTime(value.deliveredAt)) record.deliveredAt = value.deliveredAt;
  if (isTime(value.finishedAt)) record.finishedAt = value.finishedAt;
  if (isText(value.batchId)) record.batchId = value.batchId;
  if (value.effectivePermissions !== undefined) {
    const permissions = value.effectivePermissions;
    if (
      !isObject(permissions) ||
      (permissions.tools !== 'all' && permissions.tools !== 'readonly') ||
      !APPROVAL_MODES.includes(permissions.approvalMode as ApprovalMode) ||
      !Array.isArray(permissions.skillIds) ||
      !permissions.skillIds.every(isText) ||
      !Array.isArray(permissions.mcpServerIds) ||
      !permissions.mcpServerIds.every(isText)
    )
      return undefined;
    record.effectivePermissions = {
      tools: permissions.tools,
      approvalMode: permissions.approvalMode as ApprovalMode,
      skillIds: [...permissions.skillIds],
      mcpServerIds: [...permissions.mcpServerIds],
    };
  }
  return record;
}

interface GroupEntryBase {
  seq: number;
  id: string;
  at: number;
}

export type GroupEntry =
  | (GroupEntryBase & { kind: 'human'; text: string; mentions: BotId[] })
  | (GroupEntryBase & {
      kind: 'bot';
      botId: BotId;
      text: string;
      conversationId: string;
      turnId: string;
      /** 该轮回复人由智能选人选出（群主兜底不标） */
      routedBy?: 'smart';
    })
  | (GroupEntryBase & {
      kind: 'delegation';
      delegationId: string;
      from: BotId;
      to: BotId;
      state: DelegationState;
      summary?: string;
    })
  | (GroupEntryBase & { kind: 'system'; text: string });

export type GroupEntryInput = GroupEntry extends infer E
  ? E extends GroupEntry
    ? Omit<E, 'seq'>
    : never
  : never;

export const BOT_ROUTING_DEFAULTS: BotChatRouting = { mode: 'boss', maxHops: 4, maxTurnsPerBot: 2 };
const ROUTING_LIMITS = { maxHops: 20, maxTurnsPerBot: 10 } as const;

export const BOT_NAME_MAX = 24;
/** 群聊里 @ 全体的保留写法 */
export const BOT_MENTION_ALL = ['所有人', 'everyone', 'all'] as const;
const BOT_NAME_RE = /^[\p{L}\p{N}_-]+$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const COLOR_RE = /^#[0-9a-f]{6}$/iu;
const AVATAR_COLORS = ['#7c5cff', '#0ea5e9', '#f97316', '#22c55e', '#ec4899', '#eab308'];

export const isBotId = (value: unknown): value is BotId =>
  typeof value === 'string' && UUID_RE.test(value);
export const isBotChatId = isBotId;
export const botNameKey = (name: string): string => name.normalize('NFC').toLowerCase();

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isSeq = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => isText(item)) : [];
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function botList(value: unknown): BotList {
  return Array.isArray(value) ? value.filter(isBotId) : 'any';
}

function intIn(value: unknown, min: number, max: number, fallback: number): number {
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value as number));
}

function defaultColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function normalizeName(raw: string): string | undefined {
  const name = raw.trim().normalize('NFC');
  return name && [...name].length <= BOT_NAME_MAX && BOT_NAME_RE.test(name) ? name : undefined;
}

export type BotNameCheck =
  | { ok: true; name: string }
  | { ok: false; reason: 'invalid' | 'reserved' | 'duplicate' };

/** reserved：内置 agent 类型名等不可占用的名字 */
export function checkBotName(
  raw: string,
  others: readonly Pick<BotProfile, 'id' | 'name'>[],
  reserved: readonly string[],
  selfId?: BotId
): BotNameCheck {
  const name = normalizeName(raw);
  if (!name) return { ok: false, reason: 'invalid' };
  const key = botNameKey(name);
  if ([...BOT_MENTION_ALL, ...reserved].some((item) => botNameKey(item) === key)) {
    return { ok: false, reason: 'reserved' };
  }
  if (others.some((other) => other.id !== selfId && botNameKey(other.name) === key)) {
    return { ok: false, reason: 'duplicate' };
  }
  return { ok: true, name };
}

function parseEngine(value: unknown): BotEngine | undefined {
  if (!isObject(value) || !isText(value.providerId) || !isText(value.modelId)) return undefined;
  const engine: BotEngine = { providerId: value.providerId, modelId: value.modelId };
  if (THINKING_LEVELS.includes(value.thinkingLevel as ThinkingLevel)) {
    engine.thinkingLevel = value.thinkingLevel as ThinkingLevel;
  }
  return engine;
}

export function parseBotProfile(value: unknown): BotProfile | undefined {
  if (!isObject(value) || !isBotId(value.id) || typeof value.name !== 'string') return undefined;
  const name = normalizeName(value.name);
  if (!name || !isTime(value.createdAt) || !isTime(value.updatedAt)) return undefined;
  const avatar = isObject(value.avatar) ? value.avatar : {};
  const delegation = isObject(value.delegation) ? value.delegation : {};
  const memory = isObject(value.memory) ? value.memory : {};
  const profile: BotProfile = {
    id: value.id,
    name,
    title: str(value.title),
    scope: str(value.scope),
    avatar: {
      color:
        typeof avatar.color === 'string' && COLOR_RE.test(avatar.color)
          ? avatar.color
          : defaultColor(value.id),
    },
    approvalMode: APPROVAL_MODES.includes(value.approvalMode as ApprovalMode)
      ? (value.approvalMode as ApprovalMode)
      : 'full',
    tools: value.tools === 'readonly' ? 'readonly' : 'all',
    skillIds: strings(value.skillIds),
    mcpServerIds: strings(value.mcpServerIds),
    delegation: {
      canDelegateTo: botList(delegation.canDelegateTo),
      acceptFrom: botList(delegation.acceptFrom),
    },
    memory: { enabled: memory.enabled !== false },
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    version: Number.isSafeInteger(value.version) ? (value.version as number) : 0,
  };
  const engine = parseEngine(value.engine);
  if (engine) profile.engine = engine;
  if (isTime(value.archivedAt)) profile.archivedAt = value.archivedAt;
  return profile;
}

function parseWorkspace(value: unknown): BotChatWorkspace | undefined {
  if (!isObject(value)) return undefined;
  if (value.kind === 'member-home') return { kind: 'member-home' };
  if ((value.kind === 'chat-home' || value.kind === 'project') && isText(value.projectId)) {
    return { kind: value.kind, projectId: value.projectId };
  }
  return undefined;
}

export function parseBotChat(value: unknown): BotChat | undefined {
  if (!isObject(value) || !isBotChatId(value.id)) return undefined;
  if (value.kind !== 'direct' && value.kind !== 'group') return undefined;
  if (!Array.isArray(value.members) || !value.members.every(isBotId)) return undefined;
  const members = value.members as BotId[];
  if (new Set(members).size !== members.length) return undefined;
  const workspace = parseWorkspace(value.workspace);
  if (!workspace || !isTime(value.createdAt) || !isTime(value.updatedAt)) return undefined;
  const bossBotId = value.bossBotId ?? null;
  if (value.kind === 'direct') {
    if (members.length !== 1 || bossBotId !== null || workspace.kind === 'chat-home')
      return undefined;
  } else if (
    members.length < 2 ||
    !isBotId(bossBotId) ||
    !members.includes(bossBotId) ||
    workspace.kind === 'member-home'
  ) {
    return undefined;
  }
  const routing = isObject(value.routing) ? value.routing : {};
  const sessions: Record<BotId, BotChatSession> = {};
  if (isObject(value.sessions)) {
    for (const [botId, session] of Object.entries(value.sessions)) {
      if (!members.includes(botId) || !isObject(session) || !isText(session.conversationId))
        continue;
      sessions[botId] = {
        conversationId: session.conversationId,
        cursor: intIn(session.cursor, 0, Number.MAX_SAFE_INTEGER, 0),
        ...(isText(session.distilledTo) ? { distilledTo: session.distilledTo } : {}),
      };
    }
  }
  const chat: BotChat = {
    id: value.id,
    kind: value.kind,
    title: str(value.title),
    members,
    bossBotId: bossBotId as BotId | null,
    workspace,
    routing: {
      mode: BOT_ROUTING_MODES.includes(routing.mode as BotRoutingMode)
        ? (routing.mode as BotRoutingMode)
        : BOT_ROUTING_DEFAULTS.mode,
      maxHops: intIn(routing.maxHops, 1, ROUTING_LIMITS.maxHops, BOT_ROUTING_DEFAULTS.maxHops),
      maxTurnsPerBot: intIn(
        routing.maxTurnsPerBot,
        1,
        ROUTING_LIMITS.maxTurnsPerBot,
        BOT_ROUTING_DEFAULTS.maxTurnsPerBot
      ),
    },
    pinned: value.pinned === true,
    sessions,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    version: Number.isSafeInteger(value.version) ? (value.version as number) : 0,
  };
  if (isTime(value.archivedAt)) chat.archivedAt = value.archivedAt;
  return chat;
}

export function parseGroupEntry(value: unknown): GroupEntry | undefined {
  if (!isObject(value) || !isSeq(value.seq) || !isText(value.id) || !isTime(value.at))
    return undefined;
  const base = { seq: value.seq, id: value.id, at: value.at };
  switch (value.kind) {
    case 'human':
      return typeof value.text === 'string'
        ? { ...base, kind: 'human', text: value.text, mentions: strings(value.mentions) }
        : undefined;
    case 'bot':
      return isBotId(value.botId) &&
        typeof value.text === 'string' &&
        isText(value.conversationId) &&
        isText(value.turnId)
        ? {
            ...base,
            kind: 'bot',
            botId: value.botId,
            text: value.text,
            conversationId: value.conversationId,
            turnId: value.turnId,
            ...(value.routedBy === 'smart' ? { routedBy: 'smart' as const } : {}),
          }
        : undefined;
    case 'delegation': {
      if (
        !isText(value.delegationId) ||
        !isBotId(value.from) ||
        !isBotId(value.to) ||
        !DELEGATION_STATES.includes(value.state as DelegationState)
      ) {
        return undefined;
      }
      const entry: GroupEntry = {
        ...base,
        kind: 'delegation',
        delegationId: value.delegationId,
        from: value.from,
        to: value.to,
        state: value.state as DelegationState,
      };
      if (typeof value.summary === 'string') entry.summary = value.summary;
      return entry;
    }
    case 'system':
      return typeof value.text === 'string'
        ? { ...base, kind: 'system', text: value.text }
        : undefined;
    default:
      return undefined;
  }
}

export const BOT_ROUTINE_RESULTS = ['ok', 'error', 'skipped'] as const;
export type BotRoutineResult = (typeof BOT_ROUTINE_RESULTS)[number];

/** userData/bots/<botId>/routines.json 的一条；触发后作为系统消息投进 chatId */
export interface BotRoutine {
  id: string;
  botId: BotId;
  title: string;
  prompt: string;
  /** 5 段 cron，本地时区 */
  schedule: string;
  chatId: BotChatId;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastResult?: BotRoutineResult;
  /** 应用未运行期间错过的次数（不补跑，只展示），截断到 99 */
  missed?: number;
}

export function parseBotRoutine(value: unknown): BotRoutine | undefined {
  if (!isObject(value) || !isBotId(value.id) || !isBotId(value.botId)) return undefined;
  if (!isBotChatId(value.chatId) || typeof value.enabled !== 'boolean') return undefined;
  if (!isText(value.title) || !isText(value.prompt) || typeof value.schedule !== 'string') {
    return undefined;
  }
  const cron = parseCron(value.schedule);
  if (!cron || !isTime(value.createdAt) || !isTime(value.updatedAt)) return undefined;
  const routine: BotRoutine = {
    id: value.id,
    botId: value.botId,
    title: value.title,
    prompt: value.prompt,
    schedule: cron.source,
    chatId: value.chatId,
    enabled: value.enabled,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (isTime(value.lastRunAt)) routine.lastRunAt = value.lastRunAt;
  if (BOT_ROUTINE_RESULTS.includes(value.lastResult as BotRoutineResult)) {
    routine.lastResult = value.lastResult as BotRoutineResult;
  }
  if (isSeq(value.missed) && value.missed > 0)
    routine.missed = Math.min(MISSED_RUNS_MAX, value.missed);
  return routine;
}
