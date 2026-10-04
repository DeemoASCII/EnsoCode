import {
  APPROVAL_MODES,
  type ApprovalMode,
  type AttachedImage,
  isDeliveryId,
  THINKING_LEVELS,
  type ThinkingLevel,
} from '@shared/types/agent';
import {
  BOT_ROUTING_MODES,
  type BotChat,
  type BotList,
  type BotRoutingMode,
  isBotId,
} from '@shared/types/bot';
import type { BotChatUpdateInput, BotChatWorkspaceInput } from '@shared/types/botIpc';
import type { BotDraft } from '../services/bots/botStore';

type Rec = Record<string, unknown>;

const MAX = { short: 200, scope: 2_000, persona: 200_000, ids: 500 } as const;

const record = (value: unknown): Rec | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
const onlyKeys = (value: Rec, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const seq = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.length <= MAX.ids &&
    value.every((item) => nonEmpty(item) && item.length <= MAX.short)
    ? (value as string[])
    : null;
}

function botList(value: unknown): BotList | null {
  if (value === 'any') return 'any';
  return Array.isArray(value) && value.length <= MAX.ids && value.every(isBotId)
    ? (value as string[])
    : null;
}

const DRAFT_KEYS = [
  'name',
  'title',
  'scope',
  'avatar',
  'engine',
  'approvalMode',
  'tools',
  'skillIds',
  'mcpServerIds',
  'delegation',
  'memory',
  'persona',
] as const;

export function parseBotDraftInput(value: unknown): BotDraft | null {
  const input = record(value);
  if (!input || !onlyKeys(input, DRAFT_KEYS)) return null;
  const draft: BotDraft = {};
  for (const key of ['name', 'title'] as const) {
    if (input[key] === undefined) continue;
    if (!text(input[key], MAX.short)) return null;
    draft[key] = input[key];
  }
  if (input.scope !== undefined) {
    if (!text(input.scope, MAX.scope)) return null;
    draft.scope = input.scope;
  }
  if (input.persona !== undefined) {
    if (!text(input.persona, MAX.persona)) return null;
    draft.persona = input.persona;
  }
  if (input.avatar !== undefined) {
    const avatar = record(input.avatar);
    if (!avatar || !onlyKeys(avatar, ['color']) || !text(avatar.color, 16)) return null;
    draft.avatar = { color: avatar.color };
  }
  if (input.engine !== undefined) {
    if (input.engine === null) draft.engine = undefined;
    else {
      const engine = record(input.engine);
      if (
        !engine ||
        !onlyKeys(engine, ['providerId', 'modelId', 'thinkingLevel']) ||
        !nonEmpty(engine.providerId) ||
        !nonEmpty(engine.modelId) ||
        (engine.thinkingLevel !== undefined &&
          !THINKING_LEVELS.includes(engine.thinkingLevel as ThinkingLevel))
      ) {
        return null;
      }
      draft.engine = {
        providerId: engine.providerId,
        modelId: engine.modelId,
        ...(engine.thinkingLevel ? { thinkingLevel: engine.thinkingLevel as ThinkingLevel } : {}),
      };
    }
  }
  if (input.approvalMode !== undefined) {
    if (!APPROVAL_MODES.includes(input.approvalMode as ApprovalMode)) return null;
    draft.approvalMode = input.approvalMode as ApprovalMode;
  }
  if (input.tools !== undefined) {
    if (input.tools !== 'all' && input.tools !== 'readonly') return null;
    draft.tools = input.tools;
  }
  for (const key of ['skillIds', 'mcpServerIds'] as const) {
    if (input[key] === undefined) continue;
    const list = stringList(input[key]);
    if (!list) return null;
    draft[key] = list;
  }
  if (input.delegation !== undefined) {
    const delegation = record(input.delegation);
    const canDelegateTo = botList(delegation?.canDelegateTo);
    const acceptFrom = botList(delegation?.acceptFrom);
    if (!delegation || !onlyKeys(delegation, ['canDelegateTo', 'acceptFrom'])) return null;
    if (!canDelegateTo || !acceptFrom) return null;
    draft.delegation = { canDelegateTo, acceptFrom };
  }
  if (input.memory !== undefined) {
    const memory = record(input.memory);
    if (!memory || !onlyKeys(memory, ['enabled']) || typeof memory.enabled !== 'boolean') {
      return null;
    }
    draft.memory = { enabled: memory.enabled };
  }
  return draft;
}

export function parseBotUpdateInput(
  value: unknown
): { botId: string; expectedVersion?: number; draft: BotDraft } | null {
  const input = record(value);
  if (!input || !onlyKeys(input, ['botId', 'expectedVersion', 'draft']) || !isBotId(input.botId)) {
    return null;
  }
  if (input.expectedVersion !== undefined && !seq(input.expectedVersion)) return null;
  const draft = parseBotDraftInput(input.draft);
  if (!draft) return null;
  return {
    botId: input.botId,
    ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
    draft,
  };
}

export type ChatWorkspaceInput = BotChatWorkspaceInput;

function parseWorkspaceInput(value: unknown): ChatWorkspaceInput | null {
  const input = record(value);
  if (!input) return null;
  if (input.kind === 'member-home' || input.kind === 'chat-home') {
    return onlyKeys(input, ['kind']) ? { kind: input.kind } : null;
  }
  return input.kind === 'project' &&
    onlyKeys(input, ['kind', 'projectId']) &&
    isBotId(input.projectId)
    ? { kind: 'project', projectId: input.projectId }
    : null;
}

function parseRouting(value: unknown): Partial<BotChat['routing']> | null {
  const input = record(value);
  if (!input || !onlyKeys(input, ['mode', 'maxHops', 'maxTurnsPerBot'])) return null;
  const routing: Partial<BotChat['routing']> = {};
  if (input.mode !== undefined) {
    if (!BOT_ROUTING_MODES.includes(input.mode as BotRoutingMode)) return null;
    routing.mode = input.mode as BotRoutingMode;
  }
  for (const key of ['maxHops', 'maxTurnsPerBot'] as const) {
    if (input[key] === undefined) continue;
    if (!seq(input[key])) return null;
    routing[key] = input[key];
  }
  return routing;
}

export interface ChatCreateInput {
  kind: BotChat['kind'];
  title: string;
  members: string[];
  bossBotId: string | null;
  workspace: ChatWorkspaceInput;
  routing?: Partial<BotChat['routing']>;
}

export function parseChatCreateInput(value: unknown): ChatCreateInput | null {
  const input = record(value);
  if (
    !input ||
    !onlyKeys(input, ['kind', 'title', 'members', 'bossBotId', 'workspace', 'routing']) ||
    (input.kind !== 'direct' && input.kind !== 'group') ||
    (input.title !== undefined && !text(input.title, MAX.short)) ||
    !Array.isArray(input.members) ||
    input.members.length > MAX.ids ||
    !input.members.every(isBotId) ||
    (input.bossBotId !== undefined && input.bossBotId !== null && !isBotId(input.bossBotId))
  ) {
    return null;
  }
  const workspace = parseWorkspaceInput(input.workspace);
  const routing = input.routing === undefined ? undefined : parseRouting(input.routing);
  if (!workspace || routing === null) return null;
  return {
    kind: input.kind,
    title: (input.title as string | undefined) ?? '',
    members: input.members as string[],
    bossBotId: (input.bossBotId as string | null | undefined) ?? null,
    workspace,
    ...(routing ? { routing } : {}),
  };
}

export type ChatUpdateInput = BotChatUpdateInput;

export function parseChatUpdateInput(value: unknown): ChatUpdateInput | null {
  const input = record(value);
  const keys = [
    'chatId',
    'expectedVersion',
    'title',
    'pinned',
    'archived',
    'members',
    'bossBotId',
    'routing',
    'workspace',
  ];
  if (!input || !onlyKeys(input, keys) || !isBotId(input.chatId)) return null;
  const result: ChatUpdateInput = { chatId: input.chatId };
  if (input.expectedVersion !== undefined) {
    if (!seq(input.expectedVersion)) return null;
    result.expectedVersion = input.expectedVersion;
  }
  if (input.title !== undefined) {
    if (!text(input.title, MAX.short)) return null;
    result.title = input.title;
  }
  for (const key of ['pinned', 'archived'] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') return null;
    result[key] = input[key];
  }
  if (input.members !== undefined) {
    if (
      !Array.isArray(input.members) ||
      input.members.length > MAX.ids ||
      !input.members.every(isBotId)
    ) {
      return null;
    }
    result.members = input.members as string[];
  }
  if (input.bossBotId !== undefined) {
    if (input.bossBotId !== null && !isBotId(input.bossBotId)) return null;
    result.bossBotId = input.bossBotId;
  }
  if (input.routing !== undefined) {
    const routing = parseRouting(input.routing);
    if (!routing) return null;
    result.routing = routing;
  }
  if (input.workspace !== undefined) {
    const workspace = parseWorkspaceInput(input.workspace);
    if (!workspace) return null;
    result.workspace = workspace;
  }
  return result;
}

function parseImages(value: unknown): AttachedImage[] | null {
  if (!Array.isArray(value) || value.length > 20) return null;
  const images: AttachedImage[] = [];
  for (const item of value) {
    const image = record(item);
    if (!image || !nonEmpty(image.data) || !nonEmpty(image.mimeType)) return null;
    images.push({ data: image.data, mimeType: image.mimeType });
  }
  return images;
}

export function parseSendInput(
  value: unknown
): { chatId: string; text: string; images?: AttachedImage[]; deliveryId: string } | null {
  const input = record(value);
  if (
    !input ||
    !onlyKeys(input, ['chatId', 'text', 'images', 'deliveryId']) ||
    !isBotId(input.chatId) ||
    typeof input.text !== 'string' ||
    !isDeliveryId(input.deliveryId)
  ) {
    return null;
  }
  const images = input.images === undefined ? undefined : parseImages(input.images);
  if (images === null) return null;
  if (!input.text.trim() && !images?.length) return null;
  return {
    chatId: input.chatId,
    text: input.text,
    ...(images?.length ? { images } : {}),
    deliveryId: input.deliveryId,
  };
}

export function parseTimelineInput(
  value: unknown
): { chatId: string; beforeSeq?: number; limit: number } | null {
  const input = record(value);
  if (!input || !onlyKeys(input, ['chatId', 'beforeSeq', 'limit']) || !isBotId(input.chatId)) {
    return null;
  }
  if (input.beforeSeq !== undefined && !seq(input.beforeSeq)) return null;
  if (input.limit !== undefined && !seq(input.limit)) return null;
  return {
    chatId: input.chatId,
    ...(input.beforeSeq !== undefined ? { beforeSeq: input.beforeSeq } : {}),
    limit: Math.min(200, Math.max(1, (input.limit as number | undefined) ?? 100)),
  };
}

export function parseOpenWorkspaceInput(
  value: unknown
): { chatId: string } | { botId: string } | null {
  const input = record(value);
  if (!input) return null;
  if (onlyKeys(input, ['chatId']) && isBotId(input.chatId)) return { chatId: input.chatId };
  if (onlyKeys(input, ['botId']) && isBotId(input.botId)) return { botId: input.botId };
  return null;
}

export function parseSessionHistoryInput(
  value: unknown
): { conversationId: string; beforeIndex?: number } | null {
  const input = record(value);
  if (
    !input ||
    !onlyKeys(input, ['conversationId', 'beforeIndex']) ||
    !isBotId(input.conversationId) ||
    (input.beforeIndex !== undefined && !seq(input.beforeIndex))
  ) {
    return null;
  }
  return {
    conversationId: input.conversationId,
    ...(input.beforeIndex !== undefined ? { beforeIndex: input.beforeIndex } : {}),
  };
}
