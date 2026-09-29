import type { CharacterRole, CircleCrop } from '@shared/characterCard';
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
  return latest ? latest.text.replace(/\s+/g, ' ').slice(0, 48) : '';
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
