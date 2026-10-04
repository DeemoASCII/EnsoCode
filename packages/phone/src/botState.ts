import type {
  HostToPhone,
  PairBotChatSummary,
  PairBotInboxItem,
  PairBotMember,
  PairGroupEntry,
} from '@enso/pair';
import { mentionCandidates } from '@shared/bots/mentions';
import { BOT_MENTION_ALL, botNameKey } from '@shared/types/bot';

/** 手机 Bot 模式的纯逻辑：抽屉排序、群时间线分页合并、@ 补全 */

const byRecent = (a: PairBotChatSummary, b: PairBotChatSummary): number =>
  Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt;

export function botChatSections(
  chats: readonly PairBotChatSummary[],
  bots: readonly PairBotMember[]
): { groups: PairBotChatSummary[]; directs: PairBotChatSummary[] } {
  const active = new Set(bots.filter((bot) => !bot.archived).map((bot) => bot.id));
  return {
    groups: chats.filter((chat) => chat.kind === 'group').sort(byRecent),
    directs: chats
      .filter((chat) => chat.kind === 'direct' && active.has(chat.members[0]))
      .sort(byRecent),
  };
}

export interface GroupTimelineState {
  entries: PairGroupEntry[];
  lastSeq: number;
  hasOlder: boolean;
}

type GroupTimelineFrame = Extract<HostToPhone, { type: 'group-timeline' }>;

export function mergeGroupTimeline(
  current: GroupTimelineState | undefined,
  frame: GroupTimelineFrame
): GroupTimelineState {
  const incoming: GroupTimelineState = {
    entries: [...frame.entries].sort((a, b) => a.seq - b.seq),
    lastSeq: frame.lastSeq,
    hasOlder: frame.hasOlder,
  };
  if (!current || current.entries.length === 0) return incoming;
  const first = current.entries[0].seq;
  if (frame.beforeSeq !== undefined) {
    // 换过最新页或重复请求的迟到应答：与当前最早条目不衔接就丢弃
    if (frame.beforeSeq !== first) return current;
  } else {
    const last = current.entries.at(-1)?.seq ?? 0;
    if ((incoming.entries[0]?.seq ?? last + 1) > last + 1) return incoming;
  }
  const bySeq = new Map(current.entries.map((entry) => [entry.seq, entry]));
  for (const entry of incoming.entries) bySeq.set(entry.seq, entry);
  const entries = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const olderFromIncoming = (incoming.entries[0]?.seq ?? Number.POSITIVE_INFINITY) < first;
  return {
    entries,
    lastSeq: Math.max(current.lastSeq, incoming.lastSeq),
    hasOlder: olderFromIncoming ? incoming.hasOlder : current.hasOlder,
  };
}

/** @ 前紧挨着这些字符时视为邮箱等，不触发补全（与 parseMentions 同规则） */
const EMAIL_LOCAL_RE = /[A-Za-z0-9._%+-]/;

export function activeMention(
  text: string,
  caret: number
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf('@');
  if (start < 0) return null;
  if (start > 0 && EMAIL_LOCAL_RE.test(before[start - 1])) return null;
  const query = before.slice(start + 1);
  return /\s/.test(query) ? null : { start, query };
}

export interface MentionOption {
  id: string;
  name: string;
}

export const MENTION_ALL_ID = '__all__';

export function mentionOptions(query: string, members: readonly MentionOption[]): MentionOption[] {
  const all = BOT_MENTION_ALL[0];
  const key = botNameKey(query.replace(/^@/, ''));
  const everyone = botNameKey(all).startsWith(key) ? [{ id: MENTION_ALL_ID, name: all }] : [];
  return [...everyone, ...mentionCandidates(query, members).map(({ id, name }) => ({ id, name }))];
}

export function insertMention(
  text: string,
  mention: { start: number; query: string },
  caret: number,
  name: string
): { text: string; caret: number } {
  const inserted = `@${name} `;
  return {
    text: text.slice(0, mention.start) + inserted + text.slice(caret),
    caret: mention.start + inserted.length,
  };
}

const INBOX_LABELS: Record<Exclude<PairBotInboxItem['kind'], 'silence'>, string> = {
  approval: '需要审批',
  ask: '等你回答',
  'delegation-interrupted': '委派中断',
  budget: '今日预算已用完',
  'routine-draft': '例行任务待批准',
  'routine-blocked': '例行任务被阻塞',
};

/** 收件箱条目标签；静默按 now 算已安静秒数 */
export function inboxLabel(item: PairBotInboxItem, now: number): string {
  if (item.kind !== 'silence') return INBOX_LABELS[item.kind];
  return `已安静 ${Math.max(0, Math.floor((now - (item.since ?? now)) / 1000))} 秒`;
}
