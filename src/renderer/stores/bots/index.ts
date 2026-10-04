import type { AttachedImage } from '@shared/types/agent';
import type {
  BotChat,
  BotProfile,
  BotRoutine,
  Delegation,
  GroupEntry,
  GroupTask,
} from '@shared/types/bot';
import type {
  BotEvent,
  BotQueueItem,
  BotSearchHit,
  BotSendResult,
  BotSilence,
} from '@shared/types/botIpc';
import { create } from 'zustand';
import { usePendingMemoryWrites } from '@/stores/memoryReview';
import { applyHistoryPage, emptyProjection } from '@/stores/sessions/reducer';
import { resizeSidePanelWidth, SIDE_PANEL_DEFAULT_WIDTH } from '@/stores/sidePanel/width';
import type { BotUsageSnapshot } from './budget';
import { botPendingCount, isActiveDelegation } from './delegations';
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
  routing: boolean;
}

export type BotView = { kind: 'chat'; chatId: string } | { kind: 'inbox' } | null;

/** 搜索结果跳转：目标聊天的时间线消费后清掉（按 nonce 防止清掉更新的一次） */
export interface BotFocus {
  chatId: string;
  locator: BotSearchHit['locator'];
  query: string;
  nonce: number;
}

const TIMELINE_PAGE = 50;
const READS_KEY = 'enso-bot-reads';
const PANEL_KEY = 'enso-bot-panel';
const PANEL_WIDTH_KEY = 'enso-bot-panel-width';
const VIEW_KEY = 'enso-bot-view';
const DISMISSED_KEY = 'enso-bot-dismissed-delegations';
const DISMISSED_BUDGETS_KEY = 'enso-bot-dismissed-budgets';

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

function loadDismissed(key = DISMISSED_KEY): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

interface BotsState {
  enabled: boolean;
  loaded: boolean;
  bots: BotProfile[];
  chats: BotChat[];
  queue: BotQueueItem[];
  /** 运行中却超过静默阈值没有输出的成员会话（Main 看门狗） */
  silences: BotSilence[];
  delegations: Delegation[];
  /** 收件箱里被忽略的中断委派 */
  dismissedDelegations: string[];
  /** 成员用量概览（今日 / 7 天 / 30 天 + 今日是否超预算） */
  usage: BotUsageSnapshot | null;
  /** 收件箱里被忽略的预算提示，键为 botId:YYYY-MM-DD */
  dismissedBudgets: string[];
  /** 全部例行任务：收件箱的待批准 / 阻塞提示、群时间线里的提议卡片 */
  routines: BotRoutine[];
  timelines: Record<string, TimelineState>;
  runtime: Record<string, ChatRuntime>;
  /** 群任务看板；只缓存打开过看板的群 */
  tasks: Record<string, GroupTask[]>;
  sessions: BotSessions;
  sessionHistoryLoading: Record<string, boolean>;
  reads: Record<string, number>;
  view: BotView;
  /** 聊天右侧的成员资料 / 群信息面板 */
  panelOpen: boolean;
  panelWidth: number;
  searchOpen: boolean;
  focus: BotFocus | null;

  /** 订阅 Bot 事件与 agent 事件流并拉一次全量；引用计数，重复 bind 共用一份订阅；返回清理函数 */
  bind: () => () => void;
  refreshCatalog: () => Promise<void>;
  refreshChats: () => Promise<void>;
  /** 拉委派列表，并跟踪进行中委派的子会话（审批/提问归属发起聊天） */
  refreshDelegations: () => Promise<void>;
  dismissDelegation: (id: string) => void;
  refreshUsage: () => Promise<void>;
  dismissBudget: (key: string) => void;
  refreshRoutines: () => Promise<void>;
  refreshTasks: (chatId: string) => Promise<void>;
  loadLatest: (chatId: string) => Promise<void>;
  loadOlder: (chatId: string) => Promise<void>;
  refreshRuntime: (chatId: string) => Promise<void>;
  /** 开始跟踪成员会话；返回首屏历史加载完成的 promise */
  trackSession: (conversationId: string) => Promise<void>;
  loadOlderSession: (conversationId: string) => Promise<void>;
  setView: (view: BotView) => void;
  togglePanel: () => void;
  nudgePanelWidth: (delta: number, workspaceWidth: number) => void;
  markRead: (key: string, marker: number) => void;
  send: (chatId: string, text: string, images: AttachedImage[]) => Promise<BotSendResult>;
  stop: (chatId: string) => Promise<void>;
  /** 打开与成员的私聊；没有就建一个 */
  openDirect: (botId: string) => Promise<string | null>;
  upsertChat: (chat: BotChat) => void;
  upsertBot: (bot: BotProfile) => void;
  setSearchOpen: (open: boolean) => void;
  /** 打开命中所在聊天并请求滚动定位、短暂高亮 */
  focusHit: (hit: BotSearchHit, query: string) => void;
  clearFocus: (nonce: number) => void;
}

export const useBotsStore = create<BotsState>()((set, get) => {
  const historyInFlight = new Set<string>();
  const seeding = new Map<string, Promise<void>>();
  let storedReads = loadReads();
  let bindings = 0;
  let unbind: (() => void) | null = null;

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
        void get().refreshUsage();
        break;
      case 'chat':
      case 'queue':
      case 'silence':
        void get().refreshChats();
        if (event.chatId && event.kind !== 'silence') void get().refreshRuntime(event.chatId);
        break;
      case 'routine':
        void get().refreshChats();
        void get().refreshRoutines();
        break;
      case 'timeline':
        if (event.chatId) void get().loadLatest(event.chatId);
        break;
      case 'delegation':
        void get().refreshDelegations();
        if (event.chatId) void get().loadLatest(event.chatId);
        break;
      case 'tasks':
        if (event.chatId && get().tasks[event.chatId]) void get().refreshTasks(event.chatId);
        break;
      case 'budget':
        void get().refreshUsage();
        break;
    }
  };

  const subscribe = () => {
    let active = true;
    const offBot = window.electronAPI.bots.onEvent(onBotEvent);
    const offAgent = window.electronAPI.agent.onEvent((event) => {
      const { sessions } = get();
      const result = applyBotAgentEvent(sessions, event);
      if (result.sessions !== sessions) set({ sessions: result.sessions });
      for (const id of result.resync) void window.electronAPI.agent.requestSnapshot(id);
    });
    // 解绑期间（关闭 Bot 模式）seeding 保留已完成的加载；重绑时缓存必须重新向权威源补齐。
    for (const [id, cached] of Object.entries(get().sessions)) {
      void window.electronAPI.agent.requestSnapshot(id);
      void window.electronAPI.bots
        .sessionHistory({ conversationId: id })
        .then((result) => {
          if (!active || !result.ok) return;
          // 热会话的快照/事件优先；已冷回收的会话没有快照，用 jsonl 并清掉旧代运行状态。
          patchSession(id, (current) =>
            current === cached ? seedHistory(emptyProjection, result) : current
          );
        })
        .catch(() => {});
    }
    void (async () => {
      await Promise.all([
        get().refreshCatalog(),
        get().refreshChats(),
        get().refreshDelegations(),
        get().refreshUsage(),
        get().refreshRoutines(),
      ]);
      const groups = get().chats.filter((chat) => chat.kind === 'group');
      await Promise.all([
        ...groups.map((chat) => get().loadLatest(chat.id)),
        trackChats(get().chats),
      ]);
      if (storedReads === null) seedReads();
      set({ loaded: true });
    })();
    return () => {
      active = false;
      offBot();
      offAgent();
    };
  };

  return {
    enabled: false,
    loaded: false,
    bots: [],
    chats: [],
    queue: [],
    silences: [],
    delegations: [],
    dismissedDelegations: loadDismissed(),
    usage: null,
    dismissedBudgets: loadDismissed(DISMISSED_BUDGETS_KEY),
    routines: [],
    timelines: {},
    runtime: {},
    tasks: {},
    sessions: {},
    sessionHistoryLoading: {},
    reads: storedReads ?? {},
    view: loadView(),
    panelOpen: localStorage.getItem(PANEL_KEY) !== '0',
    panelWidth: Number(localStorage.getItem(PANEL_WIDTH_KEY)) || SIDE_PANEL_DEFAULT_WIDTH,
    searchOpen: false,
    focus: null,

    bind: () => {
      bindings += 1;
      if (!unbind) unbind = subscribe();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        bindings -= 1;
        if (bindings === 0) {
          unbind?.();
          unbind = null;
        }
      };
    },

    refreshCatalog: async () => {
      const result = await window.electronAPI.bots.list();
      if (result.ok) set({ bots: result.bots, enabled: result.enabled });
    },

    refreshChats: async () => {
      const result = await window.electronAPI.bots.chats();
      if (!result.ok) return;
      set({
        chats: result.chats,
        queue: result.queue,
        silences: result.silences ?? [],
        enabled: result.enabled,
      });
      void trackChats(result.chats);
      for (const chat of result.chats) {
        if (chat.kind === 'group' && !get().runtime[chat.id]) void get().refreshRuntime(chat.id);
      }
    },

    refreshDelegations: async () => {
      const result = await window.electronAPI.bots.delegations();
      if (!result?.ok) return;
      set({ delegations: result.delegations });
      for (const item of result.delegations) {
        if (
          item.chatId &&
          isActiveDelegation(item.state) &&
          !get().sessions[item.childConversationId]
        )
          void get().trackSession(item.childConversationId);
      }
    },

    refreshTasks: async (chatId) => {
      const result = await window.electronAPI.bots.tasks.list(chatId).catch(() => null);
      if (!result?.ok) return;
      set((state) => ({ tasks: { ...state.tasks, [chatId]: result.tasks } }));
    },

    dismissDelegation: (id) => {
      const next = [...get().dismissedDelegations.filter((item) => item !== id), id];
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
      set({ dismissedDelegations: next });
    },

    refreshUsage: async () => {
      try {
        const result = await window.electronAPI.bots.usage();
        if (result.ok) set({ usage: { day: result.day, bots: result.bots } });
      } catch {
        // 用量概览只影响收件箱提示与资料面板，失败不阻断其余加载
      }
    },

    dismissBudget: (key) => {
      // 只留最近的键，避免逐日累积
      const next = [...get().dismissedBudgets.filter((item) => item !== key), key].slice(-200);
      localStorage.setItem(DISMISSED_BUDGETS_KEY, JSON.stringify(next));
      set({ dismissedBudgets: next });
    },

    refreshRoutines: async () => {
      try {
        const result = await window.electronAPI.bots.routines.list();
        if (result.ok) set({ routines: result.routines });
      } catch {
        // 只影响收件箱提示与提议卡片
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

    togglePanel: () => {
      const panelOpen = !get().panelOpen;
      localStorage.setItem(PANEL_KEY, panelOpen ? '1' : '0');
      set({ panelOpen });
    },

    nudgePanelWidth: (delta, workspaceWidth) => {
      const panelWidth = resizeSidePanelWidth(get().panelWidth, delta, workspaceWidth);
      localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
      set({ panelWidth });
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

    setSearchOpen: (searchOpen) => set({ searchOpen }),

    focusHit: (hit, query) => {
      get().setView({ kind: 'chat', chatId: hit.chatId });
      set({
        searchOpen: false,
        focus: { chatId: hit.chatId, locator: hit.locator, query, nonce: Date.now() },
      });
    },

    clearFocus: (nonce) => {
      if (get().focus?.nonce === nonce) set({ focus: null });
    },
  };
});

export const useBotPendingCount = (): number =>
  useBotsStore(botPendingCount) + usePendingMemoryWrites().length;
