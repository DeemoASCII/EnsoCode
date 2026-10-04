import type { ApprovalRequestInfo, AskRequestInfo } from '@shared/types/agent';
import type { BotChat, BotRoutine, Delegation } from '@shared/types/bot';
import { describe, expect, it } from 'vitest';
import { emptyProjection } from '@/stores/sessions/reducer';
import {
  activeDelegations,
  botPendingCount,
  delegationActions,
  delegationOwners,
  formatElapsed,
  interruptedDelegations,
  openTarget,
  pendingOwners,
} from './delegations';
import { pendingItems } from './selectors';

const record = (over: Partial<Delegation>): Delegation => ({
  id: 'd1',
  parentConversationId: 'p1',
  parentBotId: 'boss',
  targetBotId: 'ops',
  chatId: 'c1',
  task: 'deploy',
  context: '',
  childConversationId: 'k1',
  state: 'running',
  depth: 1,
  createdAt: 10,
  ...over,
});

const chat: BotChat = {
  id: 'c1',
  kind: 'group',
  title: 'g',
  members: ['boss', 'ops'],
  bossBotId: 'boss',
  workspace: { kind: 'chat-home', projectId: 'p' },
  routing: { mode: 'boss', maxHops: 4, maxTurnsPerBot: 2 },
  pinned: false,
  sessions: { boss: { conversationId: 'p1', cursor: 0 } },
  createdAt: 1,
  updatedAt: 1,
  version: 1,
};

describe('delegationOwners / pendingOwners', () => {
  it('进行中委派的子会话归到发起聊天，记下替谁执行；已结束或无聊天的不归属', () => {
    const owners = delegationOwners([
      record({}),
      record({ id: 'd2', childConversationId: 'k2', state: 'completed' }),
      record({ id: 'd3', childConversationId: 'k3', chatId: null }),
    ]);
    expect(owners).toEqual({
      k1: { chatId: 'c1', botId: 'ops', delegation: { id: 'd1', parentBotId: 'boss' } },
    });
  });

  it('委派子会话的审批/提问出现在发起聊天的待处理里', () => {
    const sessions = {
      p1: { ...emptyProjection, pendingAsks: [{ requestId: 'a' } as AskRequestInfo] },
      k1: { ...emptyProjection, pendingApprovals: [{ requestId: 'r' } as ApprovalRequestInfo] },
    };
    const items = pendingItems(sessions, pendingOwners([chat], [record({})]), 'c1');
    expect(items).toHaveLength(2);
    expect(items.find((item) => item.conversationId === 'k1')).toMatchObject({
      kind: 'approval',
      botId: 'ops',
      delegation: { parentBotId: 'boss' },
    });
    expect(pendingItems(sessions, pendingOwners([chat], [record({})]), 'c2')).toEqual([]);
  });
});

describe('activeDelegations', () => {
  it('只取该聊天排队/进行中的委派，按发起时间升序', () => {
    const list = [
      record({ id: 'a', createdAt: 30 }),
      record({ id: 'b', createdAt: 20, state: 'queued' }),
      record({ id: 'c', state: 'failed' }),
      record({ id: 'd', chatId: 'c2' }),
    ];
    expect(activeDelegations(list, 'c1').map((item) => item.id)).toEqual(['b', 'a']);
  });
});

describe('interruptedDelegations', () => {
  const interrupted = record({ state: 'failed', failure: 'interrupted', finishedAt: 50 });
  it('列出因重启中断且未处理的委派', () => {
    expect(interruptedDelegations([interrupted, record({ id: 'x', state: 'failed' })], [])).toEqual(
      [interrupted]
    );
  });
  it('已忽略、已重试（之后有同父会话/目标/任务的新委派）或无聊天的不再列出', () => {
    expect(interruptedDelegations([interrupted], ['d1'])).toEqual([]);
    expect(
      interruptedDelegations(
        [interrupted, record({ id: 'd9', createdAt: 60, state: 'queued' })],
        []
      )
    ).toEqual([]);
    expect(interruptedDelegations([{ ...interrupted, chatId: null }], [])).toEqual([]);
  });
});

describe('botPendingCount', () => {
  it('所有 bot 会话（含委派子会话）的待审批/提问 + 未忽略的中断委派', () => {
    const sessions = {
      p1: { ...emptyProjection, pendingAsks: [{ requestId: 'a' } as AskRequestInfo] },
      k1: { ...emptyProjection, pendingApprovals: [{ requestId: 'r' } as ApprovalRequestInfo] },
      orphan: { ...emptyProjection, pendingAsks: [{ requestId: 'o' } as AskRequestInfo] },
    };
    const interrupted = record({
      id: 'd2',
      childConversationId: 'k2',
      state: 'failed',
      failure: 'interrupted',
    });
    const state = {
      sessions,
      chats: [chat],
      delegations: [record({}), interrupted],
      dismissedDelegations: [],
    };
    expect(botPendingCount(state)).toBe(3);
    expect(botPendingCount({ ...state, dismissedDelegations: ['d2'] })).toBe(2);
    const draft = { id: 'r', status: 'draft', updatedAt: 1 } as BotRoutine;
    expect(
      botPendingCount({
        ...state,
        routines: [draft, { ...draft, id: 'r2', status: 'enabled' } as BotRoutine],
      })
    ).toBe(4);
    expect(
      botPendingCount({ sessions: {}, chats: [], delegations: [], dismissedDelegations: [] })
    ).toBe(0);
    const zero = { tokens: 0, cost: null, messages: 0, sessions: 0 };
    const usage = {
      day: '2026-10-04',
      bots: { ops: { today: zero, week: zero, month: zero, exhausted: 'cost' as const } },
    };
    expect(botPendingCount({ ...state, usage, dismissedBudgets: [] })).toBe(4);
    expect(botPendingCount({ ...state, usage, dismissedBudgets: ['ops:2026-10-04'] })).toBe(3);
  });
});

describe('openTarget', () => {
  it('通知点击：有聊天打开聊天，委派子会话打开委派所属聊天，否则打开收件箱', () => {
    const list = [record({}), record({ id: 'd3', childConversationId: 'k3', chatId: null })];
    expect(openTarget({ chatId: 'c9', conversationId: 'k1' }, list)).toEqual({
      kind: 'chat',
      chatId: 'c9',
    });
    expect(openTarget({ conversationId: 'k1' }, list)).toEqual({ kind: 'chat', chatId: 'c1' });
    expect(openTarget({ conversationId: 'k3' }, list)).toEqual({ kind: 'inbox' });
    expect(openTarget({ conversationId: 'zz' }, list)).toEqual({ kind: 'inbox' });
    expect(openTarget({}, list)).toEqual({ kind: 'inbox' });
  });
});

describe('delegationActions', () => {
  it('排队/进行中可取消，失败/取消可重试，完成都不可', () => {
    expect(delegationActions('queued')).toEqual({ cancel: true, retry: false });
    expect(delegationActions('running')).toEqual({ cancel: true, retry: false });
    expect(delegationActions('failed')).toEqual({ cancel: false, retry: true });
    expect(delegationActions('canceled')).toEqual({ cancel: false, retry: true });
    expect(delegationActions('completed')).toEqual({ cancel: false, retry: false });
  });
});

describe('formatElapsed', () => {
  it('紧凑显示耗时', () => {
    expect(formatElapsed(12_000)).toBe('12s');
    expect(formatElapsed(3 * 60_000 + 5_000)).toBe('3m');
    expect(formatElapsed(65 * 60_000)).toBe('1h 5m');
    expect(formatElapsed(-1)).toBe('0s');
  });
});
