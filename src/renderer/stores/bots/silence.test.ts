import type { Delegation } from '@shared/types/bot';
import type { BotSilence } from '@shared/types/botIpc';
import { describe, expect, it } from 'vitest';
import { quietSeconds, silenceAlerts, silenceOf } from './silence';

const silence = (patch: Partial<BotSilence>): BotSilence => ({
  conversationId: 'c1',
  chatId: 'chat1',
  botId: 'b1',
  since: 1_000,
  ...patch,
});

describe('silence selectors', () => {
  it('finds the silence of a conversation', () => {
    const list = [silence({}), silence({ conversationId: 'c2', since: 5 })];
    expect(silenceOf(list, 'c2')?.since).toBe(5);
    expect(silenceOf(list, 'c3')).toBeUndefined();
    expect(silenceOf(list, undefined)).toBeUndefined();
  });

  it('counts whole seconds and never goes negative', () => {
    expect(quietSeconds(1_000, 92_999)).toBe(91);
    expect(quietSeconds(5_000, 1_000)).toBe(0);
  });

  it('maps delegation sessions to the chat that started the delegation, oldest first', () => {
    const delegations = [{ id: 'd1', chatId: 'group1', childConversationId: 'c9' } as Delegation];
    const alerts = silenceAlerts(
      [
        silence({ conversationId: 'c2', since: 9_000 }),
        silence({ conversationId: 'c9', chatId: null, delegationId: 'd1', since: 2_000 }),
        silence({ conversationId: 'c8', chatId: null, delegationId: 'gone' }),
      ],
      delegations
    );
    expect(alerts.map((item) => [item.conversationId, item.chatId])).toEqual([
      ['c8', null],
      ['c9', 'group1'],
      ['c2', 'chat1'],
    ]);
  });
});
