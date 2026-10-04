import type { BotChat, Delegation, DelegationState } from '@shared/types/bot';
import { type SessionOwner, sessionOwners } from './selectors';

export const isActiveDelegation = (state: DelegationState) =>
  state === 'queued' || state === 'running';

/** 进行中委派的子会话 → 发起聊天；审批/提问归在那里显示「X 替 Y 执行」 */
export function delegationOwners(delegations: readonly Delegation[]): Record<string, SessionOwner> {
  const owners: Record<string, SessionOwner> = {};
  for (const item of delegations) {
    if (!item.chatId || !isActiveDelegation(item.state)) continue;
    owners[item.childConversationId] = {
      chatId: item.chatId,
      botId: item.targetBotId,
      delegation: { id: item.id, parentBotId: item.parentBotId },
    };
  }
  return owners;
}

/** 聊天成员会话 + 委派子会话 */
export function pendingOwners(
  chats: readonly BotChat[],
  delegations: readonly Delegation[]
): Record<string, SessionOwner> {
  return { ...sessionOwners(chats), ...delegationOwners(delegations) };
}

export function activeDelegations(
  delegations: readonly Delegation[],
  chatId: string
): Delegation[] {
  return delegations
    .filter((item) => item.chatId === chatId && isActiveDelegation(item.state))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** 之后出现了同父会话、同目标、同任务的新委派（用户或成员已重试） */
export function isRetried(item: Delegation, delegations: readonly Delegation[]): boolean {
  return delegations.some(
    (other) =>
      other.createdAt > item.createdAt &&
      other.parentConversationId === item.parentConversationId &&
      other.targetBotId === item.targetBotId &&
      other.task === item.task
  );
}

/** 重启中断、未被重试也未忽略的委派，新的在前 */
export function interruptedDelegations(
  delegations: readonly Delegation[],
  dismissed: readonly string[]
): Delegation[] {
  return delegations
    .filter(
      (item) =>
        item.chatId !== null &&
        item.state === 'failed' &&
        item.failure === 'interrupted' &&
        !dismissed.includes(item.id) &&
        !isRetried(item, delegations)
    )
    .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt));
}

export function delegationActions(state: DelegationState): { cancel: boolean; retry: boolean } {
  return {
    cancel: isActiveDelegation(state),
    retry: state === 'failed' || state === 'canceled',
  };
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)}h ${rest}m` : `${Math.floor(minutes / 60)}h`;
}
