import { randomUUID } from 'node:crypto';
import { TRANSCRIPT_LABELS } from '../../../shared/bots/transcript';
import {
  type BotChat,
  type Delegation,
  GROUP_TASK_TEXT_MAX,
  GROUP_TASK_TITLE_MAX,
  type GroupTask,
} from '../../../shared/types/bot';
import type { BotEvent, BotSendResult } from '../../../shared/types/botIpc';
import type { BotStore } from './botStore';
import type { BotChatStore } from './chatStore';
import { delegationResultBody, isActiveDelegation } from './delegationBatch';
import type { GroupTaskStore } from './groupTaskStore';

/** 'human' = 人类（UI）；其余为成员 botId */
export type TaskActor = string;
export type TaskResult = { ok: true; task: GroupTask } | { ok: false; error: string };
export type TaskGate = { ok: true; taskId: string } | { ok: false; error: string };

interface Deps {
  store: GroupTaskStore;
  chats: BotChatStore;
  bots: BotStore;
  emit: (event: BotEvent) => void;
  /** 以人类身份在群里发消息（复用群路由） */
  send?: (chatId: string, text: string) => Promise<BotSendResult>;
  cancelDelegation?: (id: string) => void;
  now?: () => number;
}

export const GROUP_TASK_ACTIONS = ['list', 'add', 'claim', 'update', 'complete', 'cancel'] as const;

const short = (text: string, max = 80) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};
const label = (task: GroupTask) => `#${task.seq} ${task.title}`;

/**
 * 委派 → 任务状态机（纯函数）。返回 undefined 表示不变。
 * 创建：todo，或发起人自己认领中且无委派的任务 → doing / 负责人 = 目标 / 记 delegationId；
 * 终态：仅当任务仍由这条委派负责（doing + 同 delegationId）——完成 → done 带结果摘要，其余 → 退回 todo。
 */
export function taskAfterDelegation(
  task: GroupTask,
  record: Delegation,
  now: number
): GroupTask | undefined {
  if (record.taskId !== task.id) return undefined;
  if (isActiveDelegation(record)) {
    if (task.delegationId !== undefined) return undefined;
    const free =
      task.status === 'todo' ||
      (task.status === 'doing' && task.assigneeBotId === record.parentBotId);
    if (!free) return undefined;
    return {
      ...task,
      status: 'doing',
      assigneeBotId: record.targetBotId,
      delegationId: record.id,
      updatedAt: now,
    };
  }
  if (task.status !== 'doing' || task.delegationId !== record.id) return undefined;
  if (record.state === 'completed') {
    const result = delegationResultBody(record).trim().slice(0, GROUP_TASK_TEXT_MAX);
    return { ...task, status: 'done', ...(result ? { result } : {}), updatedAt: now };
  }
  const { assigneeBotId: _assignee, delegationId: _delegation, ...rest } = task;
  return { ...rest, status: 'todo', updatedAt: now };
}

/** 群任务看板：成员工具、人类 UI 与委派联动共用；每次变更推 tasks 事件，关键变更写 system 时间线 */
export class GroupTaskService {
  constructor(private readonly deps: Deps) {}

  list(chatId: string): GroupTask[] {
    return this.group(chatId) ? this.deps.store.list(chatId) : [];
  }

  add(chatId: string, actor: TaskActor, input: { title: string; detail?: string }): TaskResult {
    const denied = this.check(chatId, actor);
    if (denied) return denied;
    if (!input.title.trim()) return { ok: false, error: 'Title must not be empty.' };
    if (input.title.trim().length > GROUP_TASK_TITLE_MAX)
      return { ok: false, error: `Title must be at most ${GROUP_TASK_TITLE_MAX} characters.` };
    const task = this.deps.store.create(
      chatId,
      { title: input.title, ...(input.detail ? { detail: input.detail } : {}), createdBy: actor },
      this.now()
    );
    if (!task) return { ok: false, error: 'Task not saved.' };
    this.changed(chatId, `${this.name(actor)} 新建了任务 ${label(task)}`);
    return { ok: true, task };
  }

  update(
    chatId: string,
    actor: TaskActor,
    ref: string,
    patch: { title?: string; detail?: string }
  ): TaskResult {
    const found = this.resolve(chatId, actor, ref);
    if (!found.ok) return found;
    const title = patch.title?.trim();
    if (patch.title !== undefined && (!title || title.length > GROUP_TASK_TITLE_MAX))
      return { ok: false, error: 'Title must be 1-200 characters.' };
    const { detail: _detail, ...rest } = found.task;
    const detail = patch.detail === undefined ? found.task.detail : patch.detail.trim();
    return this.write(chatId, {
      ...rest,
      ...(title ? { title } : {}),
      ...(detail ? { detail: detail.slice(0, GROUP_TASK_TEXT_MAX) } : {}),
      updatedAt: this.now(),
    });
  }

  /** 同步「读-判-写」：Main 单线程，第二个认领必然看到第一个的结果 */
  claim(chatId: string, botId: string, ref: string): TaskResult {
    if (botId === 'human') return { ok: false, error: 'Only members can claim tasks.' };
    const found = this.resolve(chatId, botId, ref);
    if (!found.ok) return found;
    const task = found.task;
    if (task.status !== 'todo' || task.assigneeBotId) return { ok: false, error: busy(task, this) };
    return this.write(
      chatId,
      { ...task, status: 'doing', assigneeBotId: botId, updatedAt: this.now() },
      `${this.name(botId)} 认领了 ${label(task)}`
    );
  }

  complete(chatId: string, actor: TaskActor, ref: string, result?: string): TaskResult {
    const found = this.resolve(chatId, actor, ref);
    if (!found.ok) return found;
    const task = found.task;
    if (task.status === 'done' || task.status === 'canceled')
      return { ok: false, error: busy(task, this) };
    const text = result?.trim().slice(0, GROUP_TASK_TEXT_MAX);
    if (actor !== 'human') {
      if (task.delegationId)
        return {
          ok: false,
          error: `Task #${task.seq} is being handled by a delegation; it completes automatically when the delegation finishes.`,
        };
      if (task.status !== 'doing' || task.assigneeBotId !== actor)
        return {
          ok: false,
          error: task.assigneeBotId
            ? `Only the assignee (${this.name(task.assigneeBotId)}) can complete task #${task.seq}.`
            : `Claim task #${task.seq} before completing it.`,
        };
      if (!text) return { ok: false, error: 'Describe the result when completing a task.' };
    }
    return this.linkedAfter(
      task,
      this.write(
        chatId,
        { ...task, status: 'done', ...(text ? { result: text } : {}), updatedAt: this.now() },
        `${this.name(actor)} 完成了 ${label(task)}${text ? `：${short(text)}` : ''}`
      )
    );
  }

  cancel(chatId: string, actor: TaskActor, ref: string): TaskResult {
    const found = this.resolve(chatId, actor, ref);
    if (!found.ok) return found;
    const task = found.task;
    if (task.status === 'done' || task.status === 'canceled')
      return { ok: false, error: busy(task, this) };
    if (actor !== 'human' && task.delegationId)
      return {
        ok: false,
        error: `Task #${task.seq} is being handled by a delegation; the delegator can cancel it with check_delegation.`,
      };
    if (actor !== 'human' && task.createdBy !== actor && task.assigneeBotId !== actor)
      return {
        ok: false,
        error: `Only the creator or the assignee can cancel task #${task.seq}.`,
      };
    return this.linkedAfter(
      task,
      this.write(
        chatId,
        { ...task, status: 'canceled', updatedAt: this.now() },
        `${this.name(actor)} 取消了 ${label(task)}`
      )
    );
  }

  /** 人类指派：置 doing / 负责人，再以人类身份 @ 成员；投递失败回滚 */
  async assign(chatId: string, ref: string, botId: string): Promise<TaskResult> {
    const found = this.resolve(chatId, 'human', ref);
    if (!found.ok) return found;
    const task = found.task;
    const chat = this.group(chatId);
    const bot = this.deps.bots.get(botId);
    if (!chat?.members.includes(botId) || !bot || bot.archivedAt !== undefined)
      return { ok: false, error: 'Member unavailable.' };
    if (task.status === 'done' || task.status === 'canceled' || task.delegationId)
      return { ok: false, error: busy(task, this) };
    const written = this.write(chatId, {
      ...task,
      status: 'doing',
      assigneeBotId: botId,
      updatedAt: this.now(),
    });
    if (!written.ok) return written;
    const sent = this.deps.send
      ? await this.deps.send(chatId, `@${bot.name} 请处理任务 #${task.seq}：${task.title}`)
      : { ok: false as const, error: 'group-not-ready' };
    if (sent.ok) return written;
    const current = this.deps.store.find(chatId, task.id);
    if (current?.updatedAt === written.task.updatedAt && current.assigneeBotId === botId)
      this.write(chatId, { ...task, updatedAt: this.now() });
    return { ok: false, error: sent.error };
  }

  remove(chatId: string, ref: string): { ok: true } | { ok: false; error: string } {
    const found = this.resolve(chatId, 'human', ref);
    if (!found.ok) return found;
    if (!this.deps.store.remove(chatId, found.task.id)) return { ok: false, error: 'not-found' };
    this.cancelLinked(found.task);
    this.deps.emit({ kind: 'tasks', chatId });
    return { ok: true };
  }

  /** 委派带 taskId 前的校验：返回规范 taskId */
  gate(chatId: string | null, ref: string, parentBotId: string): TaskGate {
    if (!chatId || !this.group(chatId))
      return { ok: false, error: 'Tasks are only available in group chats.' };
    const task = this.deps.store.find(chatId, ref);
    if (!task)
      return {
        ok: false,
        error: `Task ${ref.startsWith('#') ? ref : `#${ref}`} not found in this group.`,
      };
    const free =
      !task.delegationId &&
      (task.status === 'todo' || (task.status === 'doing' && task.assigneeBotId === parentBotId));
    return free ? { ok: true, taskId: task.id } : { ok: false, error: busy(task, this) };
  }

  /** 委派记录每次落盘后调用：按状态机同步任务 */
  sync(record: Delegation): void {
    if (!record.taskId || !record.chatId || !this.group(record.chatId)) return;
    const task = this.deps.store.find(record.chatId, record.taskId);
    const next = task && taskAfterDelegation(task, record, this.now());
    if (!task || !next) return;
    const text = isActiveDelegation(record)
      ? `${this.name(record.parentBotId)} 把 ${label(task)} 委派给 ${this.name(record.targetBotId)}`
      : next.status === 'done'
        ? `${this.name(record.targetBotId)} 完成了 ${label(task)}${next.result ? `：${short(next.result)}` : ''}`
        : `${label(task)} 的委派未完成，已退回待办`;
    this.write(record.chatId, next, text);
  }

  /** 成员离开某群 / 被删除：其认领中的任务退回 todo */
  releaseMember(chatId: string, botId: string): void {
    if (!this.deps.chats.get(chatId)) return;
    for (const task of this.deps.store.list(chatId)) {
      if (task.status !== 'doing' || task.assigneeBotId !== botId) continue;
      const { assigneeBotId: _assignee, delegationId: _delegation, ...rest } = task;
      this.linkedAfter(
        task,
        this.write(
          chatId,
          { ...rest, status: 'todo', updatedAt: this.now() },
          `${label(task)} 的负责人已离开，退回待办`
        )
      );
    }
  }

  releaseBot(botId: string): void {
    for (const chat of this.deps.chats.list())
      if (chat.kind === 'group') this.releaseMember(chat.id, botId);
  }

  forget(chatId: string): void {
    this.deps.store.forget(chatId);
  }

  /** group_tasks 工具入口；参数已在 worker 侧归一化，这里仍按 unknown 收窄 */
  tool(chatId: string, botId: string, params: Record<string, unknown>): unknown {
    const text = (key: string) =>
      typeof params[key] === 'string' ? (params[key] as string) : undefined;
    const id = text('id');
    const needId = (run: (ref: string) => TaskResult): unknown =>
      id ? this.view(run(id)) : { ok: false, error: `Specify id for action ${params.action}.` };
    switch (params.action) {
      case 'list': {
        const denied = this.check(chatId, botId);
        if (denied) return denied;
        const tasks = this.deps.store.list(chatId).filter((task) => task.status !== 'canceled');
        return { ok: true, tasks: tasks.map((task) => this.brief(task)) };
      }
      case 'add': {
        const title = text('title');
        if (!title) return { ok: false, error: 'Specify title for action add.' };
        const detail = text('detail');
        return this.view(this.add(chatId, botId, { title, ...(detail ? { detail } : {}) }));
      }
      case 'claim':
        return needId((ref) => this.claim(chatId, botId, ref));
      case 'update': {
        const title = text('title');
        const detail = text('detail');
        if (title === undefined && detail === undefined)
          return { ok: false, error: 'Specify title or detail for action update.' };
        return needId((ref) =>
          this.update(chatId, botId, ref, {
            ...(title !== undefined ? { title } : {}),
            ...(detail !== undefined ? { detail } : {}),
          })
        );
      }
      case 'complete':
        return needId((ref) => this.complete(chatId, botId, ref, text('result')));
      case 'cancel':
        return needId((ref) => this.cancel(chatId, botId, ref));
      default:
        return {
          ok: false,
          error: `Unknown action. Use one of: ${GROUP_TASK_ACTIONS.join(', ')}.`,
        };
    }
  }

  name(actor: TaskActor): string {
    if (actor === 'human') return TRANSCRIPT_LABELS.human;
    return this.deps.bots.get(actor)?.name ?? TRANSCRIPT_LABELS.deleted;
  }

  private brief(task: GroupTask) {
    return {
      id: `#${task.seq}`,
      title: task.title,
      status: task.status,
      ...(task.detail ? { detail: task.detail } : {}),
      ...(task.assigneeBotId ? { assignee: this.name(task.assigneeBotId) } : {}),
      createdBy: this.name(task.createdBy),
      ...(task.result ? { result: task.result } : {}),
    };
  }

  private view(result: TaskResult): unknown {
    return result.ok ? { ok: true, task: this.brief(result.task) } : result;
  }

  private group(chatId: string): BotChat | undefined {
    const chat = this.deps.chats.get(chatId);
    return chat?.kind === 'group' ? chat : undefined;
  }

  /** 群存在且未归档；成员动作要求仍在群里且未归档 */
  private check(chatId: string, actor: TaskActor): { ok: false; error: string } | undefined {
    const chat = this.group(chatId);
    if (!chat) return { ok: false, error: 'Tasks are only available in group chats.' };
    if (chat.archivedAt !== undefined) return { ok: false, error: 'This group is archived.' };
    if (actor === 'human') return undefined;
    const bot = this.deps.bots.get(actor);
    if (!bot || bot.archivedAt !== undefined || !chat.members.includes(actor))
      return { ok: false, error: 'You are not a member of this group.' };
    return undefined;
  }

  private resolve(chatId: string, actor: TaskActor, ref: string): TaskResult {
    const denied = this.check(chatId, actor);
    if (denied) return denied;
    const task = this.deps.store.find(chatId, ref);
    return task
      ? { ok: true, task }
      : {
          ok: false,
          error: `Task ${ref.startsWith('#') ? ref : `#${ref}`} not found in this group.`,
        };
  }

  /** 先落新状态再取消关联委派：委派终态同步时任务已不归它负责，不会二次改写 */
  private linkedAfter(previous: GroupTask, result: TaskResult): TaskResult {
    if (result.ok) this.cancelLinked(previous);
    return result;
  }

  private cancelLinked(task: GroupTask): void {
    if (task.delegationId && task.status === 'doing')
      this.deps.cancelDelegation?.(task.delegationId);
  }

  private write(chatId: string, task: GroupTask, systemText?: string): TaskResult {
    const saved = this.deps.store.save(chatId, task);
    if (!saved) return { ok: false, error: 'Task not saved.' };
    this.changed(chatId, systemText);
    return { ok: true, task: saved };
  }

  private changed(chatId: string, systemText?: string): void {
    if (systemText) {
      const entry = this.deps.chats.appendEntry(chatId, {
        kind: 'system',
        id: randomUUID(),
        at: this.now(),
        text: systemText,
      });
      if (entry) this.deps.emit({ kind: 'timeline', chatId, seq: entry.seq });
    }
    this.deps.emit({ kind: 'tasks', chatId });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function busy(task: GroupTask, service: GroupTaskService): string {
  if (task.status === 'done') return `Task #${task.seq} is already done.`;
  if (task.status === 'canceled') return `Task #${task.seq} was canceled.`;
  if (task.delegationId)
    return `Task #${task.seq} is already delegated to ${service.name(task.assigneeBotId ?? '')}.`;
  return `Task #${task.seq} is already claimed by ${service.name(task.assigneeBotId ?? '')}.`;
}
