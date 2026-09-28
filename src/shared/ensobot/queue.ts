export type EnsobotTaskStatus =
  | 'queued'
  | 'claimed'
  | 'doing'
  | 'waiting-directory'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface EnsobotTask {
  id: string;
  cardId: string;
  title: string;
  /** 项目 id 或会话 id。界面不拿目录路径。 */
  workspaceKey: string;
  status: EnsobotTaskStatus;
  check: string;
  claimerId?: string;
  sessionId?: string;
  fellBack?: boolean;
  providerId?: string;
  modelId?: string;
  note?: string;
}

const STATUSES = new Set<EnsobotTaskStatus>([
  'queued',
  'claimed',
  'doing',
  'waiting-directory',
  'done',
  'failed',
  'cancelled',
]);

function isTask(value: unknown): value is EnsobotTask {
  if (!value || typeof value !== 'object') return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task.id === 'string' &&
    task.id.length > 0 &&
    typeof task.cardId === 'string' &&
    typeof task.title === 'string' &&
    typeof task.workspaceKey === 'string' &&
    typeof task.status === 'string' &&
    STATUSES.has(task.status as EnsobotTaskStatus) &&
    typeof task.check === 'string'
  );
}

/** 坏行跳过。同一个 id 只留第一次出现的那条，一行坏掉不会让整份队列作废。 */
export function parseQueueDocument(text: string): { tasks: EnsobotTask[]; skipped: number } {
  const tasks: EnsobotTask[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isTask(parsed) || seen.has(parsed.id)) {
        skipped += 1;
        continue;
      }
      seen.add(parsed.id);
      tasks.push(parsed);
    } catch {
      skipped += 1;
    }
  }
  return { tasks, skipped };
}

export function serializeQueue(tasks: readonly EnsobotTask[]): string {
  return tasks.map((task) => JSON.stringify(task)).join('\n');
}

export function slotsUsed(tasks: readonly EnsobotTask[], cardId: string): number {
  return tasks.filter(
    (task) => task.cardId === cardId && (task.status === 'claimed' || task.status === 'doing')
  ).length;
}

export function directoryBusy(
  tasks: readonly EnsobotTask[],
  workspaceKey: string,
  exceptTaskId?: string
): boolean {
  return tasks.some(
    (task) =>
      task.id !== exceptTaskId &&
      task.workspaceKey === workspaceKey &&
      (task.status === 'claimed' || task.status === 'doing')
  );
}

export type ClaimOutcome = 'claimed' | 'stay-queued' | 'waiting-directory' | 'taken' | 'missing';

/**
 * 先占这个人的并发槽，占不上就继续排队。
 * 同一条任务只能有一个认领者。目录上已经有人在写，就停在等目录，不把先开始的那个掐掉。
 */
export function attemptClaim(
  tasks: readonly EnsobotTask[],
  input: { taskId: string; cardId: string; slotLimit: number }
): { tasks: EnsobotTask[]; outcome: ClaimOutcome } {
  const index = tasks.findIndex((task) => task.id === input.taskId);
  if (index < 0) return { tasks: [...tasks], outcome: 'missing' };
  const task = tasks[index];
  if (task.status !== 'queued' && task.status !== 'waiting-directory') {
    return { tasks: [...tasks], outcome: 'taken' };
  }
  const next = tasks.map((item) => ({ ...item }));
  if (slotsUsed(next, input.cardId) >= input.slotLimit) {
    next[index] = { ...task, status: 'queued', claimerId: undefined };
    return { tasks: next, outcome: 'stay-queued' };
  }
  if (directoryBusy(next, task.workspaceKey, task.id)) {
    next[index] = { ...task, status: 'waiting-directory', claimerId: undefined };
    return { tasks: next, outcome: 'waiting-directory' };
  }
  next[index] = { ...task, status: 'claimed', claimerId: input.cardId };
  return { tasks: next, outcome: 'claimed' };
}

/** 目录释放后只唤醒一个等待者，让它重新去占槽。其余继续等。 */
export function wakeOneWaiter(tasks: readonly EnsobotTask[], workspaceKey: string): EnsobotTask[] {
  let woken = false;
  return tasks.map((task) => {
    if (woken || task.workspaceKey !== workspaceKey || task.status !== 'waiting-directory') {
      return task;
    }
    woken = true;
    return { ...task, status: 'queued' };
  });
}

/** 留言板上的一句话不能把任务标成做完。检查文本必须出现在工具输出里。 */
export function canFinishTask(input: {
  check: string;
  toolOutputs: readonly string[];
  boardText?: string;
}): boolean {
  const check = input.check.trim();
  if (!check) return false;
  void input.boardText;
  return input.toolOutputs.some((output) => output.includes(check));
}
