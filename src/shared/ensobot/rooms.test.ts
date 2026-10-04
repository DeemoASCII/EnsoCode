import { describe, expect, it } from 'vitest';
import { decideBoardWake } from './board';
import {
  mentionSpans,
  mentionsInText,
  parseRoomDocument,
  planRoom,
  planRoomUpdate,
  RELAY_LIMIT_MAX,
} from './rooms';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ROOM = '33333333-3333-4333-8333-333333333333';

describe('ensobot rooms', () => {
  it('空名字、少于两个人、不认识的人，建不了群', () => {
    const known = [A, B];
    expect(planRoom({ id: ROOM, name: '  ', memberIds: [A, B], knownIds: known }).ok).toBe(false);
    expect(planRoom({ id: ROOM, name: '小队', memberIds: [A], knownIds: known })).toEqual({
      ok: false,
      error: 'too-few',
    });
    expect(planRoom({ id: ROOM, name: '小队', memberIds: [A, 'nope'], knownIds: known })).toEqual({
      ok: false,
      error: 'unknown-member',
    });
    expect(planRoom({ id: 'not-an-id', name: '小队', memberIds: [A, B], knownIds: known })).toEqual(
      {
        ok: false,
        error: 'bad-id',
      }
    );
    const made = planRoom({ id: ROOM, name: '  小队  ', memberIds: [A, B, A], knownIds: known });
    expect(made).toEqual({
      ok: true,
      room: { id: ROOM, name: '小队', memberIds: [A, B] },
    });
  });

  it('点名只认出 @名字，@everyone 仍是逐个点名而不是一条群发', () => {
    const members = [
      { id: A, name: '阿宁' },
      { id: B, name: '北北' },
    ];
    expect(mentionsInText('大家看看', members)).toEqual([]);
    expect(mentionsInText('@北北 看一下，@北北', members)).toEqual([B]);
    expect(mentionsInText('@阿宁@北北', members)).toEqual([A, B]);
    const everyone = mentionsInText('@everyone 开工', members);
    expect(everyone).toEqual([A, B]);
    expect(
      decideBoardWake({
        text: '@everyone 开工',
        mentions: everyone,
        knownIds: [A, B],
        facts: { taskChanged: false, humanAsked: true, idle: false },
      }).notify
    ).toEqual([A, B]);
    expect(mentionsInText('@所有人', members)).toEqual([A, B]);
    expect(mentionsInText('@everyonex', members)).toEqual([]);
  });

  it('带职位括号的名字也能用短名点到，最长的名字优先', () => {
    const members = [
      { id: A, name: 'saki酱 (PM)' },
      { id: B, name: 'saki' },
    ];
    expect(mentionsInText('@saki酱 (PM) 看看', members)).toEqual([A]);
    expect(mentionsInText('@saki酱 看看', members)).toEqual([A]);
    expect(mentionsInText('@saki 看看', members)).toEqual([B]);
    expect(mentionsInText('@saki酱（PM）', [{ id: A, name: 'saki酱（PM）' }])).toEqual([A]);
    expect(mentionsInText('@saki酱，你来', [{ id: A, name: 'saki酱【PM】' }])).toEqual([A]);
  });

  it('点名位置可用于高亮：给出每个 @名字 在原文里的范围', () => {
    const members = [
      { id: A, name: 'saki酱 (PM)' },
      { id: B, name: '北北' },
    ];
    const text = '好的 @北北 和 @saki酱 看一下，@所有人 注意';
    expect(
      mentionSpans(text, members).map((span) => [text.slice(span.start, span.end), span.ids])
    ).toEqual([
      ['@北北', [B]],
      ['@saki酱', [A]],
      ['@所有人', [A, B]],
    ]);
  });

  it('主持人必须是群成员；旧群没有主持人字段也能读', () => {
    const known = [A, B];
    expect(
      planRoom({ id: ROOM, name: '小队', memberIds: [A, B], hostId: B, knownIds: known })
    ).toEqual({ ok: true, room: { id: ROOM, name: '小队', memberIds: [A, B], hostId: B } });
    expect(
      planRoom({ id: ROOM, name: '小队', memberIds: [A, B], hostId: ROOM, knownIds: known })
    ).toEqual({ ok: false, error: 'bad-host' });
    const text = JSON.stringify([
      { id: ROOM, name: '小队', memberIds: [A, B], hostId: 'stranger' },
    ]);
    expect(parseRoomDocument(text)).toEqual([{ id: ROOM, name: '小队', memberIds: [A, B] }]);
    expect(
      parseRoomDocument(JSON.stringify([{ id: ROOM, name: '小队', memberIds: [A, B], hostId: B }]))
    ).toEqual([{ id: ROOM, name: '小队', memberIds: [A, B], hostId: B }]);
  });

  it('坏掉的群记录跳过，剩下的群还在', () => {
    const text = JSON.stringify([
      { id: 'bad', name: '坏', memberIds: [A, B] },
      { id: ROOM, name: '小队', memberIds: [A, B] },
      { name: '缺 id', memberIds: [A, B] },
      { id: ROOM, name: '重复', memberIds: [A, B] },
    ]);
    expect(parseRoomDocument(text)).toEqual([{ id: ROOM, name: '小队', memberIds: [A, B] }]);
    expect(parseRoomDocument('{')).toEqual([]);
    expect(parseRoomDocument('{"id":"nope"}')).toEqual([]);
  });

  it('接力上限必须是 1 到上限之间的整数；坏值的旧记录只丢掉这个字段', () => {
    const known = [A, B];
    expect(
      planRoom({ id: ROOM, name: '小队', memberIds: [A, B], relayLimit: 20, knownIds: known })
    ).toEqual({ ok: true, room: { id: ROOM, name: '小队', memberIds: [A, B], relayLimit: 20 } });
    for (const relayLimit of [0, RELAY_LIMIT_MAX + 1, 1.5, Number.NaN]) {
      expect(
        planRoom({ id: ROOM, name: '小队', memberIds: [A, B], relayLimit, knownIds: known })
      ).toEqual({ ok: false, error: 'bad-limit' });
    }
    expect(
      parseRoomDocument(
        JSON.stringify([{ id: ROOM, name: '小队', memberIds: [A, B], relayLimit: 0 }])
      )
    ).toEqual([{ id: ROOM, name: '小队', memberIds: [A, B] }]);
  });

  it('建群后可以换主持人、改接力上限；传 null 回到默认；主持人仍须是成员', () => {
    const room = { id: ROOM, name: '小队', memberIds: [A, B], hostId: A, relayLimit: 5 };
    expect(planRoomUpdate(room, { hostId: B })).toEqual({
      ok: true,
      room: { ...room, hostId: B },
    });
    expect(planRoomUpdate(room, { relayLimit: null, hostId: null })).toEqual({
      ok: true,
      room: { id: ROOM, name: '小队', memberIds: [A, B] },
    });
    expect(planRoomUpdate(room, { hostId: ROOM })).toEqual({ ok: false, error: 'bad-host' });
    expect(planRoomUpdate(room, { relayLimit: 99 })).toEqual({ ok: false, error: 'bad-limit' });
    expect(planRoomUpdate(room, {})).toEqual({ ok: true, room });
  });
});
