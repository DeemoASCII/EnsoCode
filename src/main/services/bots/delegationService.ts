import { randomUUID } from 'node:crypto';
import { botNameKey, type Delegation } from '../../../shared/types/bot';
import type { BotEvent, BotSendResult } from '../../../shared/types/botIpc';
import type { BotAuthorityPort, BotSessionHost } from './botSessionHost';
import type { BotStore } from './botStore';
import type { BotChatStore } from './chatStore';
import { delegationPolicy, intersectBotPermissions } from './delegationPolicy';
import type { DelegationStore } from './delegationStore';

interface Deps {
  bots: BotStore;
  chats: BotChatStore;
  authority: BotAuthorityPort;
  host: BotSessionHost;
  store: DelegationStore;
  emit: (event: BotEvent) => void;
  timeoutMs?: number;
  deliverGroupResult?: (
    record: Delegation,
    text: string,
    deliveryId: string
  ) => Promise<BotSendResult>;
}
export interface DelegateInput {
  to: string;
  task: string;
  context?: string;
}
export type DelegateResult =
  | { ok: true; delegationId: string; warning?: string }
  | { ok: false; error: string };
const active = (record: Delegation) => record.state === 'queued' || record.state === 'running';
const escapeXml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export class DelegationService {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly delivering = new Set<string>();
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(private readonly deps: Deps) {
    for (const record of deps.store.list()) {
      if (active(record))
        this.save({ ...record, state: 'failed', failure: 'interrupted', finishedAt: Date.now() });
    }
    this.unsubscribe = deps.host.onTurnFinished((event) => {
      if (event.delegationId) {
        const record = deps.store.get(event.delegationId);
        if (record && active(record) && record.childConversationId === event.conversationId) {
          this.finish(
            record,
            event.ok ? 'completed' : 'failed',
            event.ok ? undefined : 'error',
            event.text,
            event.error
          );
        }
      }
      queueMicrotask(() => {
        void this.deliverPending();
      });
    });
    queueMicrotask(() => {
      void this.deliverPending();
    });
  }

  delegate(parentConversationId: string, input: DelegateInput): DelegateResult {
    const conversation = this.deps.authority.conversation(parentConversationId);
    const parent = this.deps.host.effectiveBot(parentConversationId);
    const target = this.deps.bots
      .list()
      .find((bot) => bot.id === input.to || botNameKey(bot.name) === botNameKey(input.to));
    if (!conversation?.bot || conversation.lifecycle === 'ended' || !parent)
      return { ok: false, error: 'Parent bot session unavailable.' };
    if (!target) return { ok: false, error: `Unknown member: ${input.to}` };
    if (!input.task.trim()) return { ok: false, error: 'Task must not be empty.' };
    const ancestor =
      conversation.bot.delegationId && this.deps.store.get(conversation.bot.delegationId);
    if (conversation.bot.delegationId && !ancestor)
      return { ok: false, error: 'Parent delegation record unavailable.' };
    const depth = (ancestor ? ancestor.depth : 0) + 1;
    const chatId = conversation.bot.chatId ?? (ancestor ? ancestor.chatId : null);
    const chat = chatId ? this.deps.chats.get(chatId) : undefined;
    if (chatId && (!chat || chat.archivedAt !== undefined))
      return { ok: false, error: 'Parent chat unavailable.' };
    const count = this.deps.store
      .list()
      .filter(
        (record) => record.parentConversationId === parentConversationId && active(record)
      ).length;
    const error = delegationPolicy(
      parent,
      target,
      depth,
      count,
      chat?.kind === 'group' ? chat.members : undefined
    );
    if (error) return { ok: false, error };
    const id = randomUUID();
    const child = this.deps.authority.createBotConversation(conversation.projectId, {
      botId: target.id,
      chatId: null,
      delegationId: id,
    });
    if (
      !child ||
      !this.deps.host.registerDelegation(
        child.conversationId,
        intersectBotPermissions(parent, target)
      )
    )
      return { ok: false, error: 'Delegation workspace unavailable.' };
    const record: Delegation = {
      id,
      parentConversationId,
      parentBotId: parent.id,
      targetBotId: target.id,
      chatId,
      task: input.task,
      context: (input.context ?? '').slice(0, 8000),
      childConversationId: child.conversationId,
      state: 'queued',
      depth,
      createdAt: Date.now(),
    };
    this.save(record);
    const timer = setTimeout(
      () => {
        const current = this.deps.store.get(id);
        if (current && active(current)) {
          this.finish(current, 'failed', 'timeout');
          void this.deps.host.abortConversation(child.conversationId).catch(console.warn);
        }
      },
      this.deps.timeoutMs ?? 4 * 60 * 60 * 1000
    );
    timer.unref?.();
    this.timers.set(id, timer);
    const text = `<delegation-task id="${id}" from="${escapeXml(parent.name)}">\n${escapeXml(record.task)}\n<context>${escapeXml(record.context)}</context>\n</delegation-task>`;
    void this.deps.host
      .deliverConversation(child.conversationId, text, { deliveryId: id, queueIfBusy: true })
      .then((sent) => {
        const current = this.deps.store.get(id);
        if (!current || !active(current)) return;
        if (!sent.ok) this.finish(current, 'failed', 'error', undefined, sent.error);
        else if (!sent.queued) this.save({ ...current, state: 'running' });
      })
      .catch((cause) => {
        const current = this.deps.store.get(id);
        if (current && active(current))
          this.finish(current, 'failed', 'error', undefined, String(cause));
      });
    return {
      ok: true,
      delegationId: id,
      ...((input.context?.length ?? 0) > 8000
        ? { warning: 'Context truncated to 8000 characters.' }
        : {}),
    };
  }

  list(chatId?: string): Delegation[] {
    return this.deps.store.list(chatId);
  }

  check(parentConversationId: string, input: { id?: string; cancel?: boolean }): unknown {
    const records = this.list().filter(
      (record) =>
        record.parentConversationId === parentConversationId &&
        (!input.id || record.id === input.id)
    );
    if (input.id && !records.length)
      return { ok: false, error: 'Delegation not found in this parent session.' };
    if (input.cancel) {
      if (!input.id) return { ok: false, error: 'Specify id to cancel a delegation.' };
      return this.cancel(input.id);
    }
    return { ok: true, delegations: records };
  }

  cancel(id: string): { ok: boolean; error?: string } {
    const record = this.deps.store.get(id);
    if (!record) return { ok: false, error: 'Delegation not found.' };
    if (!active(record)) return { ok: true };
    this.finish(record, 'canceled');
    void this.deps.host.abortConversation(record.childConversationId).catch(console.warn);
    return { ok: true };
  }

  retry(id: string): DelegateResult {
    const record = this.deps.store.get(id);
    if (!record || active(record))
      return { ok: false, error: 'Only finished delegations can be retried.' };
    return this.delegate(record.parentConversationId, {
      to: record.targetBotId,
      task: record.task,
      context: record.context,
    });
  }

  observeRunning(conversationId: string): void {
    const record = this.list().find(
      (item) => item.childConversationId === conversationId && item.state === 'queued'
    );
    if (record) this.save({ ...record, state: 'running' });
  }

  async deliverPending(parentConversationId?: string): Promise<void> {
    if (this.disposed) return;
    for (const record of this.list()) {
      if (
        active(record) ||
        record.deliveredAt !== undefined ||
        this.delivering.has(record.id) ||
        (parentConversationId && record.parentConversationId !== parentConversationId) ||
        this.deps.host.isBusy(record.parentConversationId)
      )
        continue;
      const parent = this.deps.authority.conversation(record.parentConversationId);
      if (!parent || parent.lifecycle === 'ended') continue;
      if (parent.bot?.delegationId) {
        const bot = this.deps.bots.get(record.parentBotId);
        // Interrupted delegation parents must not be restarted with their original task.
        if (
          !bot ||
          !this.deps.host.registerDelegation(parent.conversationId, {
            ...bot,
            tools: 'readonly',
            approvalMode: 'supervised',
          })
        )
          continue;
      }
      this.delivering.add(record.id);
      try {
        const from = this.deps.bots.get(record.targetBotId)?.name ?? record.targetBotId;
        const body =
          record.state === 'completed'
            ? (record.result ?? '')
            : (record.error ?? record.failure ?? record.state);
        const text = `<delegation-result id="${record.id}" from="${escapeXml(from)}" status="${record.state}">${escapeXml(body)}</delegation-result>`;
        const deliveryId = `delegation-result:${record.id}`;
        const sent =
          parent.bot?.chatId &&
          this.deps.chats.get(parent.bot.chatId)?.kind === 'group' &&
          this.deps.deliverGroupResult
            ? await this.deps.deliverGroupResult(record, text, deliveryId)
            : await this.deps.host.deliverConversation(record.parentConversationId, text, {
                onlyIfIdle: true,
                deliveryId,
              });
        if (!sent.ok) continue;
        this.save({ ...record, deliveredAt: Date.now() });
        if (record.chatId && this.deps.chats.get(record.chatId)?.kind === 'group') {
          this.deps.chats.appendEntry(record.chatId, {
            kind: 'delegation',
            id: `delegation:${record.id}`,
            at: Date.now(),
            delegationId: record.id,
            from: record.parentBotId,
            to: record.targetBotId,
            state: record.state,
            summary: body.slice(0, 500),
          });
          this.deps.chats.appendEntry(record.chatId, {
            kind: 'bot',
            id: `delegation-bot:${record.id}`,
            at: Date.now(),
            botId: record.targetBotId,
            text: body,
            conversationId: record.childConversationId,
            turnId: record.id,
          });
          this.deps.emit({ kind: 'timeline', chatId: record.chatId });
        }
      } catch (cause) {
        console.warn('[bots] delegation delivery failed', cause);
      } finally {
        this.delivering.delete(record.id);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private finish(
    record: Delegation,
    state: Delegation['state'],
    failure?: Delegation['failure'],
    result?: string,
    error?: string
  ): void {
    clearTimeout(this.timers.get(record.id));
    this.timers.delete(record.id);
    this.save({
      ...record,
      state,
      finishedAt: Date.now(),
      ...(failure ? { failure } : {}),
      ...(result !== undefined ? { result } : {}),
      ...(error ? { error } : {}),
    });
    queueMicrotask(() => {
      void this.deliverPending(record.parentConversationId);
    });
  }

  private save(record: Delegation): void {
    this.deps.store.save(record);
    this.deps.emit({ kind: 'delegation', ...(record.chatId ? { chatId: record.chatId } : {}) });
  }
}
