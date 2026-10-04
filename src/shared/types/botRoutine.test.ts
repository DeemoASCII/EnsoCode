import { describe, expect, it } from 'vitest';
import { parseBotRoutine } from './bot';

const base = {
  id: '66666666-6666-4666-8666-666666666666',
  botId: '22222222-2222-4222-8222-222222222222',
  title: '早报',
  prompt: '汇总',
  schedule: '0 9 * * *',
  chatId: '33333333-3333-4333-8333-333333333333',
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
};

describe('parseBotRoutine', () => {
  it('合法记录原样收窄，可选字段只在合法时保留', () => {
    expect(parseBotRoutine(base)).toEqual(base);
    expect(
      parseBotRoutine({ ...base, lastRunAt: 3, lastResult: 'error', missed: 2, extra: 1 })
    ).toEqual({ ...base, lastRunAt: 3, lastResult: 'error', missed: 2 });
    expect(parseBotRoutine({ ...base, lastResult: 'boom', missed: -1, lastRunAt: 'x' })).toEqual(
      base
    );
    expect(parseBotRoutine({ ...base, lastResult: 'budget' })?.lastResult).toBe('budget');
  });

  it('脏输入拒绝', () => {
    for (const bad of [
      null,
      [],
      { ...base, id: 'x' },
      { ...base, botId: '../a' },
      { ...base, chatId: 1 },
      { ...base, title: '' },
      { ...base, prompt: 1 },
      { ...base, schedule: 'every day' },
      { ...base, enabled: 'yes' },
      { ...base, createdAt: -1 },
    ]) {
      expect(parseBotRoutine(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});
