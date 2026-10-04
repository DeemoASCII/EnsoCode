import { randomUUID } from 'node:crypto';
import { botNameKey, type Delegation } from '../../../shared/types/bot';
import type { BotEvent, BotSendResult } from '../../../shared/types/botIpc';
import type { BotAuthorityPort, BotSessionHost } from './botSessionHost';
import type { BotStore } from './botStore';
import type { BotChatStore } from './chatStore';
import {
  isActiveDelegation as active,
  batchDeliveryId,
  batchResultText,
  batchWaitingNotice,
  delegationBatches,
  delegationResultBody,
  escapeXml,
} from './delegationBatch';
import { delegatedBotPermissions, delegationPolicy } from './delegationPolicy';
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

export class DelegationService {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly delivering = new Set<string>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeDiscard: () => void;
  private readonly unsubscribeStarted: () => void;
  private disposed = false;
  private discarding = false;

  constructor(private readonly deps: Deps) {
    this.unsubscribeStarted = deps.host.onDeliveryStarted((event) => {
      const batch = delegationBatches(
        deps.store.list().filter((record) => record.parentConversationId === event.conversationId)
      ).find((items) => batchDeliveryId(items) === event.deliveryId);
      if (batch && !batch.some(active)) this.delivered(batch);
    });
    this.unsubscribeDiscard = deps.host.onDiscard((scope) => {
      // 级联取消不是“批次里有人结束”，不写等待提示
      this.discarding = true;
      try {
        for (const record of deps.store.list()) {
          if (
            (scope.chatId && record.chatId === scope.chatId) ||
            (scope.botId &&
              (record.parentBotId === scope.botId || record.targetBotId === scope.botId)) ||
            (scope.conversationId && record.parentConversationId === scope.conversationId)
          )
            this.cancel(record.id);
        }
      } finally {
        this.discarding = false;
      }
    });
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

  /** 同一轮发起的委派共享 batchId（父会话轮次键），结果齐了合并回传；standalone 自成一批 */
  delegate(
    parentConversationId: string,
    input: DelegateInput,
    options: { standalone?: boolean } = {}
  ): DelegateResult {
    if (this.disposed) return { ok: false, error: 'disabled' };
    const conversation = this.deps.authority.conversation(parentConversationId);
    let parent = this.deps.host.effectiveBot(parentConversationId);
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
    if (ancestor) {
      // 重启后 effectiveBot 回落到原始档案，审批档仍按祖先委派快照收紧
      parent = delegatedBotPermissions(
        { ...parent, approvalMode: ancestor.effectivePermissions?.approvalMode ?? 'supervised' },
        parent
      );
    }
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
    const batchId = options.standalone ? undefined : this.deps.host.turnKey(parentConversationId);
    const child = this.deps.authority.createBotConversation(conversation.projectId, {
      botId: target.id,
      chatId: null,
      delegationId: id,
    });
    const effective = delegatedBotPermissions(parent, target);
    if (!child || !this.deps.host.registerDelegation(child.conversationId, effective))
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
      effectivePermissions: {
        tools: effective.tools,
        approvalMode: effective.approvalMode,
        skillIds: effective.skillIds,
        mcpServerIds: effective.mcpServerIds,
      },
      ...(batchId ? { batchId } : {}),
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
    // 重试是用户在轮次之外的操作，不并入原批次，也不并入父会话当前轮次
    return this.delegate(
      record.parentConversationId,
      { to: record.targetBotId, task: record.task, context: record.context },
      { standalone: true }
    );
  }

  observeRunning(conversationId: string): void {
    const record = this.list().find(
      (item) => item.childConversationId === conversationId && item.state === 'queued'
    );
    if (record) this.save({ ...record, state: 'running' });
  }

  async deliverPending(parentConversationId?: string): Promise<void> {
    if (this.disposed) return;
    for (const batch of delegationBatches(this.list())) {
      const head = batch[0];
      const deliveryId = batchDeliveryId(batch);
      if (
        batch.some(active) ||
        batch.every((record) => record.deliveredAt !== undefined) ||
        this.delivering.has(deliveryId) ||
        (parentConversationId && head.parentConversationId !== parentConversationId) ||
        this.deps.host.isBusy(head.parentConversationId)
      )
        continue;
      const parent = this.deps.authority.conversation(head.parentConversationId);
      if (!parent || parent.lifecycle === 'ended') continue;
      if (this.deps.host.hasStartedDelivery(head.parentConversationId, deliveryId)) {
        this.delivered(batch);
        continue;
      }
      if (parent.bot?.delegationId) {
        const bot = this.deps.bots.get(head.parentBotId);
        const saved = this.deps.store.get(parent.bot.delegationId)?.effectivePermissions;
        // Interrupted delegation parents must not be restarted with their original task.
        if (
          !bot ||
          !this.deps.host.registerDelegation(parent.conversationId, {
            ...bot,
            ...(saved ? { skillIds: saved.skillIds, mcpServerIds: saved.mcpServerIds } : {}),
            tools: 'readonly',
            approvalMode: 'supervised',
          })
        )
          continue;
      }
      this.delivering.add(deliveryId);
      try {
        const text = batchResultText(batch, (id) => this.deps.bots.get(id)?.name ?? id);
        const sent =
          parent.bot?.chatId &&
          this.deps.chats.get(parent.bot.chatId)?.kind === 'group' &&
          this.deps.deliverGroupResult
            ? await this.deps.deliverGroupResult(head, text, deliveryId)
            : await this.deps.host.deliverConversation(head.parentConversationId, text, {
                onlyIfIdle: true,
                deliveryId,
              });
        if (sent.ok && this.deps.host.hasStartedDelivery(head.parentConversationId, deliveryId))
          this.delivered(batch);
      } catch (cause) {
        console.warn('[bots] delegation delivery failed', cause);
      } finally {
        this.delivering.delete(deliveryId);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.unsubscribeDiscard();
    this.unsubscribeStarted();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  disable(): void {
    this.disposed = true;
    for (const record of this.deps.store.list()) if (active(record)) this.cancel(record.id);
    this.dispose();
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
    const finished: Delegation = {
      ...record,
      state,
      finishedAt: Date.now(),
      ...(failure ? { failure } : {}),
      ...(result !== undefined ? { result } : {}),
      ...(error ? { error } : {}),
    };
    this.save(finished);
    this.noticeWaiting(finished);
    queueMicrotask(() => {
      void this.deliverPending(record.parentConversationId);
    });
  }

  /** 批次未齐：在群时间线提示谁结束了、还在等谁 */
  private noticeWaiting(record: Delegation): void {
    if (this.disposed || this.discarding || !record.batchId || !record.chatId) return;
    if (this.deps.chats.get(record.chatId)?.kind !== 'group') return;
    const batch = this.deps.store
      .list()
      .filter(
        (item) =>
          item.parentConversationId === record.parentConversationId &&
          item.batchId === record.batchId
      );
    const text = batchWaitingNotice(batch, record, (id) => this.deps.bots.get(id)?.name ?? id);
    if (!text) return;
    const saved = this.deps.chats.appendEntry(record.chatId, {
      kind: 'system',
      id: randomUUID(),
      at: Date.now(),
      text,
    });
    if (saved) this.deps.emit({ kind: 'timeline', chatId: record.chatId, seq: saved.seq });
  }

  private delivered(batch: readonly Delegation[]): void {
    for (const record of batch) {
      const latest = this.deps.store.get(record.id);
      if (!latest || latest.deliveredAt !== undefined) continue;
      if (record.chatId && this.deps.chats.get(record.chatId)?.kind === 'group') {
        if (
          !this.deps.chats
            .readEntries(record.chatId, { limit: Number.MAX_SAFE_INTEGER })
            .some((entry) => entry.id === `delegation:${record.id}`)
        )
          this.deps.chats.appendEntry(record.chatId, {
            kind: 'delegation',
            id: `delegation:${record.id}`,
            at: Date.now(),
            delegationId: record.id,
            from: record.parentBotId,
            to: record.targetBotId,
            state: record.state,
            summary: delegationResultBody(record).slice(0, 500),
          });
        this.deps.emit({ kind: 'timeline', chatId: record.chatId });
      }
      this.save({ ...latest, deliveredAt: Date.now() });
    }
  }

  private save(record: Delegation): void {
    this.deps.store.save(record);
    this.deps.emit({ kind: 'delegation', ...(record.chatId ? { chatId: record.chatId } : {}) });
  }
}
