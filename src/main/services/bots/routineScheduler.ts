import { missedRuns, nextRun, parseCron } from '../../../shared/bots/cron';
import type { BotRoutine } from '../../../shared/types/bot';
import type { BotEvent } from '../../../shared/types/botIpc';
import { BOT_BUDGET_ERROR } from '../../../shared/usage/botUsage';
import type { BotRoutineStore } from './routineStore';

interface Deps {
  store: Pick<BotRoutineStore, 'listAll' | 'markRun'>;
  eligible: (routine: BotRoutine) => boolean;
  run: (routine: BotRoutine) => Promise<{ ok: boolean; error?: string }>;
  emit: (event: BotEvent) => void;
}

export class RoutineScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private enabled = false;
  private due = new Map<string, number>();
  constructor(private readonly deps: Deps) {}

  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    for (const routine of this.deps.store.listAll()) {
      const cron = parseCron(routine.schedule);
      if (!routine.enabled || !cron || !this.deps.eligible(routine)) continue;
      const missed = missedRuns(cron, routine.lastRunAt ?? routine.createdAt, Date.now());
      if (missed) {
        this.deps.store.markRun(routine.botId, routine.id, 'skipped', missed);
        this.deps.emit({ kind: 'routine' });
      }
    }
    this.refresh();
  }

  stop(): void {
    this.enabled = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.due.clear();
  }

  refresh(): void {
    clearTimeout(this.timer);
    this.due.clear();
    if (!this.enabled) return;
    for (const routine of this.deps.store.listAll()) {
      if (!routine.enabled || !this.deps.eligible(routine)) continue;
      const cron = parseCron(routine.schedule);
      const next = cron && nextRun(cron, Date.now());
      if (next !== undefined) this.due.set(routine.id, next);
    }
    this.arm();
  }

  async runNow(botId: string, id: string): Promise<{ ok: boolean; error?: string }> {
    const routine = this.deps.store
      .listAll()
      .find((item) => item.id === id && item.botId === botId);
    if (!this.enabled || !routine || !this.deps.eligible(routine))
      return { ok: false, error: 'Routine unavailable.' };
    return this.execute(routine);
  }

  private async execute(routine: BotRoutine): Promise<{ ok: boolean; error?: string }> {
    let result: { ok: boolean; error?: string };
    try {
      result = await this.deps.run(routine);
    } catch (error) {
      result = { ok: false, error: String(error) };
    }
    this.deps.store.markRun(
      routine.botId,
      routine.id,
      result.ok ? 'ok' : result.error === BOT_BUDGET_ERROR ? 'budget' : 'error'
    );
    this.deps.emit({ kind: 'routine' });
    return result;
  }

  private arm(): void {
    if (!this.enabled || !this.due.size) return;
    const delay = Math.max(0, Math.min(...this.due.values()) - Date.now());
    this.timer = setTimeout(
      () => {
        for (const routine of this.deps.store.listAll()) {
          const at = this.due.get(routine.id);
          if (
            at !== undefined &&
            at <= Date.now() &&
            routine.enabled &&
            this.deps.eligible(routine)
          )
            void this.execute(routine);
        }
        this.refresh();
      },
      Math.min(delay, 2_147_483_647)
    );
    this.timer.unref?.();
  }
}
