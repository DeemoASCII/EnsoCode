import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotRoutineStore } from './routineStore';

const BOT = '22222222-2222-4222-8222-222222222222';
const BOT2 = '55555555-5555-4555-8555-555555555555';
const CHAT = '33333333-3333-4333-8333-333333333333';

let root: string;
let clock = 1000;
const now = () => ++clock;
let store: BotRoutineStore;
const draft = { title: '早报', prompt: '汇总昨天的提交', schedule: '0 9 * * 1-5', chatId: CHAT };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bot-routines-'));
  store = new BotRoutineStore(root, now);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('BotRoutineStore', () => {
  it('新建后落盘到 <botId>/routines.json，重开仍在', () => {
    const saved = store.save(BOT, draft);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.routine).toMatchObject({
      ...draft,
      botId: BOT,
      enabled: true,
      createdAt: saved.routine.updatedAt,
    });
    expect(JSON.parse(readFileSync(join(root, BOT, 'routines.json'), 'utf8'))).toBeTruthy();
    expect(new BotRoutineStore(root, now).list(BOT)).toEqual([saved.routine]);
  });

  it('更新保留 createdAt 与运行记录；未知 id → not-found', () => {
    const created = store.save(BOT, draft);
    if (!created.ok) throw new Error('setup');
    const id = created.routine.id;
    store.markRun(BOT, id, 'ok');
    const updated = store.save(BOT, { ...draft, id, title: '周报', enabled: false });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.routine).toMatchObject({
      id,
      title: '周报',
      enabled: false,
      createdAt: created.routine.createdAt,
      lastResult: 'ok',
    });
    expect(updated.routine.updatedAt).toBeGreaterThan(created.routine.updatedAt);
    expect(store.save(BOT, { ...draft, id: '99999999-9999-4999-8999-999999999999' })).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('非法输入拒绝：空标题 / 空 prompt / 坏 cron / 坏 chatId / 坏 botId', () => {
    for (const bad of [
      { ...draft, title: '  ' },
      { ...draft, prompt: '' },
      { ...draft, schedule: '61 * * * *' },
      { ...draft, chatId: '../x' },
    ]) {
      expect(store.save(BOT, bad)).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(store.save('../evil', draft)).toEqual({ ok: false, reason: 'invalid' });
    expect(store.list('../evil')).toEqual([]);
    expect(store.remove('../evil', 'x')).toBe(false);
    expect(store.list(BOT)).toEqual([]);
  });

  it('markRun 记录时间、结果与错过次数；错过次数截断到 99', () => {
    const created = store.save(BOT, draft);
    if (!created.ok) throw new Error('setup');
    const ran = store.markRun(BOT, created.routine.id, 'skipped', 500);
    expect(ran).toMatchObject({ lastResult: 'skipped', missed: 99 });
    expect(ran?.lastRunAt).toBeGreaterThan(created.routine.createdAt);
    const ok = store.markRun(BOT, created.routine.id, 'ok');
    expect(ok?.lastResult).toBe('ok');
    expect(ok).not.toHaveProperty('missed');
    expect(store.markRun(BOT, 'nope', 'ok')).toBeUndefined();
  });

  it('remove 删单条；listAll 汇总所有成员', () => {
    const a = store.save(BOT, draft);
    const b = store.save(BOT2, { ...draft, title: 'B' });
    if (!a.ok || !b.ok) throw new Error('setup');
    expect(
      store
        .listAll()
        .map((r) => r.id)
        .sort()
    ).toEqual([a.routine.id, b.routine.id].sort());
    expect(store.remove(BOT, a.routine.id)).toBe(true);
    expect(store.remove(BOT, a.routine.id)).toBe(false);
    expect(store.listAll().map((r) => r.id)).toEqual([b.routine.id]);
  });

  it('坏文件当空；单条坏记录丢弃；botId 与目录不符的记录丢弃', () => {
    mkdirSync(join(root, BOT), { recursive: true });
    writeFileSync(join(root, BOT, 'routines.json'), '{not json');
    expect(store.list(BOT)).toEqual([]);
    const good = {
      ...draft,
      id: '66666666-6666-4666-8666-666666666666',
      botId: BOT,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    writeFileSync(
      join(root, BOT, 'routines.json'),
      JSON.stringify({
        routines: [
          good,
          { ...good, id: 'x' },
          { ...good, id: '77777777-7777-4777-8777-777777777777', botId: BOT2 },
        ],
      })
    );
    expect(store.list(BOT).map((r) => r.id)).toEqual([good.id]);
    mkdirSync(join(root, 'not-a-bot'));
    expect(store.listAll().map((r) => r.id)).toEqual([good.id]);
  });
});
