import type { ProjectedMessage } from '@shared/types/agent';
import type { GroupEntry } from '@shared/types/bot';
import { describe, expect, it } from 'vitest';
import { buildRows, locateTurn, mergeLatest, mergeOlder, turnSteps } from './groupTimeline';

const human = (seq: number, at = seq * 1000): GroupEntry => ({
  kind: 'human',
  seq,
  id: `h${seq}`,
  at,
  text: `t${seq}`,
  mentions: [],
});
const bot = (seq: number, botId: string, at = seq * 1000): GroupEntry => ({
  kind: 'bot',
  seq,
  id: `b${seq}`,
  at,
  botId,
  text: `r${seq}`,
  conversationId: 'c',
  turnId: 't',
});

describe('mergeLatest', () => {
  it('与已有尾部相接时按 seq 去重合并', () => {
    const result = mergeLatest([human(1), human(2)], [human(2), human(3)]);
    expect(result.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(result.gap).toBe(false);
  });

  it('新页与已有内容之间有空洞时整体替换并标记 gap', () => {
    const result = mergeLatest([human(1)], [human(5), human(6)]);
    expect(result.entries.map((e) => e.seq)).toEqual([5, 6]);
    expect(result.gap).toBe(true);
  });

  it('空页不改动', () => {
    const entries = [human(1)];
    expect(mergeLatest(entries, []).entries).toBe(entries);
  });
});

describe('mergeOlder', () => {
  it('前置更早一页并去重', () => {
    expect(
      mergeOlder([human(3), human(4)], [human(1), human(2), human(3)]).map((e) => e.seq)
    ).toEqual([1, 2, 3, 4]);
  });
});

describe('buildRows', () => {
  it('同一作者五分钟内的连续消息合并头像', () => {
    const rows = buildRows([
      bot(1, 'x', 1000),
      bot(2, 'x', 2000),
      bot(3, 'y', 3000),
      human(4, 4000),
    ]);
    const entries = rows.filter((row) => row.kind === 'entry');
    expect(entries.map((row) => row.continued)).toEqual([false, true, false, false]);
  });

  it('跨天插入日期分隔，分隔后不合并', () => {
    const day1 = new Date(2026, 0, 1, 23, 59).getTime();
    const day2 = new Date(2026, 0, 2, 0, 1).getTime();
    const rows = buildRows([bot(1, 'x', day1), bot(2, 'x', day2)]);
    expect(rows.map((row) => row.kind)).toEqual(['day', 'entry', 'day', 'entry']);
    expect(rows[3].kind === 'entry' && rows[3].continued).toBe(false);
  });

  it('系统消息与委派卡片不参与合并', () => {
    const system: GroupEntry = { kind: 'system', seq: 2, id: 's', at: 1500, text: 'x' };
    const rows = buildRows([bot(1, 'x', 1000), system, bot(3, 'x', 2000)]);
    const entries = rows.filter((row) => row.kind === 'entry');
    expect(entries.map((row) => row.continued)).toEqual([false, false, false]);
  });
});

const text = (role: string, value: string): ProjectedMessage => ({
  role,
  content: [{ type: 'text', text: value }],
});
const call = (id: string, name: string, args: Record<string, unknown>): ProjectedMessage => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id, name, arguments: args }],
});
const result = (id: string, isError = false): ProjectedMessage => ({
  role: 'toolResult',
  toolCallId: id,
  isError,
  content: [],
});

describe('locateTurn', () => {
  const messages = [
    text('user', 'q1'),
    text('assistant', 'answer one'),
    text('user', 'q2'),
    call('1', 'read', { path: 'a.ts' }),
    result('1'),
    text('assistant', 'answer two'),
    text('user', 'q3'),
    text('assistant', 'answer three'),
  ];

  it('按最终回复文本定位到该轮（从对应 user 消息起）', () => {
    expect(locateTurn(messages, '  answer two ')).toEqual({ start: 2, end: 6, exact: true });
  });

  it('定位不到时回落到最近一轮', () => {
    expect(locateTurn(messages, 'missing')).toEqual({ start: 6, end: 8, exact: false });
  });

  it('没有消息时返回 null', () => {
    expect(locateTurn([], 'x')).toBeNull();
  });
});

describe('turnSteps', () => {
  it('列出工具调用、关键参数与失败状态', () => {
    const steps = turnSteps([
      call('1', 'read', { path: 'src/a.ts' }),
      result('1'),
      call('2', 'bash', { command: 'pnpm test' }),
      result('2', true),
    ]);
    expect(steps).toEqual([
      { id: '1', name: 'read', detail: 'src/a.ts', error: false },
      { id: '2', name: 'bash', detail: 'pnpm test', error: true },
    ]);
  });
});
