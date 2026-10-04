import type { CharacterRole, CircleCrop } from '@shared/characterCard';
import type { EnsobotActivity } from '@shared/ensobot/activity';
import { mentionSpans } from '@shared/ensobot/rooms';
import type { EnsobotSnapshot } from '@shared/ensobot/snapshot';
import { applyEnsobotSnapshot } from '@shared/ensobot/snapshot';

export function mergeNodeSnapshot(
  current: Record<string, EnsobotSnapshot>,
  nodeId: string,
  next: EnsobotSnapshot
): Record<string, EnsobotSnapshot> {
  const snapshot = applyEnsobotSnapshot(current[nodeId] ?? null, next);
  return snapshot === current[nodeId] ? current : { ...current, [nodeId]: snapshot };
}

export type ChatSelection = { kind: 'dm'; cardId: string } | { kind: 'room'; roomId: string };

/** 把正文切成普通段和 @名字 段，界面据此高亮点名（Markdown 文本节点里也用这一份）。 */
export function mentionSegments(
  text: string,
  members: readonly { id: string; name: string }[]
): { text: string; mention: boolean }[] {
  if (!text) return [];
  const spans = members.length ? mentionSpans(text, members) : [];
  const segments: { text: string; mention: boolean }[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor)
      segments.push({ text: text.slice(cursor, span.start), mention: false });
    segments.push({ text: text.slice(span.start, span.end), mention: true });
    cursor = span.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), mention: false });
  return segments;
}

export type MemberStatusKind =
  | 'approval'
  | 'ask'
  | 'retrying'
  | 'tool'
  | 'typing'
  | 'thinking'
  | 'queued'
  | 'task'
  | 'idle';

export interface MemberStatus {
  kind: MemberStatusKind;
  /** tool：正在跑的工具名。 */
  tool?: string;
  /** tool：参数摘要；task：任务标题。 */
  detail?: string;
  queued: number;
  activity?: EnsobotActivity;
}

/** 一个成员此刻在干嘛。要人拍板的事排最前，其次是活轮，再是后台任务。 */
export function memberStatus(snapshot: EnsobotSnapshot, cardId: string): MemberStatus {
  const activity = snapshot.activity?.find((item) => item.cardId === cardId);
  const queued = activity?.queued ?? 0;
  const pendingHuman = snapshot.interactions?.find(
    (item) => item.cardId === cardId && !item.responding
  );
  if (pendingHuman) {
    return { kind: pendingHuman.kind === 'approval' ? 'approval' : 'ask', queued, activity };
  }
  if (activity) {
    if (activity.state === 'tool') {
      const step = activity.steps.findLast((item) => item.status === 'running');
      return { kind: 'tool', tool: step?.name, detail: step?.summary, queued, activity };
    }
    return { kind: activity.state, queued, activity };
  }
  const task = snapshot.tasks.find(
    (item) => item.cardId === cardId && (item.status === 'doing' || item.status === 'claimed')
  );
  if (task) return { kind: 'task', detail: task.title, queued };
  return { kind: 'idle', queued };
}

/** 正在当前聊天面上干活的成员：群只看这个群，私聊只看这张卡的私聊面。 */
export function surfaceActivity(
  snapshot: EnsobotSnapshot,
  selection: ChatSelection
): EnsobotActivity[] {
  return (snapshot.activity ?? []).filter((item) =>
    selection.kind === 'room'
      ? item.surface === 'room' && item.roomId === selection.roomId
      : item.surface === 'chat' && item.cardId === selection.cardId
  );
}

/** 群列表用相同的成员状态口径，人工阻塞不能计作正在工作。 */
export function roomActivityCounts(snapshot: EnsobotSnapshot | null, roomId: string) {
  const counts = { waiting: 0, working: 0, queued: 0 };
  if (!snapshot) return counts;
  for (const activity of surfaceActivity(snapshot, { kind: 'room', roomId })) {
    const status = memberStatus(snapshot, activity.cardId).kind;
    if (status === 'approval' || status === 'ask') counts.waiting += 1;
    else if (status === 'queued') counts.queued += 1;
    else counts.working += 1;
  }
  return counts;
}

/** 当前聊天面上正在干活的人发来的审批/提问，就地显示在他的进度下面，顶部不再重复。 */
export function inlineInteractionIds(
  snapshot: EnsobotSnapshot,
  selection: ChatSelection | null
): Set<string> {
  if (!selection) return new Set();
  const working = new Set(
    surfaceActivity(snapshot, selection)
      .filter((item) => item.state !== 'queued')
      .map((item) => item.cardId)
  );
  return new Set(
    (snapshot.interactions ?? []).filter((item) => working.has(item.cardId)).map((item) => item.id)
  );
}

/** 独立窗口只读目录，不为下拉列表实例化可写的主窗口会话 store。 */
export function parseWorkspaceSessions(
  value: unknown
): { id: string; title: string; projectId: string }[] {
  const record = (input: unknown): Record<string, unknown> | null =>
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;
  const stored = record(record(value)?.['enso-conversations']);
  const conversations = record(record(stored?.state)?.conversations);
  return Object.values(conversations ?? {}).flatMap((value) => {
    const item = record(value);
    if (
      !item ||
      typeof item.id !== 'string' ||
      typeof item.projectId !== 'string' ||
      item.parentId ||
      item.btwParentId ||
      item.archived === true
    )
      return [];
    return [
      {
        id: item.id,
        projectId: item.projectId,
        title: typeof item.title === 'string' ? item.title : item.id,
      },
    ];
  });
}

/** 保持仍存在的会话，否则选择一个可用会话。 */
export function reconcileChat(
  current: ChatSelection | null,
  snapshot: Pick<EnsobotSnapshot, 'cards' | 'groups'>
): ChatSelection | null {
  if (current?.kind === 'dm' && snapshot.cards.some((card) => card.id === current.cardId)) {
    return current;
  }
  if (current?.kind === 'room' && snapshot.groups.some((room) => room.id === current.roomId)) {
    return current;
  }
  const first = snapshot.cards[0];
  if (first) return { kind: 'dm', cardId: first.id };
  const room = snapshot.groups[0];
  return room ? { kind: 'room', roomId: room.id } : null;
}

export function lastPreview(messages: readonly { text: string; seq: number }[]): string {
  const latest = messages
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .at(-1);
  return latest ? plainText(latest.text).replace(/\s+/g, ' ').trim().slice(0, 48) : '';
}

/** bot 回复按 Markdown 渲染；一行预览里只留字，不显示 **、`、# 这些记号。 */
function plainText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, ''))
    .join('\n')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
}

export function placeCrop(
  current: CircleCrop | null,
  width: number,
  height: number,
  next: Partial<CircleCrop>
): CircleCrop {
  const limit = Math.max(1, Math.min(width, height) / 2);
  const r = clamp(next.r ?? current?.r ?? Math.min(width, height) / 4, 1, limit);
  const cx = clamp(next.cx ?? current?.cx ?? width / 2, r, Math.max(r, width - r));
  const cy = clamp(next.cy ?? current?.cy ?? height / 2, r, Math.max(r, height - r));
  return { cx, cy, r };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function normalizeRole(role: CharacterRole): CharacterRole {
  return { ...role, concurrency: Math.max(1, Math.min(32, Math.round(role.concurrency) || 1)) };
}
