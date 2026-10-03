import { describe, expect, it } from 'vitest';
import type { BotChat, GroupEntry } from '../types/bot';
import {
  isSkipReply,
  mergePending,
  onHumanMessage,
  onReply,
  type RouterState,
  shouldRoute,
  startRound,
} from './router';

type Human = Extract<GroupEntry, { kind: 'human' }>;

const members = [
  { id: 'boss', name: '老板' },
  { id: 'fe', name: '前端' },
  { id: 'be', name: 'Backend' },
  { id: 'old', name: '老员工', archivedAt: 1 },
];

function chat(routing = { maxHops: 4, maxTurnsPerBot: 2 }): BotChat {
  return {
    id: 'chat',
    kind: 'group',
    title: '群',
    members: ['boss', 'fe', 'be', 'old'],
    bossBotId: 'boss',
    workspace: { kind: 'project', projectId: 'p' },
    routing,
    pinned: false,
    sessions: {
      boss: { conversationId: 'c-boss', cursor: 0 },
      fe: { conversationId: 'c-fe', cursor: 0 },
    },
    createdAt: 0,
    updatedAt: 0,
    version: 0,
  };
}

const human = (text: string, mentions: string[] = [], seq = 1): Human => ({
  kind: 'human',
  seq,
  id: `h${seq}`,
  at: 0,
  text,
  mentions,
});

describe('startRound', () => {
  it('没有 @ 时由群主回复', () => {
    const state = startRound(chat(), members, human('大家好', [], 7));
    expect(state).toEqual({
      rootEntrySeq: 7,
      queue: [],
      current: 'boss',
      hops: 0,
      turnsByBot: { boss: 1 },
      noticed: [],
    });
  });

  it('有 @ 时按出现顺序排队', () => {
    const state = startRound(chat(), members, human('@Backend 先，@前端 后'));
    expect(state.current).toBe('be');
    expect(state.queue).toEqual(['fe']);
  });

  it('entry.mentions 非空时以其为准', () => {
    const state = startRound(chat(), members, human('@Backend', ['fe', 'be']));
    expect([state.current, ...state.queue]).toEqual(['fe', 'be']);
  });

  it('@所有人 展开为在群且未归档的全体成员，按群成员顺序', () => {
    const state = startRound(chat(), members, human('@所有人'));
    expect([state.current, ...state.queue]).toEqual(['boss', 'fe', 'be']);
  });

  it('只 @ 了已归档或不在群的成员时退回群主', () => {
    const state = startRound(chat(), members, human('@老员工', ['old', 'ghost']));
    expect(state.current).toBe('boss');
  });

  it('群主也不可用时没有回复人', () => {
    const state = startRound(chat(), [], human('hi'));
    expect(state.current).toBeNull();
    expect(state.queue).toEqual([]);
  });
});

describe('onReply', () => {
  const begin = (text = '@老板', c = chat()) => startRound(c, members, human(text));

  it('回复里 @ 别人时接力入队，并轮到下一位', () => {
    const r = onReply(begin(), chat(), members, { botId: 'boss', text: '@前端 @Backend 你们看' });
    expect(r.next).toBe('fe');
    expect(r.state.queue).toEqual(['be']);
    expect(r.state.hops).toBe(2);
    expect(r.state.turnsByBot).toEqual({ boss: 1, fe: 1 });
    expect(r.skipped).toBe(false);
  });

  it('@ 自己和已在队列中的成员不重复入队、不计跳', () => {
    const s = startRound(chat(), members, human('@老板 @前端'));
    const r = onReply(s, chat(), members, { botId: 'boss', text: '@老板 @前端 @所有人' });
    expect(r.state.hops).toBe(1);
    expect([r.next, ...r.state.queue]).toEqual(['fe', 'be']);
  });

  it('[skip] 不区分大小写且忽略空白，跳过时不解析 @', () => {
    const r = onReply(begin(), chat(), members, { botId: 'boss', text: '  [SKIP]\n' });
    expect(r.skipped).toBe(true);
    expect(r.next).toBeNull();
    expect(r.state.hops).toBe(0);
  });

  it('[skip] 附带其他内容时不算跳过', () => {
    const r = onReply(begin(), chat(), members, { botId: 'boss', text: '[skip] @前端' });
    expect(r.skipped).toBe(false);
    expect(r.next).toBe('fe');
  });

  it('队列空时轮次结束', () => {
    const r = onReply(begin(), chat(), members, { botId: 'boss', text: '好的' });
    expect(r.next).toBeNull();
    expect(r.state.current).toBeNull();
  });

  it('不是当前回复人的回复被忽略', () => {
    const s = begin();
    const r = onReply(s, chat(), members, { botId: 'fe', text: '@Backend' });
    expect(r.state).toEqual(s);
    expect(r.next).toBe('boss');
  });

  it('跳数恰好达到 maxHops 时仍可入队，超过则拦下并提示一次', () => {
    const c = chat({ maxHops: 1, maxTurnsPerBot: 5 });
    let r = onReply(begin('@老板', c), c, members, { botId: 'boss', text: '@前端 @Backend' });
    expect(r.state.hops).toBe(1);
    expect([r.next, ...r.state.queue]).toEqual(['fe']);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toContain('Backend');
    r = onReply(r.state, c, members, { botId: 'fe', text: '@Backend' });
    expect(r.next).toBeNull();
    expect(r.notices).toEqual([]);
  });

  it('成员回复次数达到 maxTurnsPerBot 后不再入队', () => {
    const c = chat({ maxHops: 10, maxTurnsPerBot: 1 });
    const r = onReply(begin('@老板', c), c, members, { botId: 'boss', text: '@前端' });
    const r2 = onReply(r.state, c, members, { botId: 'fe', text: '@老板' });
    expect(r2.next).toBeNull();
    expect(r2.notices).toHaveLength(1);
    expect(r2.notices[0]).toContain('老板');
    expect(r2.state.hops).toBe(1);
  });

  it('次数未达上限时可以回到之前的成员', () => {
    const r = onReply(begin(), chat(), members, { botId: 'boss', text: '@前端' });
    const r2 = onReply(r.state, chat(), members, { botId: 'fe', text: '@老板' });
    expect(r2.next).toBe('boss');
    expect(r2.state.turnsByBot.boss).toBe(2);
  });

  it('不在群或已归档的成员不入队', () => {
    const r = onReply(begin(), chat(), members, { botId: 'boss', text: '@老员工' });
    expect(r.next).toBeNull();
    expect(r.state.hops).toBe(0);
  });

  it('状态可 JSON 往返且输入状态不被修改', () => {
    const s = begin();
    const snapshot = JSON.parse(JSON.stringify(s)) as RouterState;
    onReply(s, chat(), members, { botId: 'boss', text: '@前端' });
    expect(s).toEqual(snapshot);
  });
});

describe('onHumanMessage', () => {
  const busy = () => startRound(chat(), members, human('@前端 @Backend'));

  it('没有人在回复时等价于 startRound', () => {
    const idle = onReply(startRound(chat(), members, human('x')), chat(), members, {
      botId: 'boss',
      text: 'ok',
    }).state;
    const d = onHumanMessage(idle, chat(), members, human('@Backend', [], 5));
    expect(d).toEqual({
      action: 'start',
      state: startRound(chat(), members, human('@Backend', [], 5)),
    });
  });

  it('只 @ 当前回复人时 steer', () => {
    expect(onHumanMessage(busy(), chat(), members, human('@前端 等等'))).toEqual({
      action: 'steer',
    });
  });

  it('@ 了其他人、或没有 @ 时等当前说完后重开', () => {
    for (const text of ['@前端 @Backend', '@Backend', '换个话题']) {
      expect(onHumanMessage(busy(), chat(), members, human(text)).action).toBe(
        'restart-after-current'
      );
    }
  });
});

describe('mergePending', () => {
  it('以最后一条人类消息为准，@ 按时间顺序取并集', () => {
    const merged = mergePending([
      human('@前端', ['fe'], 1),
      { kind: 'system', seq: 2, id: 's', at: 0, text: '@Backend' },
      human('@Backend @前端', ['be', 'fe'], 3),
      human('补充一下', [], 4),
    ]);
    expect(merged).toMatchObject({ seq: 4, text: '补充一下', mentions: ['fe', 'be'] });
  });

  it('没有人类消息时返回 null', () => {
    expect(mergePending([])).toBeNull();
    expect(mergePending([{ kind: 'system', seq: 1, id: 's', at: 0, text: 'x' }])).toBeNull();
  });
});

describe('shouldRoute', () => {
  const bot = (conversationId: string): GroupEntry => ({
    kind: 'bot',
    seq: 1,
    id: 'b',
    at: 0,
    botId: 'fe',
    text: '@Backend',
    conversationId,
    turnId: 't',
  });

  it('人类消息触发路由', () => {
    expect(shouldRoute(human('hi'), chat())).toBe(true);
  });

  it('system 与 delegation 条目不触发路由', () => {
    expect(shouldRoute({ kind: 'system', seq: 1, id: 's', at: 0, text: '@前端' }, chat())).toBe(
      false
    );
    expect(
      shouldRoute(
        {
          kind: 'delegation',
          seq: 1,
          id: 'd',
          at: 0,
          delegationId: 'x',
          from: 'fe',
          to: 'be',
          state: 'completed',
        },
        chat()
      )
    ).toBe(false);
  });

  it('成员在本群会话里的回复参与路由，系统以其名义代写的（委派会话）不参与', () => {
    expect(shouldRoute(bot('c-fe'), chat())).toBe(true);
    expect(shouldRoute(bot('c-delegated'), chat())).toBe(false);
  });

  it('脏输入不崩', () => {
    expect(shouldRoute(null as never, chat())).toBe(false);
  });
});

describe('isSkipReply', () => {
  it('只认整条为 [skip]', () => {
    expect(isSkipReply(' [Skip] ')).toBe(true);
    expect(isSkipReply('skip')).toBe(false);
    expect(isSkipReply(undefined as never)).toBe(false);
  });
});
