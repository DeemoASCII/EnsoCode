import {
  type CatalogEntry,
  type PairBotChatState,
  type PairBotChatSummary,
  type PairBotMember,
  type PairedDevice,
  type ProjectEntry,
  type ProjectGroupEntry,
  type ProviderEntry,
  revokePairing,
} from '@enso/pair';
import { parseCompactCommand } from '@shared/compactCommand';
import { emptyGuestView } from '@shared/pair/guestProjection';
import type { AttachedImage } from '@shared/types/agent';
import { Smartphone } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { applyAppBadge, attentionBadgeCount } from './attentionBadge';
import { BotDrawerPanel } from './BotDrawerPanel';
import { BotOutbox, type OutboxItem, phoneOutboxStorage } from './botOutbox';
import { type GroupTimelineState, mergeGroupTimeline } from './botState';
import { ChatScreen } from './ChatScreen';
import { type ConnState, PairClient, type SessionView } from './client';
import { formatOnlineConnectionLabel } from './connectionLabel';
import { pickActive, removeDevice, renameDevice, upsertDevice } from './deviceList';
import { GroupChatScreen, type MemberPending } from './GroupChatScreen';
import { parseSessionFromSearch, parseSessionId, takeStashedSessionId } from './launchSession';
import { NewSessionSheet } from './NewSessionSheet';
import { OutboxBar } from './OutboxBar';
import { PairScreen } from './PairScreen';
import {
  isPushSupported,
  isStandalone,
  type PushFailureReason,
  registerServiceWorker,
  subscribePush,
  unsubscribePush,
} from './push';
import {
  captureQueueSendEcho,
  type QueueSendEcho,
  retainQueueSendEchoes,
  userTextsOf,
  withoutQueuedIds,
} from './queueSendEcho';
import { SessionConfigSheet } from './SessionConfigSheet';
import { SessionDrawer } from './SessionDrawer';
import {
  clearDeviceData,
  loadActiveDeviceId,
  loadDevices,
  loadLastSession,
  saveActiveDeviceId,
  saveDevices,
  saveLastSession,
} from './storage';
import { setPhoneAgentActions } from './stubs/electron-api';
import { setQueueActions } from './stubs/sessions-store';
import { shouldHoldWakeLock, syncWakeLock } from './wakeLock';

/**
 * 扫码直达：桌面二维码是 https 链接，系统相机可直接打开本页并带上 #relay=…&pk=…。
 * 取出后立即抹掉 hash，避免公钥留在地址栏/历史里，也避免刷新时重复配对。
 */
function takeInviteFromUrl(): string | null {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash.includes('pk=')) return null;
  const link = window.location.href;
  history.replaceState(null, '', window.location.pathname + window.location.search);
  return link;
}

const STATE_LABEL: Record<ConnState, string> = {
  connecting: '连接中…',
  online: '已连接',
  'host-offline': '桌面端离线',
  unauthorized: '配对已失效',
  offline: '重连中…',
};

const PUSH_ENABLED_KEY = 'enso-phone-push';

/** 私聊尚无会话（从未发过消息）时的空视图 */
const EMPTY_VIEW = emptyGuestView();

/** 通知点击冷启动时带的 ?session=：取出即抹掉，优先于上次会话 */
function takeSessionFromUrl(): string | null {
  const sessionId = parseSessionFromSearch(window.location.search);
  if (!sessionId) return null;
  const params = new URLSearchParams(window.location.search);
  params.delete('session');
  const query = params.toString();
  history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''));
  return sessionId;
}

/** 推送可用性：iOS 必须先添加到主屏幕才有 pushManager */
function pushAvailability(): 'ok' | 'needs-install' | 'unsupported' {
  if (isPushSupported()) return 'ok';
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return isIos && !isStandalone() ? 'needs-install' : 'unsupported';
}

export function App() {
  const [devices, setDevices] = useState(loadDevices);
  const [activeDeviceId, setActiveDeviceId] = useState(loadActiveDeviceId);
  /** 活跃桌面：失配（已被删）回落第一台；无配对时为 null 进配对页 */
  const device = pickActive(devices, activeDeviceId);
  // 只在首次挂载时取一次：内部会抹掉 hash，重复调用取不到
  const [urlInvite] = useState(takeInviteFromUrl);
  /** 已配对状态下的「配对新电脑」流程（覆盖 PairScreen） */
  const [adding, setAdding] = useState(false);
  const [state, setState] = useState<ConnState>('connecting');
  const [transport, setTransport] = useState<'relay' | 'direct'>('relay');
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  /** 桌面置顶组的手动拖拽顺序（旧桌面不下发，空 = 按活跃倒序） */
  const [pinnedOrder, setPinnedOrder] = useState<string[]>([]);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [projectGroups, setProjectGroups] = useState<ProjectGroupEntry[]>([]);
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [urlSession] = useState(takeSessionFromUrl);
  const [activeId, setActiveId] = useState<string | null>(() => {
    const initial = pickActive(loadDevices(), loadActiveDeviceId());
    return urlSession ?? (initial ? loadLastSession(initial.pairId) : null);
  });
  const [view, setView] = useState<SessionView | null>(null);
  /** 订阅会话同步中（subscribe 已发、snapshot 未回）：此时时间线可能是陈旧的 */
  const [syncing, setSyncing] = useState(false);
  /** 上滑翻页在途的会话 */
  const [historyPending, setHistoryPending] = useState<ReadonlySet<string>>(new Set());
  /** 马上发送：本地乐观上墙，等权威 user 消息到达再收掉 */
  const [queueEchoes, setQueueEchoes] = useState<QueueSendEcho[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  /** 从抽屉项目旁进入时预填；顶栏新建为 null */
  const [composeProjectId, setComposeProjectId] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(
    () => localStorage.getItem(PUSH_ENABLED_KEY) === 'on'
  );
  /** 已收到桌面下发的 push-config；旧版桌面不会发，开关据此提示升级 */
  const [pushConfigReady, setPushConfigReady] = useState(false);
  const [voiceInput, setVoiceInput] = useState(false);
  /** 订阅进行中：开关乐观显示已开但禁用，避免数秒无反馈 */
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<PushFailureReason | null>(null);
  /** Bot 模式：只有桌面开启并下发过 bot-catalog 才出现 */
  const [botEnabled, setBotEnabled] = useState(false);
  const [bots, setBots] = useState<PairBotMember[]>([]);
  const [botChats, setBotChats] = useState<PairBotChatSummary[]>([]);
  const [botSegment, setBotSegment] = useState(false);
  /** 打开中的 Bot 聊天；非 null 时主屏显示 Bot 视图，Code 的 activeId 原样保留 */
  const [botChatId, setBotChatId] = useState<string | null>(null);
  /** 群聊「查看过程」的成员会话（只读） */
  const [processId, setProcessId] = useState<string | null>(null);
  const [timelines, setTimelines] = useState<Record<string, GroupTimelineState>>({});
  const [chatStates, setChatStates] = useState<Record<string, PairBotChatState>>({});
  /** 群成员会话投影（只取审批/提问，来自不受订阅限制的 pending 事件） */
  const [memberViews, setMemberViews] = useState<Record<string, SessionView>>({});
  const [botNotice, setBotNotice] = useState<string | null>(null);
  /** Bot 发送离线队列（按配对分库）；断线也能发，连上后按原 deliveryId 重发 */
  const outboxRef = useRef<BotOutbox | null>(null);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const clientRef = useRef<PairClient | null>(null);
  const activeIdRef = useRef<string | null>(activeId);
  const catalogRef = useRef(catalog);
  const viewRef = useRef(view);
  catalogRef.current = catalog;
  viewRef.current = view;
  activeIdRef.current = activeId;
  const botChat = botChatId ? botChats.find((chat) => chat.id === botChatId) : undefined;
  const directSessionId =
    botChat?.kind === 'direct'
      ? (botChat.sessions[botChat.members[0]]?.conversationId ?? null)
      : null;
  /** 实际订阅的会话：Code 会话 / 私聊成员当前会话 / 群聊里正在查看过程的成员会话 */
  const subscribedId = botChatId ? (directSessionId ?? processId) : activeId;
  const subscribedRef = useRef(subscribedId);
  subscribedRef.current = subscribedId;
  const botChatsRef = useRef(botChats);
  botChatsRef.current = botChats;
  const botChatIdRef = useRef(botChatId);
  botChatIdRef.current = botChatId;
  const memberIdsRef = useRef(new Set<string>());
  memberIdsRef.current = new Set(
    botChat?.kind === 'group'
      ? Object.values(botChat.sessions).map((session) => session.conversationId)
      : []
  );
  const botRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 群时间线上滑分页：同一 beforeSeq 只发一次 */
  const olderRequestRef = useRef<string | null>(null);
  /** VAPID 公钥（桌面下发）；用 ref 避免重建连接 effect */
  const vapidKeyRef = useRef<string | null>(null);

  // SW 常驻注册（通知点击路由依赖它）+ 监听点击通知的切会话消息
  useEffect(() => {
    void registerServiceWorker();
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; sessionId?: string };
      if (data?.type !== 'open-session') return;
      const sessionId = parseSessionId(data.sessionId);
      if (!sessionId) return;
      // Bot 成员会话的通知（后台审批等）落到对应 Bot 聊天，不当作 Code 会话打开
      const chat = botChatsRef.current.find((item) =>
        Object.values(item.sessions).some((session) => session.conversationId === sessionId)
      );
      if (chat) {
        setBotChatId(chat.id);
        setProcessId(null);
      } else {
        setBotChatId(null);
        setActiveId(sessionId);
      }
      setDrawerOpen(false);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);
  useEffect(() => {
    applyAppBadge(attentionBadgeCount(catalog));
  }, [catalog]);

  useEffect(() => {
    const sync = () => {
      void syncWakeLock(
        shouldHoldWakeLock(document.visibilityState === 'visible' && state === 'online', catalog)
      );
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    document.addEventListener('pointerdown', sync, { passive: true });
    return () => {
      document.removeEventListener('visibilitychange', sync);
      document.removeEventListener('pointerdown', sync);
      void syncWakeLock(false);
    };
  }, [catalog, state]);

  useEffect(() => {
    if (urlSession) {
      void takeStashedSessionId();
      return;
    }
    void takeStashedSessionId().then((id) => {
      if (!id) return;
      setActiveId(id);
      setDrawerOpen(false);
    });
  }, [urlSession]);

  // 已配对状态下扫桌面二维码（地址栏带 #pk=）：进入添加流程，不再覆盖旧配对
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时判一次
  useEffect(() => {
    if (urlInvite && devices.length > 0) setAdding(true);
  }, []);

  // 只按凭据重建连接：重命名只换 label，不该断重连，故用字段级依赖
  // biome-ignore lint/correctness/useExhaustiveDependencies: 见上，device 按 pairId/token/relayUrl/contentKey 变化才重连
  useEffect(() => {
    if (!device) return;
    // 换绑另一台桌面时清掉上一台的 VAPID 公钥，等新桌面重新下发
    vapidKeyRef.current = null;
    setPushConfigReady(false);
    setHistoryPending(new Set());
    setTransport('relay');
    setVoiceInput(false);
    const client = new PairClient(device, {
      onState: (next) => {
        if (next !== 'online') outboxRef.current?.interrupted();
        setState(next);
      },
      onTransport: (next) => {
        setTransport(next);
        setRttMs(null);
      },
      onRtt: setRttMs,
      onVoiceInput: setVoiceInput,
      onCatalog: (entries, order) => {
        setCatalog(entries);
        setPinnedOrder(order ?? []);
      },
      onProjects: (next, groups) => {
        setProjects(next);
        setProjectGroups(groups ?? []);
      },
      onProviders: setProviders,
      onSession: (id, next) => {
        setView((prev) => (id === subscribedRef.current ? next : prev));
        if (memberIdsRef.current.has(id)) setMemberViews((prev) => ({ ...prev, [id]: next }));
      },
      onBotCatalog: (enabled, list) => {
        setBotEnabled(enabled);
        setBots(list);
        if (enabled) return;
        setBotChats([]);
        setBotChatId(null);
        setProcessId(null);
        setBotSegment(false);
      },
      onBotChats: setBotChats,
      onGroupTimeline: (frame) =>
        setTimelines((prev) => ({
          ...prev,
          [frame.chatId]: mergeGroupTimeline(prev[frame.chatId], frame),
        })),
      onBotChatState: ({ type: _type, chatId, ...rest }) =>
        setChatStates((prev) => ({ ...prev, [chatId]: rest })),
      onBotEvent: (event) => {
        // 当前打开的群有变化：合并刷新最新一页时间线与运行态
        if (!event.chatId || event.chatId !== botChatIdRef.current || botRefreshRef.current) {
          return;
        }
        botRefreshRef.current = setTimeout(() => {
          botRefreshRef.current = null;
          const chatId = botChatIdRef.current;
          const chat = botChatsRef.current.find((item) => item.id === chatId);
          if (chatId && chat?.kind === 'group') client.send({ type: 'bot-chat-open', chatId });
        }, 200);
      },
      onBotSendResult: (result) => {
        outboxRef.current?.settle(result.deliveryId, result.ok, result.error);
      },
      onSync: (state) => setSyncing(state === 'syncing'),
      onGhostSession: (id) => {
        // 订阅的会话已在桌面被删：跳回列表态，由 firstId 兑底选最近一条
        if (id === activeIdRef.current) setActiveId(null);
      },
      onHistoryPending: (id, pending) => {
        setHistoryPending((prev) => {
          const next = new Set(prev);
          if (pending) next.add(id);
          else next.delete(id);
          return next;
        });
      },
      onPushConfig: (key) => {
        vapidKeyRef.current = key;
        setPushConfigReady(true);
        // 已开启则每次连上都重新登记：订阅幂等，且能修复桌面侧订阅丢失
        if (localStorage.getItem(PUSH_ENABLED_KEY) === 'on') {
          void subscribePush(key).then((result) => {
            if (result.ok)
              client.send({ type: 'push-subscribe', subscription: result.subscription });
          });
        }
      },
    });
    clientRef.current = client;
    client.connect();
    // 切后台时系统会掐死或冻结 socket 且不触发 close：回前台/网络恢复立即探活。
    // 退后台瞬间赶在冻结前上报不可见：桌面据此把关键事件转系统推送
    //（半开 socket 不会 close，光靠 peer-left 桌面要很久才知道手机不在看）
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        client.nudge('visibility');
        client.send({ type: 'presence', visible: true });
      } else {
        client.conceal();
        client.send({ type: 'presence', visible: false });
        client.flushCache();
      }
    };
    const onOnline = () => {
      if (document.visibilityState === 'visible') {
        client.nudge('online');
        client.send({ type: 'presence', visible: true });
      }
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (document.visibilityState !== 'visible') return;
      // bfcache 回来的 socket 几乎一定是半开，当网络恢复拆掉
      client.nudge(event.persisted ? 'online' : 'visibility');
      client.send({ type: 'presence', visible: true });
    };
    const onFocus = () => {
      if (document.visibilityState === 'visible') client.nudge('visibility');
    };
    const onPageHide = () => {
      client.conceal();
      client.flushCache();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pagehide', onPageHide);
      if (botRefreshRef.current) clearTimeout(botRefreshRef.current);
      botRefreshRef.current = null;
      client.close();
      clientRef.current = null;
    };
  }, [device?.pairId, device?.token, device?.relayUrl, device?.contentKey]);

  /** 手机刚 spawn 的会话 id（一次性）：首次订阅不进 syncing——全新会话没有历史可陈旧，
   * 而 spawn 在途时 host 回的快照不含它，会让「同步中」横幅挂到切会话才消 */
  const freshIdsRef = useRef(new Set<string>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: pairId 变化时也要在新 client 上重订阅
  useEffect(() => {
    // 用 has 而非读时删除：StrictMode 下 effect 双跑，第二跑不能把标记吞掉；切走时才消费
    const fresh = subscribedId !== null && freshIdsRef.current.has(subscribedId);
    clientRef.current?.subscribe(subscribedId, { fresh });
    for (const id of freshIdsRef.current) {
      if (id !== subscribedId) freshIdsRef.current.delete(id);
    }
    setView(subscribedId ? (clientRef.current?.getSession(subscribedId) ?? null) : null);
  }, [subscribedId, device?.pairId]);

  const pairId = device?.pairId;
  useEffect(() => {
    if (pairId) saveLastSession(pairId, activeId);
  }, [activeId, pairId]);

  useEffect(() => {
    if (!pairId) return;
    const box = new BotOutbox(phoneOutboxStorage, pairId);
    outboxRef.current = box;
    setOutbox([]);
    const off = box.subscribe((items) => setOutbox([...items]));
    void box.restore();
    return () => {
      off();
      if (outboxRef.current === box) outboxRef.current = null;
    };
  }, [pairId]);

  // 在线即冲刷待发项；deliveryId 沿用入队时生成的，Main 侧按它去重
  // biome-ignore lint/correctness/useExhaustiveDependencies: outbox 变化（新入队/重试）也要触发冲刷
  useEffect(() => {
    if (state !== 'online') return;
    for (const item of outboxRef.current?.drain() ?? []) {
      clientRef.current?.send({
        type: 'bot-send',
        chatId: item.chatId,
        text: item.text,
        ...(item.images?.length ? { images: item.images } : {}),
        deliveryId: item.deliveryId,
      });
    }
  }, [state, outbox]);

  // 打开群聊或重连后：拉最新一页时间线与运行态；成员审批先用本地已有投影垫上
  const groupOpenId = botChat?.kind === 'group' ? botChat.id : null;
  useEffect(() => {
    if (!groupOpenId || state !== 'online') return;
    olderRequestRef.current = null;
    clientRef.current?.send({ type: 'bot-chat-open', chatId: groupOpenId });
  }, [groupOpenId, state]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: memberIdsRef 随 botChat 在渲染期更新
  useEffect(() => {
    const seeded: Record<string, SessionView> = {};
    for (const id of memberIdsRef.current) {
      const session = clientRef.current?.getSession(id);
      if (session) seeded[id] = session;
    }
    setMemberViews(seeded);
  }, [groupOpenId, botChat?.sessions]);

  // 冷启动通知带来的 ?session= 若是 Bot 成员会话：目录到达后转到对应 Bot 聊天
  useEffect(() => {
    if (!activeId || botChatId) return;
    const chat = botChats.find((item) =>
      Object.values(item.sessions).some((session) => session.conversationId === activeId)
    );
    if (!chat) return;
    setBotChatId(chat.id);
    setActiveId(null);
  }, [activeId, botChatId, botChats]);

  // 排队区复用桌面组件，它经 store 桩调用这些方法；这里转成 pair 命令发回桌面
  useEffect(() => {
    // 马上发送：先本地出队+上墙，再发命令。steer 要等当前轮边界，权威 user 晚到。
    const echoQueuedNow = (sessionId: string, messageId: string) => {
      const queued = catalogRef.current.find((entry) => entry.id === sessionId)?.queued;
      const messages =
        sessionId === activeIdRef.current && viewRef.current
          ? [...viewRef.current.messages.values()]
          : [];
      const echo = captureQueueSendEcho(queued, sessionId, messageId, userTextsOf(messages));
      if (echo) setQueueEchoes((prev) => [...prev, echo]);
    };
    setQueueActions({
      removeQueuedMessage: (sessionId, messageId) =>
        clientRef.current?.send({ type: 'queue-remove', sessionId, messageId }),
      updateQueuedMessage: (sessionId, messageId, text) =>
        clientRef.current?.send({ type: 'queue-update', sessionId, messageId, text }),
      sendQueuedNow: (sessionId, messageId) => {
        echoQueuedNow(sessionId, messageId);
        clientRef.current?.send({ type: 'queue-send-now', sessionId, messageId });
      },
      interruptAndSendQueued: async (sessionId, messageId) => {
        echoQueuedNow(sessionId, messageId);
        clientRef.current?.send({ type: 'queue-interrupt-send', sessionId, messageId });
      },
      pauseGoal: (sessionId) => clientRef.current?.send({ type: 'goal-pause', sessionId }),
      resumeGoal: (sessionId) => clientRef.current?.send({ type: 'goal-resume', sessionId }),
      clearGoal: (sessionId) => clientRef.current?.send({ type: 'goal-clear', sessionId }),
      rewind: (sessionId, userIndexFromEnd, restoreFiles) =>
        clientRef.current?.send({
          type: 'rewind',
          sessionId,
          userIndexFromEnd,
          ...(restoreFiles ? { restoreFiles } : {}),
        }),
      retry: (sessionId) => clientRef.current?.send({ type: 'retry', sessionId }),
    });
    setPhoneAgentActions({
      stopTask: (sessionId, taskId) =>
        clientRef.current?.send({ type: 'task-stop', sessionId, taskId }),
      stopSubagent: (sessionId, agentId) =>
        clientRef.current?.send({ type: 'subagent-stop', sessionId, agentId }),
    });
  }, []);

  const lastRunRef = useRef<{ id: string; running: boolean } | null>(null);
  useEffect(() => {
    if (!activeId) return;
    const texts = userTextsOf(view ? [...view.messages.values()] : []);
    const running = view?.status === 'running';
    const last = lastRunRef.current;
    const turnSettled = last?.id === activeId && last.running && !running;
    lastRunRef.current = { id: activeId, running };
    setQueueEchoes((prev) => {
      const next = retainQueueSendEchoes(prev, activeId, texts, { turnSettled });
      return next.length === prev.length && next.every((echo, index) => echo === prev[index])
        ? prev
        : next;
    });
  }, [view, activeId]);

  // 首次连上且没有选中会话时，落到最近一条
  const firstId = catalog.find((c) => !c.parentId)?.id;
  useEffect(() => {
    if (!activeId && firstId) setActiveId(firstId);
  }, [activeId, firstId]);

  const entry = useMemo(() => catalog.find((c) => c.id === activeId), [catalog, activeId]);
  // coworker tab 组：当前会话是子会话则归组到其父，否则以自身为父；无 coworker 时不显示
  const tabGroup = useMemo(() => {
    if (!entry) return undefined;
    const parent = entry.parentId ? catalog.find((c) => c.id === entry.parentId) : entry;
    if (!parent) return undefined;
    const children = catalog.filter((c) => c.parentId === parent.id);
    return children.length > 0 ? { parent, children } : undefined;
  }, [catalog, entry]);
  // 子会话（coworker）跟随父会话模型，与桌面一致不提供切换
  const configurable = entry && !entry.parentId;
  const modelLabel = configurable
    ? (providers.find((p) => p.id === entry.providerId)?.models.find((m) => m.id === entry.modelId)
        ?.label ??
      entry.modelId ??
      '选择模型')
    : undefined;

  // 在线时附带业务帧出口（直连 / 中继）：顶栏副标题与抽屉设备行共用
  const connectionLabel =
    state === 'online' ? formatOnlineConnectionLabel(transport, rttMs) : STATE_LABEL[state];

  /** 切到另一台时清空上一台的目录/视图，等新桌面下发 */
  const resetHostState = (nextActiveId: string | null) => {
    setCatalog([]);
    setPinnedOrder([]);
    setProjects([]);
    setProjectGroups([]);
    setProviders([]);
    setView(null);
    setSyncing(false);
    setQueueEchoes([]);
    setRttMs(null);
    setBotEnabled(false);
    setBots([]);
    setBotChats([]);
    setBotChatId(null);
    setProcessId(null);
    setTimelines({});
    setChatStates({});
    setMemberViews({});
    setBotNotice(null);
    setActiveId(nextActiveId);
  };

  const switchDevice = (pairId: string) => {
    if (pairId === device?.pairId) return;
    saveActiveDeviceId(pairId);
    setActiveDeviceId(pairId);
    // 旧连接状态不属于新桌面：乐观置回连接中，避免闪现 unauthorized/host-offline 旧屏
    setState('connecting');
    resetHostState(loadLastSession(pairId));
    setDrawerOpen(false);
  };

  const addDevice = (d: PairedDevice) => {
    const next = upsertDevice(devices, d);
    setDevices(next);
    saveDevices(next);
    saveActiveDeviceId(d.pairId);
    setActiveDeviceId(d.pairId);
    resetHostState(loadLastSession(d.pairId));
    setAdding(false);
  };

  const unpairDevice = (pairId: string) => {
    const target = devices.find((d) => d.pairId === pairId);
    // 手机侧持 deviceToken，可一并清掉中继房间（桌面重连即被拒）；已被对端解绑时失败无妄
    if (target) void revokePairing(target.relayUrl, target.pairId, target.token).catch(() => {});
    // 先停旧 client 的缓存写入，再删缓存；不能等 React effect 清理时重新写回。
    if (pairId === device?.pairId) clientRef.current?.close();
    clearDeviceData(pairId);
    const next = removeDevice(devices, pairId);
    setDevices(next);
    saveDevices(next);
    if (pairId === (device?.pairId ?? null)) {
      const fallback = pickActive(next, null);
      saveActiveDeviceId(fallback?.pairId ?? null);
      setActiveDeviceId(fallback?.pairId ?? null);
      if (fallback) setState('connecting');
      resetHostState(fallback ? loadLastSession(fallback.pairId) : null);
      if (!fallback) setDrawerOpen(false);
    }
  };

  const handleRename = (pairId: string, label: string) => {
    const next = renameDevice(devices, pairId, label);
    setDevices(next);
    saveDevices(next);
  };

  if (!device || adding) {
    return (
      <PairScreen
        autoInvite={urlInvite}
        onPaired={addDevice}
        onCancel={device ? () => setAdding(false) : undefined}
      />
    );
  }

  if (state === 'unauthorized') {
    const others = devices.length > 1;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Smartphone className="h-8 w-8 text-muted-foreground" />
        <h1 className="font-medium text-lg">配对已失效</h1>
        <p className="text-muted-foreground text-sm">
          「{device.label}」已解绑此设备，
          {others ? '可移除它并切到其他电脑。' : '请重新扫码配对。'}
        </p>
        <Button onClick={() => unpairDevice(device.pairId)}>
          {others ? '移除此配对' : '重新配对'}
        </Button>
      </div>
    );
  }

  const send = (command: Parameters<PairClient['send']>[0]) => clientRef.current?.send(command);

  const openDrawer = () => {
    setBotSegment(botEnabled && botChatId !== null);
    setDrawerOpen(true);
    if (botEnabled) send({ type: 'bot-catalog-request' });
  };

  const sendBot = (chatId: string, text: string, images: AttachedImage[] = []) => {
    setBotNotice(null);
    outboxRef.current?.enqueue({ chatId, text, images });
  };

  const outboxBar = (chatId: string) => (
    <OutboxBar
      items={outbox.filter((item) => item.chatId === chatId)}
      onRetry={(id) => outboxRef.current?.retry(id)}
      onDiscard={(id) => outboxRef.current?.discard(id)}
    />
  );

  const botById = new Map(bots.map((bot) => [bot.id, bot]));

  const renderBotScreen = (chat: PairBotChatSummary) => {
    if (chat.kind === 'group' && !processId) {
      const pending: MemberPending[] = Object.entries(chat.sessions).flatMap(
        ([botId, { conversationId }]) => {
          const memberView = memberViews[conversationId];
          return memberView ? [{ sessionId: conversationId, botId, view: memberView }] : [];
        }
      );
      return (
        <GroupChatScreen
          chat={chat}
          bots={botById}
          timeline={timelines[chat.id]}
          state={chatStates[chat.id]}
          pending={pending}
          connState={state}
          stateLabel={connectionLabel}
          notice={botNotice}
          outbox={outboxBar(chat.id)}
          onOpenDrawer={openDrawer}
          onLoadOlder={() => {
            const beforeSeq = timelines[chat.id]?.entries[0]?.seq;
            const key = `${chat.id}:${beforeSeq}`;
            if (beforeSeq === undefined || olderRequestRef.current === key) return;
            olderRequestRef.current = key;
            send({ type: 'bot-timeline', chatId: chat.id, beforeSeq });
          }}
          onSend={(text) => sendBot(chat.id, text)}
          onStop={() => send({ type: 'bot-stop', chatId: chat.id })}
          onOpenProcess={setProcessId}
          onApproval={(sessionId, requestId, decision) =>
            send({ type: 'approval-respond', sessionId, requestId, decision })
          }
          onAsk={(sessionId, requestId, answer) =>
            send({ type: 'ask-respond', sessionId, requestId, answer })
          }
        />
      );
    }
    // 私聊：成员当前会话；群聊「查看过程」：该条回复所属的成员会话（只读）
    const process = chat.kind === 'group';
    const processBotId = timelines[chat.id]?.entries.find(
      (entry) => entry.kind === 'bot' && entry.conversationId === processId
    );
    const member = botById.get(
      process ? (processBotId?.kind === 'bot' ? processBotId.botId : '') : chat.members[0]
    );
    return (
      <ChatScreen
        sessionId={subscribedId ?? `bot-chat:${chat.id}`}
        title={process ? `${member?.name ?? '成员'} · 过程` : (member?.name ?? chat.title)}
        projectName={process ? chat.title : (member?.title ?? '')}
        view={subscribedId ? view : EMPTY_VIEW}
        connState={state}
        stateLabel={connectionLabel}
        syncing={syncing && Boolean(subscribedId)}
        onOpenDrawer={openDrawer}
        onNewSession={() => {}}
        canCreate={false}
        hasOlder={Boolean(
          subscribedId && view && view.messages.size > 0 && Math.min(...view.messages.keys()) > 0
        )}
        historyLoading={Boolean(subscribedId && historyPending.has(subscribedId))}
        onLoadOlder={() => subscribedId && clientRef.current?.requestHistory(subscribedId)}
        voice={voice}
        bot={
          process
            ? { readOnly: true, onBack: () => setProcessId(null) }
            : { notice: botNotice, outbox: outboxBar(chat.id) }
        }
        onSend={(text, images) => sendBot(chat.id, text, images)}
        onAbort={() => subscribedId && send({ type: 'abort', sessionId: subscribedId })}
        onApproval={(requestId, decision) =>
          subscribedId &&
          send({ type: 'approval-respond', sessionId: subscribedId, requestId, decision })
        }
        onAsk={(requestId, answer) =>
          subscribedId && send({ type: 'ask-respond', sessionId: subscribedId, requestId, answer })
        }
      />
    );
  };

  const voice = voiceInput
    ? (onPartial: Parameters<PairClient['startVoice']>[0]) =>
        clientRef.current?.startVoice(onPartial) ?? {
          push: () => {},
          finish: () => Promise.resolve({ ok: false as const, error: 'failed' as const }),
          cancel: () => {},
        }
    : undefined;

  const togglePush = async (next: boolean) => {
    setPushError(null);
    if (!next) {
      localStorage.setItem(PUSH_ENABLED_KEY, 'off');
      setPushEnabled(false);
      send({ type: 'push-unsubscribe' });
      void unsubscribePush();
      return;
    }
    const key = vapidKeyRef.current;
    if (!key) return; // 还没收到 push-config（未连上桌面），开关保持关闭
    // 乐观翻开 + busy：权限弹框与 FCM 注册要几秒，开关不动会被误认为没开
    setPushEnabled(true);
    setPushBusy(true);
    const result = await subscribePush(key);
    setPushBusy(false);
    if (!result.ok) {
      setPushEnabled(false);
      setPushError(result.reason);
      return;
    }
    send({ type: 'push-subscribe', subscription: result.subscription });
    localStorage.setItem(PUSH_ENABLED_KEY, 'on');
  };

  return (
    <>
      {botChat ? (
        renderBotScreen(botChat)
      ) : (
        <ChatScreen
          sessionId={activeId}
          title={entry?.title || (activeId ? '会话' : 'EnsoCode')}
          projectName={entry?.projectName ?? ''}
          cwd={entry?.cwd}
          view={view}
          connState={state}
          stateLabel={connectionLabel}
          syncing={syncing && Boolean(activeId)}
          onOpenDrawer={openDrawer}
          onNewSession={() => {
            setComposeProjectId(null);
            setComposing(true);
          }}
          canCreate={state === 'online' && projects.length > 0}
          modelLabel={state === 'online' ? modelLabel : undefined}
          onOpenConfig={() => setConfigOpen(true)}
          tabGroup={tabGroup}
          onSelectTab={setActiveId}
          hasOlder={Boolean(
            activeId && view && view.messages.size > 0 && Math.min(...view.messages.keys()) > 0
          )}
          historyLoading={Boolean(activeId && historyPending.has(activeId))}
          onLoadOlder={() => activeId && clientRef.current?.requestHistory(activeId)}
          voice={voice}
          queued={withoutQueuedIds(entry?.queued, queueEchoes, activeId ?? '')}
          echoes={queueEchoes}
          goal={entry?.goal}
          context={entry?.context}
          usageTotals={entry?.usageTotals}
          slashCommands={entry?.slashCommands}
          onSend={(text, images) => {
            if (!activeId) return;
            const compact = parseCompactCommand(text);
            if (compact) {
              send({
                type: 'compact',
                sessionId: activeId,
                ...(compact.instructions ? { instructions: compact.instructions } : {}),
              });
              return;
            }
            const goalMatch = /^\/goal(?:\s+([\s\S]+))?$/.exec(text.trim());
            if (goalMatch) {
              const arg = goalMatch[1]?.trim();
              if (!arg) return;
              if (arg === 'clear') send({ type: 'goal-clear', sessionId: activeId });
              else if (arg === 'pause') send({ type: 'goal-pause', sessionId: activeId });
              else if (arg === 'resume') send({ type: 'goal-resume', sessionId: activeId });
              else send({ type: 'goal-set', sessionId: activeId, text: arg });
              return;
            }
            // 与桌面同语义：轮次进行中先入队（可编辑/删除/立即发送/打断并发送）
            send({
              type: view?.status === 'running' ? 'enqueue' : 'prompt',
              sessionId: activeId,
              text,
              ...(images.length ? { images } : {}),
            });
          }}
          onAbort={() => activeId && send({ type: 'abort', sessionId: activeId })}
          onApproval={(requestId, decision) =>
            activeId && send({ type: 'approval-respond', sessionId: activeId, requestId, decision })
          }
          onAsk={(requestId, answer) =>
            activeId && send({ type: 'ask-respond', sessionId: activeId, requestId, answer })
          }
        />
      )}

      <SessionDrawer
        open={drawerOpen}
        projects={projects}
        groups={projectGroups}
        catalog={catalog}
        pinnedOrder={pinnedOrder}
        activeId={botChatId ? null : activeId}
        canCreate={state === 'online'}
        devices={devices}
        activeDevicePairId={device.pairId}
        connected={state === 'online'}
        connectionLabel={connectionLabel}
        onClose={() => setDrawerOpen(false)}
        onSelect={(id) => {
          setBotChatId(null);
          setProcessId(null);
          setActiveId(id);
          setDrawerOpen(false);
        }}
        onNewConversation={(projectId) => {
          setDrawerOpen(false);
          setComposeProjectId(projectId);
          setComposing(true);
        }}
        pushEnabled={pushEnabled}
        pushBusy={pushBusy}
        pushError={pushError}
        pushAvailability={pushAvailability()}
        pushConfigReady={pushConfigReady}
        onTogglePush={(next) => void togglePush(next)}
        onSwitchDevice={switchDevice}
        onAddDevice={() => {
          setDrawerOpen(false);
          setAdding(true);
        }}
        onRenameDevice={handleRename}
        onUnpairDevice={unpairDevice}
        botSegment={
          botEnabled
            ? {
                active: botSegment,
                onChange: (next) => {
                  setBotSegment(next);
                  if (next) send({ type: 'bot-catalog-request' });
                },
                panel: (
                  <BotDrawerPanel
                    bots={bots}
                    chats={botChats}
                    activeChatId={botChatId}
                    onSelect={(chatId) => {
                      setBotChatId(chatId);
                      setProcessId(null);
                      setBotNotice(null);
                      setDrawerOpen(false);
                    }}
                  />
                ),
              }
            : undefined
        }
      />

      <NewSessionSheet
        open={composing}
        projects={projects}
        providers={providers}
        preferredProjectId={composeProjectId}
        onClose={() => {
          setComposing(false);
          setComposeProjectId(null);
        }}
        onCreate={(req) => {
          const sessionId = crypto.randomUUID();
          send({ type: 'spawn', sessionId, ...req });
          freshIdsRef.current.add(sessionId);
          setComposing(false);
          setComposeProjectId(null);
          setBotChatId(null);
          setProcessId(null);
          setActiveId(sessionId);
        }}
      />

      {configurable && activeId && (
        <SessionConfigSheet
          open={configOpen}
          providers={providers}
          config={{
            providerId: entry.providerId,
            modelId: entry.modelId,
            reasoningEnabled: entry.reasoningEnabled,
            thinkingLevel: entry.thinkingLevel,
          }}
          onClose={() => setConfigOpen(false)}
          onSetModel={(providerId, modelId) =>
            send({ type: 'set-model', sessionId: activeId, providerId, modelId })
          }
          onSetReasoning={(enabled) =>
            send({ type: 'set-reasoning', sessionId: activeId, enabled })
          }
          onSetThinking={(level) => send({ type: 'set-thinking', sessionId: activeId, level })}
        />
      )}
    </>
  );
}
