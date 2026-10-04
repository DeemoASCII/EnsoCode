import { randomUUID } from 'node:crypto';
import { botNameKey, DELEGATION_TIMEOUT_MINUTES, type Delegation } from '../../../shared/types/bot';
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
import { rewoundDelegations } from './rewind';

interface Deps {
  bots: BotStore;
  chats: BotChatStore;
  authority: BotAuthorityPort;
  host: BotSessionHost;
  store: DelegationStore;
  emit: (event: BotEvent) => void;
  /** 一分钟的毫秒数，测试用来压缩时限 */
  minuteMs?: number;
  /** 群任务看板联动：taskId 校验与每次落盘后的状态同步 */
  tasks?: {
    gate(
      chatId: string | null,
      ref: string,
      parentBotId: string
    ): { ok: true; taskId: string } | { ok: false; error: string };
    sync(record: Delegation): void;
  };
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
  /** 看板任务（#N 或 id）；委派创建 / 终态同步任务状态 */
  taskId?: string;
  /** 期望时限（分钟），不超过目标成员的委派时限 */
  deadlineMinutes?: number;
  /** 父回合被停止 / 中断后仍继续 */
  keep?: boolean;
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
      if (event.stopped && event.turnKey) this.stopBatch(event.conversationId, event.turnKey);
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

  private upstreamBots(record: Delegation): Set<string> {
    const ids = new Set<string>();
    for (let item: Delegation | undefined = record; item && !ids.has(item.parentBotId); ) {
      ids.add(item.parentBotId);
      const above: string | undefined = this.deps.authority.conversation(item.parentConversationId)
        ?.bot?.delegationId;
      item = above ? this.deps.store.get(above) : undefined;
    }
    return ids;
  }

  /** 同一轮发起的委派共享 batchId（父会话轮次键），结果齐了合并回传；standalone 自成一批 */
  delegate(
    parentConversationId: string,
    input: DelegateInput,
    options: { standalone?: boolean; retryOf?: string } = {}
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
    const deadline = input.deadlineMinutes;
    if (deadline !== undefined && !(Number.isFinite(deadline) && deadline > 0))
      return { ok: false, error: 'deadlineMinutes must be a positive number.' };
    const limit = target.delegationTimeoutMinutes ?? DELEGATION_TIMEOUT_MINUTES;
    const timeoutMinutes = Math.min(deadline ?? limit, limit);
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
    // 结果本来就会自动回传给上游，往回委派只会绕圈
    if (ancestor && this.upstreamBots(ancestor).has(target.id))
      return {
        ok: false,
        error: `${target.name} delegated this work to you; your final reply is returned to them automatically.`,
      };
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
    let taskId: string | undefined;
    if (input.taskId !== undefined) {
      const gate = this.deps.tasks?.gate(chatId, input.taskId, parent.id) ?? {
        ok: false as const,
        error: 'Tasks are only available in group chats.',
      };
      if (!gate.ok) return gate;
      taskId = gate.taskId;
    }
    const id = randomUUID();
    const batchId = options.standalone ? undefined : this.deps.host.turnKey(parentConversationId);
    const child = this.deps.authority.createBotConversation(conversation.projectId, {
      botId: target.id,
      chatId: null,
      delegationId: id,
    });
    const effective = delegatedBotPermissions(parent, target);
    if (
      !child ||
      !this.deps.host.registerDelegation(child.conversationId, effective, {
        parentConversationId,
        chatId,
      })
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
      effectivePermissions: {
        tools: effective.tools,
        approvalMode: effective.approvalMode,
        skillIds: effective.skillIds,
        mcpServerIds: effective.mcpServerIds,
      },
      ...(batchId ? { batchId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(options.retryOf ? { retryOf: options.retryOf } : {}),
      ...(input.keep ? { keep: true } : {}),
      timeoutMinutes,
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
      timeoutMinutes * (this.deps.minuteMs ?? 60_000)
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
    const warnings = [
      ...((input.context?.length ?? 0) > 8000 ? ['Context truncated to 8000 characters.'] : []),
      ...(deadline !== undefined && deadline > limit
        ? [`Deadline capped at ${limit} minutes (${target.name}'s delegation limit).`]
        : []),
    ];
    return {
      ok: true,
      delegationId: id,
      ...(warnings.length ? { warning: warnings.join(' ') } : {}),
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
    if (!record || (record.state !== 'failed' && record.state !== 'canceled'))
      return {
        ok: false,
        error: 'Only failed, canceled or interrupted delegations can be retried.',
      };
    if (this.deps.store.list().some((item) => item.retryOf === id))
      return { ok: false, error: 'This delegation has already been retried.' };
    // 任务仍空闲（已退回待办）时沿用关联；已完成 / 取消 / 被别人接手则不再绑定
    const taskId =
      record.taskId && this.deps.tasks?.gate(record.chatId, record.taskId, record.parentBotId).ok
        ? record.taskId
        : undefined;
    // 重试是用户在轮次之外的操作，不并入原批次，也不并入父会话当前轮次
    return this.delegate(
      record.parentConversationId,
      {
        to: record.targetBotId,
        task: record.task,
        context: record.context,
        ...(taskId ? { taskId } : {}),
        ...(record.timeoutMinutes ? { deadlineMinutes: record.timeoutMinutes } : {}),
      },
      { standalone: true, retryOf: id }
    );
  }

  /** 父回合被停止：取消该轮发起且未 keep 的委派；整批都已结束则只落时间线，不再唤醒父会话 */
  private stopBatch(parentConversationId: string, batchId: string): void {
    const batch = () =>
      this.deps.store
        .list()
        .filter(
          (record) =>
            record.parentConversationId === parentConversationId && record.batchId === batchId
        );
    this.discarding = true;
    try {
      for (const record of batch()) if (active(record) && !record.keep) this.cancel(record.id);
    } finally {
      this.discarding = false;
    }
    const rest = batch();
    if (rest.length && !rest.some(active)) this.delivered(rest);
  }

  /** 私聊回退越过发起委派的回合：取消进行中的，未投递结果一律作废（规则见 rewoundDelegations） */
  discardRewound(parentConversationId: string, since: number): void {
    const { cancel, discard } = rewoundDelegations(this.list(), parentConversationId, since);
    this.discarding = true;
    try {
      for (const id of cancel) this.cancel(id);
    } finally {
      this.discarding = false;
    }
    const records = discard.flatMap((id) => this.deps.store.get(id) ?? []);
    if (records.length) this.delivered(records);
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
        if (!this.deps.chats.hasEntry(record.chatId, `delegation:${record.id}`))
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
    this.deps.tasks?.sync(record);
    this.deps.emit({ kind: 'delegation', ...(record.chatId ? { chatId: record.chatId } : {}) });
  }
}
