import { isCharacterCardId } from '../characterCard';

export interface EnsobotRoom {
  id: string;
  name: string;
  memberIds: string[];
}

export interface RoomMember {
  id: string;
  name: string;
}

const NAME_MAX = 80;

function isBoundary(text: string, index: number): boolean {
  if (index >= text.length) return true;
  return /[\s@,，。.!！?？:：;；、]/.test(text[index] ?? '');
}

/** 从群消息里认出 @名字。@everyone / @所有人 展开成逐个成员，不是一条群发。 */
export function mentionsInText(text: string, members: readonly RoomMember[]): string[] {
  const named = members
    .filter((member) => member.name.trim().length > 0)
    .slice()
    .sort((a, b) => b.name.length - a.name.length);
  const hits: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    hits.push(id);
  };
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '@') continue;
    const rest = text.slice(index + 1);
    const everyone =
      rest.startsWith('everyone') && isBoundary(text, index + 1 + 'everyone'.length)
        ? 'everyone'
        : rest.startsWith('所有人') && isBoundary(text, index + 1 + '所有人'.length)
          ? '所有人'
          : null;
    if (everyone) {
      for (const member of members) add(member.id);
      index += everyone.length;
      continue;
    }
    const match = named.find(
      (member) => rest.startsWith(member.name) && isBoundary(text, index + 1 + member.name.length)
    );
    if (!match) continue;
    add(match.id);
    index += match.name.length;
  }
  return hits;
}

export function planRoom(input: {
  id: string;
  name: string;
  memberIds: readonly string[];
  knownIds: readonly string[];
}):
  | { ok: true; room: EnsobotRoom }
  | { ok: false; error: 'bad-id' | 'empty-name' | 'name-too-long' | 'too-few' | 'unknown-member' } {
  if (!isCharacterCardId(input.id)) return { ok: false, error: 'bad-id' };
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'empty-name' };
  if (name.length > NAME_MAX) return { ok: false, error: 'name-too-long' };
  const known = new Set(input.knownIds);
  const memberIds: string[] = [];
  const seen = new Set<string>();
  for (const id of input.memberIds) {
    if (!isCharacterCardId(id) || !known.has(id)) return { ok: false, error: 'unknown-member' };
    if (seen.has(id)) continue;
    seen.add(id);
    memberIds.push(id);
  }
  if (memberIds.length < 2) return { ok: false, error: 'too-few' };
  return { ok: true, room: { id: input.id, name, memberIds } };
}

function narrowRoom(value: unknown): EnsobotRoom | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!isCharacterCardId(item.id) || typeof item.name !== 'string') return null;
  const name = item.name.trim();
  if (!name || name.length > NAME_MAX || !Array.isArray(item.memberIds)) return null;
  const memberIds: string[] = [];
  const seen = new Set<string>();
  for (const id of item.memberIds) {
    if (!isCharacterCardId(id)) return null;
    if (seen.has(id)) continue;
    seen.add(id);
    memberIds.push(id);
  }
  if (memberIds.length < 2) return null;
  return { id: item.id, name, memberIds };
}

/** 坏掉的一条群记录跳过，不让整份名单作废。 */
export function parseRoomDocument(text: string): EnsobotRoom[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rooms: EnsobotRoom[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    const room = narrowRoom(item);
    if (!room || seen.has(room.id)) continue;
    seen.add(room.id);
    rooms.push(room);
  }
  return rooms;
}
