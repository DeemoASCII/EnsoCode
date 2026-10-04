import { afterEach, expect, it, vi } from 'vitest';
import type { AgentWorkerEvent } from '../../../shared/types/agent';
import type { BotSessionHost, BotTurnFinished } from './botSessionHost';
import type { BotChatStore } from './chatStore';
import type { GroupChatService } from './groupChat';
import { RoutineRunner } from './routineRunner';

afterEach(() => vi.useRealTimers());
it('denies unanswered approvals after 30 minutes only for the routine delivery and exact identity', async () => {
  vi.useFakeTimers();
  let deliveryId: string | undefined;
  let finish!: (event: BotTurnFinished) => void;
  const deny = vi.fn();
  const runner = new RoutineRunner({
    host: {
      onTurnFinished: (listener: typeof finish) => {
        finish = listener;
        return () => {};
      },
      activeDeliveryId: () => deliveryId,
      deliver: async (
        _chat: string,
        _bot: string,
        _text: string,
        options: { deliveryId: string }
      ) => {
        deliveryId = options.deliveryId;
        return { ok: true, conversationId: 's' };
      },
    } as unknown as BotSessionHost,
    chats: { get: () => ({ kind: 'direct' }) } as unknown as BotChatStore,
    groups: {} as GroupChatService,
    deny,
  });
  const identity = { sessionId: 's', generation: 'g' };
  const approval = {
    type: 'approval-request',
    identity,
    seq: 1,
    request: { requestId: 'req' },
  } as AgentWorkerEvent;
  runner.observe(approval);
  await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
  expect(deny).not.toHaveBeenCalled();
  const running = runner.run({
    id: 'r',
    botId: 'b',
    chatId: 'c',
    title: 'run',
    prompt: 'work',
    schedule: '* * * * *',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  });
  runner.observe(approval);
  await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 1);
  expect(deny).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(deny).toHaveBeenCalledWith(identity, 'req');
  finish({ botId: 'b', chatId: 'c', conversationId: 's', text: '', ok: true, deliveryId });
  expect(await running).toEqual({ ok: true });
});
