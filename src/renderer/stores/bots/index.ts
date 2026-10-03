import type { AttachedImage } from '@shared/types/agent';
import type { BotChat, BotProfile, GroupEntry } from '@shared/types/bot';
import type { BotEvent, BotQueueItem, BotSendResult } from '@shared/types/botIpc';
import { create } from 'zustand';
import { applyHistoryPage, emptyProjection } from '@/stores/sessions/reducer';
import { mergeLatest, mergeOlder } from './groupTimeline';
import { applyBotAgentEvent, type BotSessions, seedHistory } from './projection';
import { chatSummary } from './selectors';
import { seedReadMarks } from './unread';

/**
 * Bot 模式 store：成员/聊天目录、群时间线、成员会话投影。
 * 成员会话不在 enso-conversations 里（sessions store 会丢它们的事件），
 * 这里只为 chat.sessions 里出现过的 conversationId 维护投影。
 */

export interface TimelineState {
  entries: GroupEntry[];
  lastSeq: number;
  hasOlder: boolean;
  loading: boolean;
}

export interface ChatRuntime {
  current: string | null;
  queue: string[];
  hops: number;
  turnsByBot: Record<string, number>;
  pendingHuman: boolean;
}

export type BotView = { kind: 'chat'; chatId: string } | { kind: 'inbox' } | null;

const TIMELINE_PAGE = 50;
const READS_KEY = 'enso-bot-reads';
const VIEW_KEY = 'enso-bot-view';

function loadReads(): Record<string, number> | null {
  try {
    const raw = localStorage.getItem(READS_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function loadView(): BotView {
  const raw = localStorage.getItem(VIEW_KEY);
  if (raw === 'inbox') return { kind: 'inbox' };
  return raw ? { kind: 'chat', chatId: raw } : null;
}

interface BotsState {
  enabled: boolean;
  loaded: boolean;
  bots: BotProfile[];
  chats: BotChat[];
  queue: BotQueueItem[];
  timelines: Record<string, TimelineState>;
  runtime: Record<string, ChatRuntime>;
  sessions: BotSessions;
  sessionHistoryLoading: Record<string, boolean>;
  reads: Record<string, number>;
  view: BotView;

  /** 订阅 Bot 事件与 agent 事件流并拉一次全量；返回清理函数 */
  bind: () => () => void;
  refreshCatalog: () => Promise<void>;
  refreshChats: () => Promise<void>;
  loadLatest: (chatId: string) => Promise<void>;
  loadOlder: (chatId: string) => Promise<void>;
  refreshRuntime: (chatId: string) => Promise<void>;
  /** 开始跟踪成员会话；返回首屏历史加载完成的 promise */
  trackSession: (conversationId: string) => Promise<void>;
  loadOlderSession: (conversationId: string) => Promise<void>;
  setView: (view: BotView) => void;
  markRead: (key: string, marker: number) => void;
  send: (chatId: string, text: string, images: AttachedImage[]) => Promise<BotSendResult>;
  stop: (chatId: string) => Promise<void>;
  /** 打开与成员的私聊；没有就建一个 */
  openDirect: (botId: string) => Promise<string | null>;
  upsertChat: (chat: BotChat) => void;
  upsertBot: (bot: BotProfile) => void;
}

export const useBotsStore = create<BotsState>()((set, get) => {
  const historyInFlight = new Set<string>();
  const seeding = new Map<string, Promise<void>>();
  let storedReads = loadReads();

  const saveReads = (reads: Record<string, number>) => {
    storedReads = reads;
    localStorage.setItem(READS_KEY, JSON.stringify(reads));
  };

  const patchSession = (
    id: string,
    update: (state: BotSessions[string]) => BotSessions[string]
  ) => {
    set((state) => {
      const current = state.sessions[id];
      if (!current) return state;
      const next = update(current);
      return next === current ? state : { sessions: { ...state.sessions, [id]: next } };
    });
  };

  const trackChats = (chats: BotChat[]): Promise<unknown> => {
    const loads: Promise<void>[] = [];
    for (const chat of chats) {
      if (chat.archivedAt !== undefined) continue;
      for (const session of Object.values(chat.sessions)) {
        loads.push(get().trackSession(session.conversationId));
      }
    }
    return Promise.all(loads);
  };

  const names = () => Object.fromEntries(get().bots.map((bot) => [bot.id, bot.name]));

  /** 首次使用：把当前活动全部记为已读 */
  const seedReads = () => {
    const { chats, sessions, timelines, queue } = get();
    const markers: Record<string, number> = {};
    for (const chat of chats) {
      const summary = chatSummary(chat, {
        sessions,
        timeline: timelines[chat.id],
        queue,
        names: names(),
      });
      markers[summary.key] = summary.marker;
    }
    const reads = seedReadMarks(storedReads, markers);
    if (reads !== storedReads) saveReads(reads);
    set({ reads });
  };

  const onBotEvent = (event: BotEvent) => {
    switch (event.kind) {
      case 'catalog':
        void get().refreshCatalog();
        break;
      case 'chat':
      case 'queue':
      case 'routine':
        void get().refreshChats();
        if (event.chatId) void get().refreshRuntime(event.chatId);
        break;
      case 'timeline':
      case 'delegation':
        if (event.chatId) void get().loadLatest(event.chatId);
        break;
    }
  };

  return {
    enabled: false,
    loaded: false,
    bots: [],
    chats: [],
    queue: [],
    timelines: {},
    runtime: {},
    sessions: {},
    sessionHistoryLoading: {},
    reads: storedReads ?? {},
    view: loadView(),

    bind: () => {
      const offBot = window.electronAPI.bots.onEvent(onBotEvent);
      const offAgent = window.electronAPI.agent.onEvent((event) => {
        const { sessions } = get();
        const result = applyBotAgentEvent(sessions, event);
        if (result.sessions !== sessions) set({ sessions: result.sessions });
        for (const id of result.resync) void window.electronAPI.agent.requestSnapshot(id);
      });
      void (async () => {
        await Promise.all([get().refreshCatalog(), get().refreshChats()]);
        const groups = get().chats.filter((chat) => chat.kind === 'group');
        await Promise.all([
          ...groups.map((chat) => get().loadLatest(chat.id)),
          trackChats(get().chats),
        ]);
        if (storedReads === null) seedReads();
        set({ loaded: true });
      })();
      return () => {
        offBot();
        offAgent();
      };
    },

    refreshCatalog: async () => {
      const result = await window.electronAPI.bots.list();
      if (result.ok) set({ bots: result.bots, enabled: result.enabled });
    },

    refreshChats: async () => {
      const result = await window.electronAPI.bots.chats();
      if (!result.ok) return;
      set({ chats: result.chats, queue: result.queue, enabled: result.enabled });
      void trackChats(result.chats);
      for (const chat of result.chats) {
        if (chat.kind === 'group' && !get().runtime[chat.id]) void get().refreshRuntime(chat.id);
      }
    },

    loadLatest: async (chatId) => {
      const result = await window.electronAPI.bots.timeline({ chatId, limit: TIMELINE_PAGE });
      if (!result.ok) return;
      set((state) => {
        const current = state.timelines[chatId];
        const merged = mergeLatest(current?.entries ?? [], result.entries);
        const hasOlder =
          current && !merged.gap ? current.hasOlder : result.entries.length >= TIMELINE_PAGE;
        return {
          timelines: {
            ...state.timelines,
            [chatId]: {
              entries: merged.entries,
              lastSeq: result.lastSeq,
              hasOlder,
              loading: current?.loading ?? false,
            },
          },
        };
      });
    },

    loadOlder: async (chatId) => {
      const current = get().timelines[chatId];
      const first = current?.entries[0];
      if (!current || !first || !current.hasOlder || current.loading) return;
      const patch = (next: Partial<TimelineState>) =>
        set((state) => {
          const timeline = state.timelines[chatId];
          return timeline
            ? { timelines: { ...state.timelines, [chatId]: { ...timeline, ...next } } }
            : state;
        });
      patch({ loading: true });
      try {
        const result = await window.electronAPI.bots.timeline({
          chatId,
          beforeSeq: first.seq,
          limit: TIMELINE_PAGE,
        });
        if (!result.ok) return;
        const latest = get().timelines[chatId];
        if (!latest) return;
        patch({
          entries: mergeOlder(latest.entries, result.entries),
          hasOlder: result.entries.length >= TIMELINE_PAGE,
        });
      } finally {
        patch({ loading: false });
      }
    },

    refreshRuntime: async (chatId) => {
      const chat = get().chats.find((item) => item.id === chatId);
      if (chat && chat.kind !== 'group') return;
      const result = await window.electronAPI.bots.chatState?.(chatId);
      if (!result?.ok) return;
      const { ok: _ok, ...runtime } = result;
      set((state) => ({ runtime: { ...state.runtime, [chatId]: runtime } }));
    },

    trackSession: (conversationId) => {
      const existing = seeding.get(conversationId);
      if (existing) return existing;
      set((state) => ({
        sessions: { ...state.sessions, [conversationId]: { ...emptyProjection } },
      }));
      void window.electronAPI.agent.requestSnapshot(conversationId);
      const load = window.electronAPI.bots
        .sessionHistory({ conversationId })
        .then((result) => {
          if (!result.ok) return;
          patchSession(conversationId, (state) => seedHistory(state, result));
        })
        .catch(() => {});
      seeding.set(conversationId, load);
      return load;
    },

    loadOlderSession: async (conversationId) => {
      const session = get().sessions[conversationId];
      const beforeIndex = session?.historyBaseIndex;
      if (!session || !beforeIndex || beforeIndex <= 0 || historyInFlight.has(conversationId))
        return;
      historyInFlight.add(conversationId);
      set((state) => ({
        sessionHistoryLoading: { ...state.sessionHistoryLoading, [conversationId]: true },
      }));
      try {
        const result = await window.electronAPI.bots.sessionHistory({
          conversationId,
          beforeIndex,
        });
        if (!result.ok) return;
        patchSession(conversationId, (state) =>
          state.historyBaseIndex === beforeIndex
            ? applyHistoryPage(state, { baseIndex: result.baseIndex, messages: result.messages })
            : state
        );
      } finally {
        historyInFlight.delete(conversationId);
        set((state) => ({
          sessionHistoryLoading: { ...state.sessionHistoryLoading, [conversationId]: false },
        }));
      }
    },

    setView: (view) => {
      if (view?.kind === 'chat') localStorage.setItem(VIEW_KEY, view.chatId);
      else if (view?.kind === 'inbox') localStorage.setItem(VIEW_KEY, 'inbox');
      else localStorage.removeItem(VIEW_KEY);
      set({ view });
    },

    markRead: (key, marker) => {
      const reads = get().reads;
      if (reads[key] === marker) return;
      const next = { ...reads, [key]: marker };
      saveReads(next);
      set({ reads: next });
    },

    send: async (chatId, text, images) => {
      const result = await window.electronAPI.bots.send({
        chatId,
        text,
        ...(images.length > 0 ? { images } : {}),
        deliveryId: crypto.randomUUID(),
      });
      if (result.ok && result.conversationId) {
        const id = result.conversationId;
        if (get().sessions[id]) void window.electronAPI.agent.requestSnapshot(id);
        else void get().trackSession(id);
      }
      return result;
    },

    stop: async (chatId) => {
      const chat = get().chats.find((item) => item.id === chatId);
      if (!chat) return;
      if (chat.kind === 'group') {
        await window.electronAPI.bots.stopChat?.(chatId);
        return;
      }
      const conversationId = chat.sessions[chat.members[0]]?.conversationId;
      if (conversationId) await window.electronAPI.agent.abort(conversationId);
    },

    openDirect: async (botId) => {
      const existing = get().chats.find(
        (chat) =>
          chat.kind === 'direct' && chat.members[0] === botId && chat.archivedAt === undefined
      );
      if (existing) {
        get().setView({ kind: 'chat', chatId: existing.id });
        return existing.id;
      }
      const result = await window.electronAPI.bots.createChat({
        kind: 'direct',
        members: [botId],
        workspace: { kind: 'member-home' },
      });
      if (!result.ok) return null;
      get().upsertChat(result.chat);
      if (result.chat.archivedAt !== undefined) {
        const restored = await window.electronAPI.bots.updateChat({
          chatId: result.chat.id,
          archived: false,
        });
        if (restored.ok) get().upsertChat(restored.chat);
      }
      get().setView({ kind: 'chat', chatId: result.chat.id });
      return result.chat.id;
    },

    upsertChat: (chat) => {
      set((state) => {
        const index = state.chats.findIndex((item) => item.id === chat.id);
        const chats = index === -1 ? [...state.chats, chat] : state.chats.toSpliced(index, 1, chat);
        return { chats };
      });
      void trackChats([chat]);
    },

    upsertBot: (bot) => {
      set((state) => {
        const index = state.bots.findIndex((item) => item.id === bot.id);
        return { bots: index === -1 ? [...state.bots, bot] : state.bots.toSpliced(index, 1, bot) };
      });
    },
  };
});
