import { randomUUID } from 'node:crypto';
import { parseChildSessionIdentity } from '../../../shared/builtinAgents';
import type { AgentWorkerEvent, SessionIdentity } from '../../../shared/types/agent';
import type { BotRoutine } from '../../../shared/types/bot';
import type { BotSessionHost } from './botSessionHost';
import type { BotChatStore } from './chatStore';
import type { GroupChatService } from './groupChat';

type Result = { ok: boolean; error?: string };
export class RoutineRunner {
  private pending = new Map<string, (result: Result) => void>();
  private approvals = new Map<
    string,
    { conversationId: string; timer: ReturnType<typeof setTimeout> }
  >();
  constructor(
    private readonly deps: {
      host: BotSessionHost;
      chats: BotChatStore;
      groups: GroupChatService;
      deny: (identity: SessionIdentity, requestId: string) => void;
    }
  ) {
    deps.host.onTurnFinished((event) => {
      if (event.deliveryId) {
        this.pending.get(event.deliveryId)?.({
          ok: event.ok,
          ...(event.error ? { error: event.error } : {}),
        });
        this.pending.delete(event.deliveryId);
      }
      for (const [key, approval] of this.approvals)
        if (approval.conversationId === event.conversationId) {
          clearTimeout(approval.timer);
          this.approvals.delete(key);
        }
    });
  }

  run(routine: BotRoutine): Promise<Result> {
    const deliveryId = `routine:${randomUUID()}`;
    const text = `<routine title="${routine.title.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}">${routine.prompt}</routine>`;
    return new Promise((resolve) => {
      this.pending.set(deliveryId, resolve);
      const sent =
        this.deps.chats.get(routine.chatId)?.kind === 'group'
          ? this.deps.groups.runAs(routine.chatId, routine.botId, text, routine.title, {
              deliveryId,
              queueIfBusy: true,
            })
          : this.deps.host.deliver(routine.chatId, routine.botId, text, {
              deliveryId,
              queueIfBusy: true,
            });
      void sent
        .then((result) => {
          if (!result.ok) {
            this.pending.delete(deliveryId);
            resolve(result);
          }
        })
        .catch((error) => {
          this.pending.delete(deliveryId);
          resolve({ ok: false, error: String(error) });
        });
    });
  }

  observe(event: AgentWorkerEvent | { type: 'worker-exited' }): void {
    if (event.type !== 'approval-request' && event.type !== 'approval-resolved') return;
    const requestId = event.type === 'approval-request' ? event.request.requestId : event.requestId;
    const key = `${event.identity.sessionId}:${event.identity.generation}:${requestId}`;
    if (event.type === 'approval-resolved') {
      clearTimeout(this.approvals.get(key)?.timer);
      this.approvals.delete(key);
      return;
    }
    const conversationId =
      parseChildSessionIdentity(event.identity)?.parent.sessionId ?? event.identity.sessionId;
    const delivery = this.deps.host.activeDeliveryId(conversationId);
    if (!delivery || !this.pending.has(delivery) || this.approvals.has(key)) return;
    const timer = setTimeout(
      () => {
        this.approvals.delete(key);
        this.deps.deny(event.identity, requestId);
      },
      30 * 60 * 1000
    );
    timer.unref?.();
    this.approvals.set(key, { conversationId, timer });
  }
}
