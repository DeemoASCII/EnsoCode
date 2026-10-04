import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GROUP_TASK_TEXT_MAX,
  GROUP_TASK_TITLE_MAX,
  type GroupTask,
  isBotChatId,
  parseGroupTask,
} from '../../../shared/types/bot';

interface ChatTasks {
  tasks: Map<string, GroupTask>;
  maxSeq: number;
}

/**
 * 群任务看板：userData/bot-chats/<chatId>/tasks.jsonl，append-only 整条快照（后写覆盖），
 * 删除写墓碑 `{id, seq, deleted:true}`；坏行 / 截断行跳过。seq 取历史最大值 +1，删除后不复用。
 * 读写都是同步的：Main 单线程下「读-判-写」天然原子，并发认领由调用方在一次同步调用里完成。
 */
export class GroupTaskStore {
  private readonly cache = new Map<string, ChatTasks>();
  constructor(private readonly root: string) {}

  list(chatId: string): GroupTask[] {
    if (!isBotChatId(chatId)) return [];
    return [...this.load(chatId).tasks.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((task) => ({ ...task }));
  }

  /** id 或 `#N` / `N` */
  find(chatId: string, ref: string): GroupTask | undefined {
    if (!isBotChatId(chatId)) return undefined;
    const { tasks } = this.load(chatId);
    const direct = tasks.get(ref);
    if (direct) return { ...direct };
    const match = /^#?(\d+)$/.exec(ref.trim());
    if (!match) return undefined;
    const seq = Number(match[1]);
    const task = [...tasks.values()].find((item) => item.seq === seq);
    return task && { ...task };
  }

  create(
    chatId: string,
    input: { title: string; detail?: string; createdBy: GroupTask['createdBy'] },
    now: number
  ): GroupTask | undefined {
    if (!isBotChatId(chatId)) return undefined;
    const title = input.title.trim().slice(0, GROUP_TASK_TITLE_MAX);
    if (!title) return undefined;
    const detail = input.detail?.trim().slice(0, GROUP_TASK_TEXT_MAX);
    const task: GroupTask = {
      id: randomUUID(),
      seq: this.load(chatId).maxSeq + 1,
      title,
      ...(detail ? { detail } : {}),
      status: 'todo',
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    return this.save(chatId, task);
  }

  save(chatId: string, task: GroupTask): GroupTask | undefined {
    const parsed = isBotChatId(chatId) ? parseGroupTask(task) : undefined;
    if (!parsed) return undefined;
    const state = this.load(chatId);
    this.append(chatId, parsed);
    state.tasks.set(parsed.id, parsed);
    state.maxSeq = Math.max(state.maxSeq, parsed.seq);
    return { ...parsed };
  }

  remove(chatId: string, id: string): boolean {
    if (!isBotChatId(chatId)) return false;
    const state = this.load(chatId);
    const task = state.tasks.get(id);
    if (!task) return false;
    this.append(chatId, { id, seq: task.seq, deleted: true });
    state.tasks.delete(id);
    return true;
  }

  /** 聊天目录被删后丢掉缓存 */
  forget(chatId: string): void {
    this.cache.delete(chatId);
  }

  private file(chatId: string): string {
    return join(this.root, chatId, 'tasks.jsonl');
  }

  private append(chatId: string, record: unknown): void {
    mkdirSync(join(this.root, chatId), { recursive: true });
    // 前导换行把上次可能撕裂的末行隔开
    appendFileSync(this.file(chatId), `\n${JSON.stringify(record)}\n`, 'utf8');
  }

  private load(chatId: string): ChatTasks {
    const cached = this.cache.get(chatId);
    if (cached) return cached;
    const state: ChatTasks = { tasks: new Map(), maxSeq: 0 };
    let text = '';
    try {
      text = readFileSync(this.file(chatId), 'utf8');
    } catch {
      /* 尚无任务 */
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (value?.deleted === true && typeof value.id === 'string') {
          state.tasks.delete(value.id);
          if (Number.isSafeInteger(value.seq))
            state.maxSeq = Math.max(state.maxSeq, value.seq as number);
          continue;
        }
        const task = parseGroupTask(value);
        if (!task) continue;
        state.tasks.set(task.id, task);
        state.maxSeq = Math.max(state.maxSeq, task.seq);
      } catch {
        /* torn or invalid line */
      }
    }
    this.cache.set(chatId, state);
    return state;
  }
}
