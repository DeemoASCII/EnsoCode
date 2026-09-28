import { describe, expect, it } from 'vitest';
import {
  attemptClaim,
  canFinishTask,
  type EnsobotTask,
  parseQueueDocument,
  wakeOneWaiter,
} from './queue';

function task(overrides: Partial<EnsobotTask> = {}): EnsobotTask {
  return {
    id: 't1',
    cardId: 'card-a',
    title: '修测试',
    workspaceKey: 'project-1',
    status: 'queued',
    check: 'pnpm test',
    ...overrides,
  };
}

describe('ensobot queue', () => {
  it('坏行跳过，其余任务还在', () => {
    const parsed = parseQueueDocument(
      ['not-json', JSON.stringify(task()), '{', JSON.stringify(task({ id: 't2' }))].join('\n')
    );
    expect(parsed.skipped).toBe(2);
    expect(parsed.tasks.map((item) => item.id)).toEqual(['t1', 't2']);
  });

  it('先占槽，槽满就继续排队', () => {
    const full = [task({ id: 'busy', status: 'doing' })];
    const result = attemptClaim([...full, task({ id: 't2' })], {
      taskId: 't2',
      cardId: 'card-a',
      slotLimit: 1,
    });
    expect(result.outcome).toBe('stay-queued');
    expect(result.tasks.find((item) => item.id === 't2')?.status).toBe('queued');
  });

  it('两个人抢同一条，后一个看见它已被领', () => {
    const first = attemptClaim([task()], { taskId: 't1', cardId: 'card-a', slotLimit: 1 });
    const second = attemptClaim(first.tasks, { taskId: 't1', cardId: 'card-b', slotLimit: 1 });
    expect(first.outcome).toBe('claimed');
    expect(second.outcome).toBe('taken');
    expect(second.tasks.find((item) => item.id === 't1')?.claimerId).toBe('card-a');
  });

  it('目录已被占用时进入等待，释放后只唤醒一个', () => {
    const tasks = [
      task({ id: 'writer', status: 'doing' }),
      task({ id: 'wait-1', status: 'queued' }),
      task({ id: 'wait-2', status: 'queued' }),
    ];
    const first = attemptClaim(tasks, { taskId: 'wait-1', cardId: 'card-b', slotLimit: 2 });
    const second = attemptClaim(first.tasks, { taskId: 'wait-2', cardId: 'card-c', slotLimit: 2 });
    expect(first.outcome).toBe('waiting-directory');
    expect(second.outcome).toBe('waiting-directory');
    const released = wakeOneWaiter(
      second.tasks.map((item) =>
        item.id === 'writer' ? { ...item, status: 'done' as const } : item
      ),
      'project-1'
    );
    expect(released.filter((item) => item.status === 'queued').map((item) => item.id)).toEqual([
      'wait-1',
    ]);
    expect(released.find((item) => item.id === 'wait-2')?.status).toBe('waiting-directory');
  });

  it('没有检查结果就不能算做完，留言文本不算工具输出', () => {
    expect(canFinishTask({ check: '', toolOutputs: ['pnpm test'] })).toBe(false);
    expect(
      canFinishTask({ check: 'pnpm test', toolOutputs: [], boardText: '板上写了 pnpm test' })
    ).toBe(false);
    expect(canFinishTask({ check: 'pnpm test', toolOutputs: ['pnpm test passed'] })).toBe(true);
  });
});
