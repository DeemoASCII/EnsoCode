import type { Delegation } from '@shared/types/bot';
import type { BotSilence } from '@shared/types/botIpc';

export const silenceOf = (
  silences: readonly BotSilence[],
  conversationId: string | undefined
): BotSilence | undefined =>
  conversationId ? silences.find((item) => item.conversationId === conversationId) : undefined;

export const quietSeconds = (since: number, now: number): number =>
  Math.max(0, Math.floor((now - since) / 1000));

/** 收件箱静默提示：委派会话归到发起委派的聊天，最早静默的在前 */
export function silenceAlerts(
  silences: readonly BotSilence[],
  delegations: readonly Delegation[]
): BotSilence[] {
  return silences
    .map((item) =>
      item.chatId || !item.delegationId
        ? item
        : {
            ...item,
            chatId: delegations.find((record) => record.id === item.delegationId)?.chatId ?? null,
          }
    )
    .sort((a, b) => a.since - b.since);
}
