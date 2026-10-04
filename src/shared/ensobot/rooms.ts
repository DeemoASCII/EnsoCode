import { isCharacterCardId } from '../characterCard';

export interface EnsobotRoom {
  id: string;
  name: string;
  memberIds: string[];
  /** 主持人：没点名的人话先交给他。缺省时按协调者/第一个成员推定，旧群不用迁移。 */
  hostId?: string;
  /** 一条人话引出的讨论里 bot 之间最多互相叫醒几次。缺省用默认值。 */
  relayLimit?: number;
}

export interface RoomMember {
  id: string;
  name: string;
}

const NAME_MAX = 80;
export const RELAY_LIMIT_MAX = 50;

function validLimit(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= RELAY_LIMIT_MAX
  );
}

function isBoundary(text: string, index: number): boolean {
  if (index >= text.length) return true;
  return /[\s@,，。.!！?？:：;；、]/.test(text[index] ?? '');
}

/** 「saki酱 (PM)」这类带职位括号的名字，允许用括号前的短名点到。 */
function aliasOf(name: string): string {
  return name.replace(/\s*[（(【[][^（()）【】[\]]*[)）】\]]\s*$/u, '').trim();
}

/** 每个 @名字 在原文里的位置和指向的人。@everyone / @所有人 指向每个成员。 */
export function mentionSpans(
  text: string,
  members: readonly RoomMember[]
): { start: number; end: number; ids: string[] }[] {
  const named = members
    .flatMap((member) => {
      const name = member.name.trim();
      if (!name) return [];
      const alias = aliasOf(name);
      return alias && alias !== name
        ? [
            { id: member.id, name },
            { id: member.id, name: alias },
          ]
        : [{ id: member.id, name }];
    })
    .sort((a, b) => b.name.length - a.name.length);
  const spans: { start: number; end: number; ids: string[] }[] = [];
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
      spans.push({
        start: index,
        end: index + 1 + everyone.length,
        ids: members.map((member) => member.id),
      });
      index += everyone.length;
      continue;
    }
    const match = named.find(
      (member) => rest.startsWith(member.name) && isBoundary(text, index + 1 + member.name.length)
    );
    if (!match) continue;
    spans.push({ start: index, end: index + 1 + match.name.length, ids: [match.id] });
    index += match.name.length;
  }
  return spans;
}

/** 从群消息里认出 @名字。@everyone / @所有人 展开成逐个成员，不是一条群发。 */
export function mentionsInText(text: string, members: readonly RoomMember[]): string[] {
  const hits: string[] = [];
  for (const span of mentionSpans(text, members)) {
    for (const id of span.ids) if (!hits.includes(id)) hits.push(id);
  }
  return hits;
}

export function planRoom(input: {
  id: string;
  name: string;
  memberIds: readonly string[];
  hostId?: string;
  relayLimit?: number;
  knownIds: readonly string[];
}):
  | { ok: true; room: EnsobotRoom }
  | {
      ok: false;
      error:
        | 'bad-id'
        | 'empty-name'
        | 'name-too-long'
        | 'too-few'
        | 'unknown-member'
        | 'bad-host'
        | 'bad-limit';
    } {
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
  if (input.hostId !== undefined && !memberIds.includes(input.hostId)) {
    return { ok: false, error: 'bad-host' };
  }
  if (input.relayLimit !== undefined && !validLimit(input.relayLimit)) {
    return { ok: false, error: 'bad-limit' };
  }
  return {
    ok: true,
    room: {
      id: input.id,
      name,
      memberIds,
      ...(input.hostId ? { hostId: input.hostId } : {}),
      ...(input.relayLimit !== undefined ? { relayLimit: input.relayLimit } : {}),
    },
  };
}

/** 建群后改主持人或接力上限。null 表示回到默认；不传的字段保持不变。 */
export function planRoomUpdate(
  room: EnsobotRoom,
  patch: { hostId?: string | null; relayLimit?: number | null }
): { ok: true; room: EnsobotRoom } | { ok: false; error: 'bad-host' | 'bad-limit' } {
  if (typeof patch.hostId === 'string' && !room.memberIds.includes(patch.hostId)) {
    return { ok: false, error: 'bad-host' };
  }
  if (typeof patch.relayLimit === 'number' && !validLimit(patch.relayLimit)) {
    return { ok: false, error: 'bad-limit' };
  }
  const next: EnsobotRoom = { id: room.id, name: room.name, memberIds: [...room.memberIds] };
  const hostId = patch.hostId === undefined ? room.hostId : (patch.hostId ?? undefined);
  const relayLimit =
    patch.relayLimit === undefined ? room.relayLimit : (patch.relayLimit ?? undefined);
  if (hostId) next.hostId = hostId;
  if (relayLimit !== undefined) next.relayLimit = relayLimit;
  return { ok: true, room: next };
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
  const hostId =
    typeof item.hostId === 'string' && memberIds.includes(item.hostId) ? item.hostId : undefined;
  return {
    id: item.id,
    name,
    memberIds,
    ...(hostId ? { hostId } : {}),
    ...(validLimit(item.relayLimit) ? { relayLimit: item.relayLimit } : {}),
  };
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
