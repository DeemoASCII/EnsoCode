import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MISSED_RUNS_MAX, parseCron } from '../../../shared/bots/cron';
import {
  type BotRoutine,
  type BotRoutineResult,
  isBotChatId,
  isBotId,
  parseBotRoutine,
} from '../../../shared/types/bot';
import { readJson, writeJsonAtomic } from './files';

export interface BotRoutineDraft {
  /** 缺省新建；给定则更新已有条目 */
  id?: string;
  title: string;
  prompt: string;
  schedule: string;
  chatId: string;
  enabled?: boolean;
}

export type BotRoutineWriteResult =
  | { ok: true; routine: BotRoutine }
  | { ok: false; reason: 'invalid' | 'not-found' };

/** userData/bots/<botId>/routines.json；每次读盘，路径只由 botId（uuid）推导 */
export class BotRoutineStore {
  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now
  ) {}

  list(botId: string): BotRoutine[] {
    if (!isBotId(botId)) return [];
    const raw = readJson(this.file(botId));
    const items =
      raw && typeof raw === 'object' && Array.isArray((raw as { routines?: unknown }).routines)
        ? ((raw as { routines: unknown[] }).routines as unknown[])
        : [];
    return items
      .map(parseBotRoutine)
      .filter((routine): routine is BotRoutine => routine?.botId === botId);
  }

  listAll(): BotRoutine[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.root);
    } catch {
      return [];
    }
    return names.filter(isBotId).flatMap((botId) => this.list(botId));
  }

  save(botId: string, draft: BotRoutineDraft): BotRoutineWriteResult {
    const title = typeof draft.title === 'string' ? draft.title.trim() : '';
    const prompt = typeof draft.prompt === 'string' ? draft.prompt.trim() : '';
    const cron = typeof draft.schedule === 'string' ? parseCron(draft.schedule) : undefined;
    if (!isBotId(botId) || !title || !prompt || !cron || !isBotChatId(draft.chatId)) {
      return { ok: false, reason: 'invalid' };
    }
    const routines = this.list(botId);
    const now = this.now();
    const fields = {
      title,
      prompt,
      schedule: cron.source,
      chatId: draft.chatId,
      enabled: draft.enabled ?? true,
      updatedAt: now,
    };
    if (draft.id === undefined) {
      const routine: BotRoutine = { id: randomUUID(), botId, ...fields, createdAt: now };
      this.write(botId, [...routines, routine]);
      return { ok: true, routine };
    }
    const index = routines.findIndex((item) => item.id === draft.id);
    if (index < 0) return { ok: false, reason: 'not-found' };
    const routine: BotRoutine = { ...routines[index], ...fields };
    routines[index] = routine;
    this.write(botId, routines);
    return { ok: true, routine };
  }

  remove(botId: string, id: string): boolean {
    const routines = this.list(botId);
    const rest = routines.filter((item) => item.id !== id);
    if (rest.length === routines.length) return false;
    this.write(botId, rest);
    return true;
  }

  /** missed > 0 记录错过次数（截断到 99），否则清掉 */
  markRun(botId: string, id: string, result: BotRoutineResult, missed = 0): BotRoutine | undefined {
    const routines = this.list(botId);
    const index = routines.findIndex((item) => item.id === id);
    if (index < 0) return undefined;
    const { missed: _previous, ...rest } = routines[index];
    const routine: BotRoutine = { ...rest, lastRunAt: this.now(), lastResult: result };
    if (missed > 0) routine.missed = Math.min(MISSED_RUNS_MAX, Math.floor(missed));
    routines[index] = routine;
    this.write(botId, routines);
    return routine;
  }

  private file(botId: string): string {
    return join(this.root, botId, 'routines.json');
  }

  private write(botId: string, routines: BotRoutine[]): void {
    writeJsonAtomic(this.file(botId), { routines });
  }
}
