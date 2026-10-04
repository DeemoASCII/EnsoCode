import type { ProjectedMessage, RendererAgentEvent } from '@shared/types/agent';
import type { BotChat } from '@shared/types/bot';
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
  vi.stubGlobal('window', {
    electronAPI: {
      bots: {
        onEvent: (listener: unknown) => {
          botListeners.add(listener);
          return () => botListeners.delete(listener);
        },
        list: async () => ({ ok: true, enabled: true, bots: [] }),
        chats: async () => ({ ok: true, enabled: true, chats: [chat], queue: [] }),
        delegations: async () => ({ ok: true, delegations: [] }),
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
    listeners,
    botListeners,
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
});
