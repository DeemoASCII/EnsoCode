import type { ProjectedMessage } from '@shared/types/agent';
import type { Delegation } from '@shared/types/bot';
import type { BotQueueItem, BotSilence } from '@shared/types/botIpc';
import { describe, expect, it } from 'vitest';
import {
  lastHumanAt,
  memberSources,
  type PresenceInput,
  type PresenceSession,
  parseClaimWait,
  presenceOf,
} from './presence';

const user: ProjectedMessage = { role: 'user', content: [{ type: 'text', text: 'go' }] };
const call = (id: string, name = 'edit'): ProjectedMessage => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id, name, arguments: { path: 'a.ts' } }],
});
const typing: ProjectedMessage = { role: 'assistant', content: [{ type: 'text', text: 'hi' }] };

const session = (patch: Partial<PresenceSession> = {}): PresenceSession => ({
  status: 'running',
  messages: [user],
  pendingApprovals: [],
  pendingAsks: [],
  toolOutputs: {},
  ...patch,
});

const delegation = (patch: Partial<Delegation> = {}): Delegation => ({
  id: 'd1',
  parentConversationId: 'p',
  parentBotId: 'boss',
  targetBotId: 'b1',
  chatId: 'chat1',
  task: 'do it',
  context: '',
  childConversationId: 'child',
  state: 'running',
  depth: 1,
  createdAt: 100,
  ...patch,
});

const input = (patch: Partial<PresenceInput> = {}): PresenceInput => ({
  conversationIds: ['c1'],
  sessions: {},
  queue: [],
  silences: [],
  clearedAt: 0,
  ...patch,
});

const silence: BotSilence = { conversationId: 'c1', chatId: 'chat1', botId: 'b1', since: 5 };
const queued: BotQueueItem = {
  chatId: 'chat1',
  botId: 'b1',
  conversationId: 'c1',
  position: 0,
  reason: 'capacity',
};
const approval = {
  requestId: 'r1',
  tool: 'bash',
  kind: 'command' as const,
  summary: 'pnpm test',
};

describe('presenceOf', () => {
  it('is idle with no activity', () => {
    expect(presenceOf(input()).state).toBe('idle');
    expect(presenceOf(input({ sessions: { c1: session({ status: 'idle' }) } })).state).toBe('idle');
  });

  it('maps live states to think and work', () => {
    expect(presenceOf(input({ sessions: { c1: session() } })).state).toBe('think');
    expect(presenceOf(input({ sessions: { c1: session({ retry: { attempt: 1 } }) } })).state).toBe(
      'think'
    );
    expect(
      presenceOf(input({ sessions: { c1: session({ messages: [user, typing] }) } })).state
    ).toBe('work');
    expect(
      presenceOf(input({ sessions: { c1: session({ messages: [user, call('t1')] }) } })).state
    ).toBe('work');
  });

  it('treats a queued turn as think with the queue reason', () => {
    const info = presenceOf(input({ queue: [queued] }));
    expect(info).toMatchObject({ state: 'think', wait: { kind: 'capacity' } });
  });

  it('treats a tool blocked on a file claim as think with the holder', () => {
    const info = presenceOf(
      input({
        sessions: {
          c1: session({
            messages: [user, call('t1')],
            toolOutputs: {
              t1: 'Waiting: "src/a.ts" is being edited by Anran (released when their turn ends).',
            },
          }),
        },
      })
    );
    expect(info).toMatchObject({
      state: 'think',
      wait: { kind: 'file', holder: 'Anran', file: 'src/a.ts' },
    });
  });

  it('waits for the human on a pending approval or ask, above everything else', () => {
    const info = presenceOf(
      input({
        conversationIds: ['c1', 'child'],
        sessions: { c1: session(), child: session({ pendingApprovals: [approval] }) },
        silences: [silence],
      })
    );
    expect(info).toMatchObject({
      state: 'wait',
      wait: { kind: 'approval', conversationId: 'child', title: 'pnpm test' },
    });
    const ask = presenceOf(
      input({
        sessions: { c1: session({ pendingAsks: [{ requestId: 'q', question: 'Which?' }] }) },
      })
    );
    expect(ask.wait).toMatchObject({ kind: 'ask', title: 'Which?' });
  });

  it('does not wait for the human while a model reviewer handles the approval', () => {
    const info = presenceOf(
      input({
        sessions: { c1: session({ pendingApprovals: [{ ...approval, phase: 'reviewing' }] }) },
      })
    );
    expect(info.state).toBe('think');
  });

  it('is stuck on silence, above work', () => {
    const info = presenceOf(
      input({ sessions: { c1: session({ messages: [user, call('t1')] }) }, silences: [silence] })
    );
    expect(info).toMatchObject({ state: 'stuck', quietSince: 5 });
  });

  it('thinks while a delegation is still active without a live session', () => {
    expect(presenceOf(input({ delegation: delegation({ state: 'queued' }) })).state).toBe('think');
  });

  it('keeps done / failed only until the next human message', () => {
    const done = delegation({ state: 'completed', finishedAt: 200 });
    expect(presenceOf(input({ delegation: done, clearedAt: 150 })).state).toBe('done');
    expect(presenceOf(input({ delegation: done, clearedAt: 250 })).state).toBe('idle');
    const failed = delegation({ state: 'failed', failure: 'timeout', finishedAt: 200 });
    expect(presenceOf(input({ delegation: failed, clearedAt: 150 })).state).toBe('stuck');
    expect(presenceOf(input({ delegation: failed, clearedAt: 250 })).state).toBe('idle');
  });

  it('never treats a canceled delegation as stuck', () => {
    const canceled = delegation({ state: 'canceled', finishedAt: 200 });
    expect(presenceOf(input({ delegation: canceled })).state).toBe('idle');
  });

  it('lets a live turn win over an older failed delegation', () => {
    const failed = delegation({ state: 'failed', finishedAt: 200 });
    expect(
      presenceOf(
        input({ delegation: failed, sessions: { c1: session({ messages: [user, typing] }) } })
      ).state
    ).toBe('work');
  });
});

describe('memberSources', () => {
  const chat = { id: 'chat1', sessions: { b1: { conversationId: 'c1' } } };

  it('collects the member session and active delegation children in this chat', () => {
    const active = delegation({ id: 'a', childConversationId: 'k1', createdAt: 300 });
    const old = delegation({ id: 'o', state: 'completed', childConversationId: 'k0' });
    const other = delegation({ id: 'x', chatId: 'chat2', childConversationId: 'k2' });
    const elsewhere = delegation({ id: 'y', targetBotId: 'b2', childConversationId: 'k3' });
    const sources = memberSources('b1', chat, [old, active, other, elsewhere]);
    expect(sources.conversationIds).toEqual(['c1', 'k1']);
    expect(sources.delegation?.id).toBe('a');
  });

  it('falls back to the latest finished delegation', () => {
    const first = delegation({ id: 'f', state: 'completed', createdAt: 1 });
    const last = delegation({ id: 'l', state: 'failed', createdAt: 9 });
    const sources = memberSources('b1', chat, [last, first]);
    expect(sources.conversationIds).toEqual(['c1']);
    expect(sources.delegation?.id).toBe('l');
  });
});

describe('parseClaimWait', () => {
  it('parses file and workspace-wide waits', () => {
    expect(
      parseClaimWait('Waiting: "a b.ts" is being edited by Jason (released when their turn ends).')
    ).toEqual({ kind: 'file', file: 'a b.ts', holder: 'Jason' });
    expect(
      parseClaimWait(
        'Waiting: Lin is running a workspace-wide command (git / install / rm -r) in this workspace.'
      )
    ).toEqual({ kind: 'workspace', holder: 'Lin' });
  });

  it('ignores ordinary tool output', () => {
    expect(parseClaimWait('Waiting for server...')).toBeUndefined();
    expect(parseClaimWait('')).toBeUndefined();
  });
});

describe('lastHumanAt', () => {
  it('returns the latest human entry time', () => {
    const base = { id: 'e', seq: 1, at: 0 };
    expect(lastHumanAt([])).toBe(0);
    expect(
      lastHumanAt([
        { ...base, kind: 'human', text: 'a', mentions: [], at: 10 },
        { ...base, kind: 'system', text: 's', at: 20 },
      ] as never)
    ).toBe(10);
  });
});

describe('presence 审批超时', () => {
  const pending = { requestId: 'r1', tool: 'bash', kind: 'command' as const, summary: 'ls' };
  const timedOut: ProjectedMessage = {
    role: 'toolResult',
    toolCallId: 't1',
    isError: true,
    content: [{ type: 'text', text: '审批超时（10 分钟未处理）: auto-denied' }],
  };

  it('等审批时是等你；超时收尾（卡片移除）后退出等你', () => {
    const waiting = session({ messages: [user, call('t1', 'bash')], pendingApprovals: [pending] });
    expect(presenceOf(input({ sessions: { c1: waiting } })).state).toBe('wait');
    const after = session({ messages: [user, call('t1', 'bash'), timedOut] });
    expect(presenceOf(input({ sessions: { c1: after } })).state).toBe('think');
  });
});
