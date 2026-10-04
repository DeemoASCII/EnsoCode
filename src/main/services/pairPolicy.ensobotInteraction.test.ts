import { expect, it } from 'vitest';
import { parsePhoneCommand } from './pairPolicy';

it('远端审批与本地同样收窄，不带有效回执/令牌/决定的不进入宿主', () => {
  const command = {
    type: 'ensobot-respond',
    deliveryId: 'receipt',
    response: {
      id: 'opaque',
      cardId: '11111111-1111-4111-8111-111111111111',
      kind: 'approval',
      decision: 'allow',
    },
  };
  expect(parsePhoneCommand(command)).toEqual({ ok: true, command });
  for (const bad of [
    { ...command, deliveryId: undefined },
    { ...command, response: { ...command.response, decision: 'full' } },
    { ...command, response: { ...command.response, id: '' } },
  ]) {
    expect(parsePhoneCommand(bad).ok).toBe(false);
  }
});

it('远端建群可以指定主持人，但主持人必须是合法的群成员', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const command = { type: 'ensobot-room-create', name: '小队', memberIds: [A, B], hostId: B };
  expect(parsePhoneCommand(command)).toEqual({ ok: true, command });
  const legacy = { type: 'ensobot-room-create', name: '小队', memberIds: [A, B] };
  expect(parsePhoneCommand(legacy)).toEqual({ ok: true, command: legacy });
  for (const hostId of ['../x', 42, '33333333-3333-4333-8333-333333333333']) {
    expect(parsePhoneCommand({ ...command, hostId }).ok).toBe(false);
  }
});

it('远端改群设置：只带群 id、主持人和接力上限，坏值不进宿主', () => {
  const ROOM = '33333333-3333-4333-8333-333333333333';
  const HOST = '11111111-1111-4111-8111-111111111111';
  const command = { type: 'ensobot-room-update', roomId: ROOM, hostId: HOST, relayLimit: 8 };
  expect(parsePhoneCommand(command)).toEqual({ ok: true, command });
  const reset = { type: 'ensobot-room-update', roomId: ROOM, hostId: null, relayLimit: null };
  expect(parsePhoneCommand(reset)).toEqual({ ok: true, command: reset });
  for (const bad of [
    { ...command, roomId: '../room' },
    { ...command, hostId: 'nope' },
    { ...command, relayLimit: 0 },
    { ...command, relayLimit: 51 },
    { ...command, relayLimit: '8' },
  ]) {
    expect(parsePhoneCommand(bad).ok).toBe(false);
  }
});
