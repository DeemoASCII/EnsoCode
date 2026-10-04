import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotRoutine } from '../../../shared/types/bot';
import { RoutineScheduler } from './routineScheduler';

const base: BotRoutine = {
  id: 'r',
  botId: 'b',
  chatId: 'c',
  title: 'daily',
  prompt: 'work',
  schedule: '* * * * *',
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  lastRunAt: 0,
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(180_000);
});
afterEach(() => vi.useRealTimers());
function setup(routines = [{ ...base }]) {
  const run = vi.fn(async () => ({ ok: true }));
  const markRun = vi.fn((botId, id, result, missed = 0) => {
    const routine = routines.find((r) => r.id === id && r.botId === botId);
    if (routine) Object.assign(routine, { lastRunAt: Date.now(), lastResult: result, missed });
    return routine;
  });
  const scheduler = new RoutineScheduler({
    store: { listAll: () => routines, markRun },
    run,
    eligible: () => true,
    emit: () => {},
  });
  return { scheduler, run, markRun, routines };
}
it('does not backfill missed triggers; uses one timer and marks completion', async () => {
  const f = setup();
  f.scheduler.start();
  expect(f.markRun).toHaveBeenCalledWith('b', 'r', 'skipped', 3);
  expect(f.run).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(f.markRun).toHaveBeenLastCalledWith('b', 'r', 'ok');
  f.scheduler.stop();
  expect(vi.getTimerCount()).toBe(0);
});
it('recomputes on edits and truncates very long delays without firing early', async () => {
  const f = setup([{ ...base, schedule: '0 0 1 1 *', lastRunAt: undefined }]);
  f.scheduler.start();
  await vi.advanceTimersByTimeAsync(2_147_483_647);
  expect(f.run).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  f.routines[0].schedule = '* * * * *';
  f.scheduler.refresh();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.run).toHaveBeenCalledTimes(1);
  f.scheduler.stop();
});
it('records a budget refusal as its own result', async () => {
  const f = setup();
  f.scheduler.start();
  f.run.mockResolvedValueOnce({ ok: false, error: 'budget-exceeded' } as never);
  expect(await f.scheduler.runNow('b', 'r')).toMatchObject({ ok: false });
  expect(f.markRun).toHaveBeenLastCalledWith('b', 'r', 'budget');
  f.run.mockResolvedValueOnce({ ok: false, error: 'boom' } as never);
  await f.scheduler.runNow('b', 'r');
  expect(f.markRun).toHaveBeenLastCalledWith('b', 'r', 'error');
  f.scheduler.stop();
});
