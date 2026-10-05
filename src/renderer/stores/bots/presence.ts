import { type LiveSession, liveActivity } from '@shared/bots/liveActivity';
import type { ApprovalRequestInfo, AskRequestInfo } from '@shared/types/agent';
import type { Delegation, GroupEntry } from '@shared/types/bot';
import type { BotQueueItem, BotSilence } from '@shared/types/botIpc';
import type { BrowserTabHolder } from '@shared/types/browser';
import { isActiveDelegation } from './delegations';

/** 成员头像六态；同时成立时按 等你 > 卡住 > 干 > 想 > 做完 > 闲 取一个 */
export type Presence = 'idle' | 'think' | 'work' | 'wait' | 'stuck' | 'done';

/** 等你：要人处理的那一条；其余是「想」里的排队原因（悬停说明，不另设状态） */
export type PresenceWait =
  | { kind: 'approval' | 'ask'; conversationId: string; title: string }
  | { kind: 'file'; holder: string; file: string }
  | { kind: 'workspace'; holder: string }
  | { kind: 'turn' | 'capacity' };

export interface PresenceInfo {
  state: Presence;
  wait?: PresenceWait;
  /** 卡住且是静默：最后一次输出时间 */
  quietSince?: number;
  delegation?: Delegation;
}

export interface PresenceSession extends LiveSession {
  pendingApprovals: readonly ApprovalRequestInfo[];
  pendingAsks: readonly AskRequestInfo[];
  toolOutputs: Readonly<Record<string, string>>;
}

export interface PresenceInput {
  conversationIds: readonly string[];
  sessions: Readonly<Record<string, PresenceSession | undefined>>;
  queue: readonly BotQueueItem[];
  silences: readonly BotSilence[];
  delegation?: Delegation;
  /** 做完 / 失败只显示到此后（下一条人类消息）；委派卡片传 -Infinity 一直保留 */
  clearedAt: number;
}

const FILE_WAIT = /^Waiting: "(.+)" is being edited by (.+) \(released when their turn ends\)\.$/;
const WIDE_WAIT = /^Waiting: (.+) is running a workspace-wide command /;

/** worker 文件占用等待时写进工具输出的提示（workspaceClaims.describe） */
export function parseClaimWait(text: string): PresenceWait | undefined {
  const file = FILE_WAIT.exec(text.trim());
  if (file) return { kind: 'file', file: file[1], holder: file[2] };
  const wide = WIDE_WAIT.exec(text.trim());
  return wide ? { kind: 'workspace', holder: wide[1] } : undefined;
}

const RANK: Record<Presence, number> = { idle: 0, done: 1, think: 2, work: 3, stuck: 4, wait: 5 };

function sessionPresence(
  conversationId: string,
  session: PresenceSession | undefined,
  { queue, silences }: PresenceInput
): PresenceInfo | undefined {
  const approval = session?.pendingApprovals.find((item) => item.phase !== 'reviewing');
  if (approval)
    return { state: 'wait', wait: { kind: 'approval', conversationId, title: approval.summary } };
  const ask = session?.pendingAsks[0];
  if (ask) return { state: 'wait', wait: { kind: 'ask', conversationId, title: ask.question } };
  const silence = silences.find((item) => item.conversationId === conversationId);
  if (silence) return { state: 'stuck', quietSince: silence.since };
  const queued = queue.find((item) => item.conversationId === conversationId);
  const live = liveActivity(session, Boolean(queued));
  if (!live) return undefined;
  if (live.state === 'queued')
    return { state: 'think', ...(queued?.reason ? { wait: { kind: queued.reason } } : {}) };
  if (live.state === 'typing') return { state: 'work' };
  if (live.state !== 'tool') return { state: 'think' };
  const running = live.steps.filter((step) => step.status === 'running');
  const waits = running.map((step) => parseClaimWait(session?.toolOutputs[step.id] ?? ''));
  const blocked = waits.every(Boolean) ? waits[0] : undefined;
  return blocked ? { state: 'think', wait: blocked } : { state: 'work' };
}

export function presenceOf(input: PresenceInput): PresenceInfo {
  const { delegation, clearedAt } = input;
  let best: PresenceInfo | undefined;
  for (const id of input.conversationIds) {
    const info = sessionPresence(id, input.sessions[id], input);
    if (info && (!best || RANK[info.state] > RANK[best.state])) best = info;
  }
  const fresh = (delegation?.finishedAt ?? 0) > clearedAt;
  const state: Presence =
    best?.state ??
    (!delegation
      ? 'idle'
      : isActiveDelegation(delegation.state)
        ? 'think'
        : delegation.state === 'failed' && fresh
          ? 'stuck'
          : delegation.state === 'completed' && fresh
            ? 'done'
            : 'idle');
  return {
    state,
    ...(best?.wait ? { wait: best.wait } : {}),
    ...(best?.quietSince !== undefined ? { quietSince: best.quietSince } : {}),
    ...(delegation && state !== 'idle' ? { delegation } : {}),
  };
}

/** 成员（含其委派子会话）当前占用的本聊天浏览器标签 */
export function heldBrowserTab(
  conversationIds: readonly string[],
  holders: Readonly<Record<string, BrowserTabHolder | null | undefined>>,
  tabIds: readonly string[]
): string | undefined {
  return tabIds.find((tabId) => {
    const holder = holders[tabId];
    return holder ? conversationIds.includes(holder.conversationId) : false;
  });
}

/** 最近一条人类消息时间；做完 / 失败的成员在它之后回到闲 */
export function lastHumanAt(entries: readonly GroupEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--)
    if (entries[i].kind === 'human') return entries[i].at;
  return 0;
}

/** 成员在该聊天的会话 + 进行中委派的子会话；委派取进行中最早的，否则最近一条 */
export function memberSources(
  botId: string,
  chat: { id: string; sessions: Readonly<Record<string, { conversationId: string }>> },
  delegations: readonly Delegation[]
): { conversationIds: string[]; delegation?: Delegation } {
  const mine = delegations
    .filter((item) => item.chatId === chat.id && item.targetBotId === botId)
    .sort((a, b) => a.createdAt - b.createdAt);
  const active = mine.filter((item) => isActiveDelegation(item.state));
  const own = chat.sessions[botId]?.conversationId;
  const delegation = active[0] ?? mine.at(-1);
  return {
    conversationIds: [...(own ? [own] : []), ...active.map((item) => item.childConversationId)],
    ...(delegation ? { delegation } : {}),
  };
}
