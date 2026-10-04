import type {
  HostToPhone,
  PairBotChatSummary,
  PairBotMember,
  PairBotRunState,
  PairGroupEntry,
} from '@enso/pair';
import type { BotChat, BotProfile, GroupEntry } from '@shared/types/bot';

/** Bot 模式下行帧的纯投影：只放展示字段，人设/模型/权限配置不出 Main */

const LAST_TEXT_MAX = 120;
export const GROUP_TIMELINE_MAX_JSON_BYTES = 850_000;

type GroupTimelineFrame = Extract<HostToPhone, { type: 'group-timeline' }>;

export function toPairBotMember(bot: BotProfile, status: PairBotRunState): PairBotMember {
  return {
    id: bot.id,
    name: bot.name,
    title: bot.title,
    avatarColor: bot.avatar.color,
    ...(bot.archivedAt !== undefined ? { archived: true as const } : {}),
    status,
  };
}

function entryText(entry: GroupEntry): string {
  if (entry.kind === 'delegation') return entry.summary ?? '';
  return entry.text;
}

export function summarizeBotChat(
  chat: BotChat,
  last: GroupEntry | undefined,
  lastSeq: number,
  status: PairBotRunState
): PairBotChatSummary {
  const sessions: PairBotChatSummary['sessions'] = {};
  for (const [botId, session] of Object.entries(chat.sessions)) {
    sessions[botId] = { conversationId: session.conversationId };
  }
  const botId =
    last?.kind === 'bot' ? last.botId : last?.kind === 'delegation' ? last.from : undefined;
  return {
    id: chat.id,
    kind: chat.kind,
    title: chat.title,
    members: [...chat.members],
    bossBotId: chat.bossBotId,
    ...(chat.pinned ? { pinned: true as const } : {}),
    ...(chat.archivedAt !== undefined ? { archived: true as const } : {}),
    updatedAt: Math.max(chat.updatedAt, last?.at ?? 0),
    lastSeq,
    ...(last
      ? {
          last: {
            kind: last.kind,
            text: entryText(last).replace(/\s+/g, ' ').trim().slice(0, LAST_TEXT_MAX),
            ...(botId ? { botId } : {}),
            at: last.at,
          },
        }
      : {}),
    sessions,
    status,
  };
}

const frameBytes = (frame: GroupTimelineFrame): number =>
  Buffer.byteLength(JSON.stringify(frame), 'utf8');

function truncateEntry(entry: PairGroupEntry, chars: number): PairGroupEntry {
  if (entry.kind === 'delegation') {
    return entry.summary === undefined
      ? entry
      : { ...entry, summary: entry.summary.slice(0, chars) };
  }
  return { ...entry, text: entry.text.slice(0, chars) };
}

/** 单帧须小于中继上限：从最旧一端减条数；只剩一条仍超限则截断其正文 */
export function fitGroupTimelineFrame(
  frame: GroupTimelineFrame,
  maxBytes: number = GROUP_TIMELINE_MAX_JSON_BYTES
): GroupTimelineFrame {
  let next = frame;
  while (next.entries.length > 1 && frameBytes(next) >= maxBytes) {
    next = { ...next, entries: next.entries.slice(1), hasOlder: true };
  }
  if (next.entries.length === 1 && frameBytes(next) >= maxBytes) {
    const [entry] = next.entries;
    const length = entry.kind === 'delegation' ? (entry.summary?.length ?? 0) : entry.text.length;
    let chars = Math.max(0, length - (frameBytes(next) - maxBytes) - 1);
    let fitted = { ...next, entries: [truncateEntry(entry, chars)] };
    while (chars > 0 && frameBytes(fitted) >= maxBytes) {
      chars = Math.floor(chars / 2);
      fitted = { ...next, entries: [truncateEntry(entry, chars)] };
    }
    next = fitted;
  }
  return next;
}

export type BotSessionAccess = 'none' | 'deny' | 'live' | 'cold';

/**
 * 手机订阅某会话时的放行判断：Bot 会话不在 renderer 会话表里，
 * 只在 Bot 模式开启时放行，且由 Bot 层提供快照（worker 有投影走快照，否则读会话文件）。
 */
export function botSessionAccess(
  conversation: { bot?: unknown } | undefined,
  enabled: boolean,
  alive: boolean
): BotSessionAccess {
  if (!conversation?.bot) return 'none';
  if (!enabled) return 'deny';
  return alive ? 'live' : 'cold';
}
