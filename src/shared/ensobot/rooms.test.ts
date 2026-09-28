import { describe, expect, it } from 'vitest';
import { decideBoardWake } from './board';
import { mentionsInText, parseRoomDocument, planRoom } from './rooms';

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
});
