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
