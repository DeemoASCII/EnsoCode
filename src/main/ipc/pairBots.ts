import { existsSync } from 'node:fs';
import path from 'node:path';
import type { HostToPhone, PairBotRunState } from '@enso/pair';
import type { RendererAgentEvent } from '@shared/types/agent';
import type { BotChat } from '@shared/types/bot';
import { app } from 'electron';
import { requestSnapshot } from '../services/agentHost';
import {
  botSessionAccess,
  fitGroupTimelineFrame,
  summarizeBotChat,
  toPairBotMember,
} from '../services/pairBotFrames';
import {
  broadcastPairFrame,
  isPairSessionRunning,
  type PairBotCommand,
  type PairReply,
  setPairBotPort,
} from '../services/pairHost';
import { projectParentHistoryAll, resolveParentHistoryFile } from '../services/sessionHistoryTail';
import { getSourceAuthorityRegistry } from './agent';
import {
  botModeEnabled,
  getBotServices,
  observeBotEvents,
  readBotTimeline,
  sendBotMessage,
} from './bots';
import { agentSessionIndex } from './capabilities';

/**
 * 手机端 Bot 模式：pair 命令 → 与桌面 IPC 同一套 Bot 服务；Bot 事件/目录 → 已连接手机。
 * 只在 Bot 模式开启时响应；关闭后仅对曾下发过目录的连接补一帧 enabled:false。
 */

const TIMELINE_PAGE = 50;
const PUSH_DEBOUNCE_MS = 250;

type Services = NonNullable<ReturnType<typeof getBotServices>>;

/** 本进程是否下发过 Bot 目录：关闭 Bot 模式后据此通知手机隐藏分段 */
let announced = false;
let pushTimer: NodeJS.Timeout | null = null;

function enabledServices(): Services | null {
  return botModeEnabled() ? getBotServices() : null;
}

function runStates(services: Services): {
  conversation(conversationId: string | undefined): PairBotRunState;
} {
  const queued = new Set(services.host.queueState().map((item) => item.conversationId));
  return {
    conversation: (id) =>
      !id ? 'idle' : isPairSessionRunning(id) ? 'running' : queued.has(id) ? 'queued' : 'idle',
  };
}

const merge = (states: PairBotRunState[]): PairBotRunState =>
  states.includes('running') ? 'running' : states.includes('queued') ? 'queued' : 'idle';

function chatState(services: Services, chat: BotChat, states: ReturnType<typeof runStates>) {
  const own = Object.values(chat.sessions).map((s) => states.conversation(s.conversationId));
  if (chat.kind === 'group') {
    const round = services.groups.state(chat.id);
    if (round.ok && round.current) own.push('running');
  }
  return merge(own);
}

function catalogFrame(services: Services): HostToPhone {
  const states = runStates(services);
  const chats = services.chats.list();
  return {
    type: 'bot-catalog',
    enabled: true,
    bots: services.bots
      .list()
      .map((bot) =>
        toPairBotMember(
          bot,
          merge(chats.map((chat) => states.conversation(chat.sessions[bot.id]?.conversationId)))
        )
      ),
  };
}

function chatsFrame(services: Services): HostToPhone {
  const states = runStates(services);
  return {
    type: 'bot-chats',
    chats: services.chats
      .list()
      .filter((chat) => chat.archivedAt === undefined)
      .map((chat) =>
        summarizeBotChat(
          chat,
          services.chats.readEntries(chat.id, { limit: 1 })[0],
          services.chats.lastSeq(chat.id),
          chatState(services, chat, states)
        )
      ),
  };
}

async function replyDirectory(services: Services, reply: PairReply): Promise<void> {
  announced = true;
  await reply(catalogFrame(services));
  await reply(chatsFrame(services));
}

function replyTimeline(
  services: Services,
  chatId: string,
  beforeSeq: number | undefined,
  reply: PairReply
): Promise<boolean> | undefined {
  const result = readBotTimeline(services, {
    chatId,
    ...(beforeSeq !== undefined ? { beforeSeq } : {}),
    limit: TIMELINE_PAGE,
  });
  if (!result.ok) return undefined;
  return reply(
    fitGroupTimelineFrame({
      type: 'group-timeline',
      chatId,
      entries: result.entries,
      lastSeq: result.lastSeq,
      ...(beforeSeq !== undefined ? { beforeSeq } : {}),
      hasOlder: (result.entries[0]?.seq ?? 1) > 1,
    })
  );
}

function replyState(services: Services, chatId: string, reply: PairReply): void {
  const state = services.groups.state(chatId);
  if (!state.ok) return;
  const { ok: _ok, ...rest } = state;
  void reply({ type: 'bot-chat-state', chatId, ...rest });
}

async function handle(_pairId: string, command: PairBotCommand, reply: PairReply): Promise<void> {
  const services = enabledServices();
  if (!services) {
    if (command.type === 'bot-catalog-request' && announced) {
      await reply({ type: 'bot-catalog', enabled: false, bots: [] });
    }
    return;
  }
  switch (command.type) {
    case 'bot-catalog-request':
      await replyDirectory(services, reply);
      return;
    case 'bot-chat-open': {
      const chat = services.chats.get(command.chatId);
      if (chat?.kind !== 'group') return;
      await replyTimeline(services, chat.id, undefined, reply);
      replyState(services, chat.id, reply);
      return;
    }
    case 'bot-timeline':
      await replyTimeline(services, command.chatId, command.beforeSeq, reply);
      return;
    case 'bot-stop': {
      const result = await services.groups.stop(command.chatId);
      if (result.ok) replyState(services, command.chatId, reply);
      return;
    }
    case 'bot-send': {
      const { type: _type, ...request } = command;
      const result = await sendBotMessage(services, request);
      // 与桌面 store.send 同步：已在 worker 的会话补一份快照，订阅中的手机据此对齐
      if (result.ok && result.conversationId) requestSnapshot(result.conversationId);
      await reply({
        type: 'bot-send-result',
        chatId: command.chatId,
        deliveryId: command.deliveryId,
        ok: result.ok,
        ...(result.ok ? {} : { error: result.error }),
      });
      return;
    }
  }
}

/** 成员状态与聊天列表合并防抖重推（两帧都小，状态变化都要刷新） */
function schedulePush(): void {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const services = enabledServices();
    if (!services) return;
    announced = true;
    broadcastPairFrame(catalogFrame(services));
    broadcastPairFrame(chatsFrame(services));
  }, PUSH_DEBOUNCE_MS);
}

function botConversation(sessionId: string) {
  const conversation = getSourceAuthorityRegistry()?.conversation(sessionId);
  return conversation?.bot ? conversation : undefined;
}

async function coldSnapshot(sessionId: string): Promise<RendererAgentEvent | null> {
  const conversation = botConversation(sessionId);
  if (!conversation || !botModeEnabled()) return null;
  const sessionDir = path.join(app.getPath('userData'), 'agent', 'sessions');
  const file = resolveParentHistoryFile(sessionDir, conversation.sessionFile);
  let messages: ReturnType<typeof projectParentHistoryAll> = [];
  if (file && existsSync(file)) {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    messages = projectParentHistoryAll(SessionManager.open(file, sessionDir).getBranch());
  }
  // 无 generation：会话随后被拉起时 worker 快照带新 generation，手机按换代重订阅
  return {
    type: 'snapshot',
    partial: true,
    sessions: [{ identity: { sessionId }, sessionId, status: 'idle', messages, commands: [] }],
  } as unknown as RendererAgentEvent;
}

export function registerPairBotHandlers(): void {
  setPairBotPort({
    handle,
    resync(_pairId, reply) {
      const services = enabledServices();
      if (services) void replyDirectory(services, reply);
      else if (announced) void reply({ type: 'bot-catalog', enabled: false, bots: [] });
    },
    sessionAccess: (sessionId) =>
      botSessionAccess(
        botConversation(sessionId),
        botModeEnabled(),
        agentSessionIndex.isAlive(sessionId)
      ),
    coldSnapshot,
    sessionTitle(sessionId) {
      const bot = botConversation(sessionId)?.bot;
      return bot ? getBotServices()?.bots.get(bot.botId)?.name : undefined;
    },
    observe(event) {
      if (!announced || event.type !== 'status') return;
      if (botConversation(event.identity.sessionId) && botModeEnabled()) schedulePush();
    },
  });
  observeBotEvents((event) => {
    // 群任务看板手机端暂不支持：不转发新 kind，pair 协议保持不变
    if (!botModeEnabled() || event.kind === 'tasks') return;
    broadcastPairFrame({ type: 'bot-event', event: { ...event, kind: event.kind } });
    schedulePush();
  });
}
