import type { ProjectedMessage, RendererAgentEvent } from '@shared/types/agent';
import type { BotChat, GroupEntry } from '@shared/types/bot';
import type { BotEvent } from '@shared/types/botIpc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatSummary } from './selectors';
import { isUnread } from './unread';

const message = (text: string): ProjectedMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});
const chat: BotChat = {
  id: 'c',
  kind: 'direct',
  title: '',
  members: ['b'],
  bossBotId: null,
  workspace: { kind: 'member-home' },
  routing: { mode: 'boss', maxHops: 4, maxTurnsPerBot: 2 },
  pinned: false,
  sessions: { b: { conversationId: 's', cursor: 0 } },
  createdAt: 1,
  updatedAt: 1,
  version: 1,
};

async function fixture() {
  vi.resetModules();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === 'enso-bot-reads' ? '{"c:s":1}' : null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  const listeners = new Set<(event: RendererAgentEvent) => void>();
  const botListeners = new Set<unknown>();
  const sessionHistory = vi
    .fn()
    .mockResolvedValue({ ok: true, baseIndex: 0, messages: [message('old')] });
  const requestSnapshot = vi.fn().mockResolvedValue({ ok: true });
  const delegations = vi.fn(async () => ({ ok: true, delegations: [] }));
  const timeline = vi.fn(
    async (_request: unknown): Promise<{ ok: true; entries: GroupEntry[]; lastSeq: number }> => ({
      ok: true,
      entries: [],
      lastSeq: 0,
    })
  );
  vi.stubGlobal('window', {
    electronAPI: {
      bots: {
        onEvent: (listener: unknown) => {
          botListeners.add(listener);
          return () => botListeners.delete(listener);
        },
        list: async () => ({ ok: true, enabled: true, bots: [] }),
        chats: async () => ({ ok: true, enabled: true, chats: [chat], queue: [] }),
        delegations,
        timeline,
        sessionHistory,
      },
      agent: {
        onEvent: (listener: (event: RendererAgentEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        requestSnapshot,
      },
    },
  });
  const { useBotsStore: store } = await import('./index');
  const off = store.getState().bind();
  await vi.waitFor(() => expect(store.getState().loaded).toBe(true));
  expect(store.getState().sessions.s.messages).toEqual([message('old')]);
  return {
    store,
    off,
    sessionHistory,
    requestSnapshot,
    delegations,
    timeline,
    listeners,
    botListeners,
    bot: (event: BotEvent) => {
      for (const listener of botListeners) (listener as (event: BotEvent) => void)(event);
    },
    emit: (event: RendererAgentEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Bot mode subscription lifecycle', () => {
  it('重复 bind 不重复订阅；全部清理后才解绑', async () => {
    const f = await fixture();
    const off = f.store.getState().bind();
    expect(f.listeners.size).toBe(1);
    expect(f.botListeners.size).toBe(1);
    f.off();
    expect(f.listeners.size).toBe(1);
    off();
    off();
    expect(f.listeners.size).toBe(0);
    expect(f.botListeners.size).toBe(0);
  });

  it('Code 模式错过轮次后重新挂载，缓存必须从磁盘补齐（worker 已冷）', async () => {
    const f = await fixture();
    f.store.setState((s) => ({
      sessions: { s: { ...s.sessions.s, generation: 'g1', lastSeq: 90, status: 'running' } },
    }));
    f.off();
    f.sessionHistory.mockResolvedValue({
      ok: true,
      baseIndex: 0,
      messages: [message('old'), message('Main 例行任务结果')],
    });
    const off = f.store.getState().bind();
    await vi.waitFor(() => expect(f.store.getState().sessions.s.messages).toHaveLength(2));
    const state = f.store.getState();
    const summary = chatSummary(chat, { sessions: state.sessions, queue: [], names: {} });
    expect(summary.preview).toBe('Main 例行任务结果');
    expect(summary.running).toBe(false);
    expect(isUnread(summary.marker, state.reads[summary.key])).toBe(true);
    expect(state.sessions.s.generation).toBeUndefined();
    expect(f.requestSnapshot).toHaveBeenCalledTimes(2);
    off();
  });

  it('切回后的新 generation 快照和后续流式事件优先于延迟返回的历史', async () => {
    const f = await fixture();
    f.off();
    const history = Promise.withResolvers<{
      ok: true;
      baseIndex: number;
      messages: ProjectedMessage[];
    }>();
    f.sessionHistory.mockReturnValue(history.promise);
    f.requestSnapshot.mockImplementation(async () => {
      f.emit({
        type: 'snapshot',
        partial: true,
        sessions: [
          {
            identity: { sessionId: 's', generation: 'g2' },
            status: 'running',
            messages: [message('old'), message('live')],
            commands: [],
          },
        ],
      } as RendererAgentEvent);
      return { ok: true };
    });
    const off = f.store.getState().bind();
    await vi.waitFor(() => expect(f.store.getState().sessions.s.generation).toBe('g2'));
    history.resolve({ ok: true, baseIndex: 0, messages: [message('stale')] });
    await history.promise;
    const state = f.store.getState().sessions.s;
    expect(state.messages).toEqual([message('old'), message('live')]);
    expect(state.status).toBe('running');
    f.emit({
      type: 'message-upsert',
      identity: { sessionId: 's', generation: 'g2' },
      seq: 10,
      index: 2,
      message: message('new'),
    });
    expect(f.store.getState().sessions.s.messages.at(-1)).toEqual(message('new'));
    off();
  });

  it('Bot 事件按聊天合并刷新，时间线只拉 seq 之后的增量，过期 seq 不再拉', async () => {
    const f = await fixture();
    const entry = (seq: number): GroupEntry => ({
      seq,
      id: `e${seq}`,
      at: seq,
      kind: 'system',
      text: String(seq),
    });
    f.store.setState({
      timelines: {
        g: { entries: [entry(1), entry(2), entry(3)], lastSeq: 3, hasOlder: false, loading: false },
      },
    });
    f.delegations.mockClear();
    f.timeline.mockClear();
    f.timeline.mockResolvedValue({ ok: true, entries: [entry(4), entry(5)], lastSeq: 5 });
    f.bot({ kind: 'timeline', chatId: 'g', seq: 2 });
    for (const seq of [4, 5]) f.bot({ kind: 'timeline', chatId: 'g', seq });
    for (let i = 0; i < 3; i++) f.bot({ kind: 'delegation', chatId: 'g' });
    await vi.waitFor(() => expect(f.store.getState().timelines.g.lastSeq).toBe(5));
    await vi.waitFor(() => expect(f.delegations).toHaveBeenCalledTimes(1));
    expect(f.timeline).toHaveBeenCalledTimes(1);
    expect(f.timeline).toHaveBeenCalledWith({ chatId: 'g', afterSeq: 3, limit: 50 });
    expect(f.store.getState().timelines.g.entries.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5]);
    f.bot({ kind: 'timeline', chatId: 'g', seq: 5 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(f.timeline).toHaveBeenCalledTimes(1);
    f.off();
  });
});
