import type { BotChat, BotProfile } from '@shared/types/bot';
import { MessageSquarePlus, PanelRight, Shield, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApprovalBar } from '@/components/chat/ApprovalBar';
import { APPROVAL_MODE_META } from '@/components/chat/ApprovalModePicker';
import { AskBar } from '@/components/chat/AskBar';
import { ChatHostContext } from '@/components/chat/chatHost';
import {
  CHAT_COL,
  MessageTimeline,
  type MessageTimelineHandle,
} from '@/components/chat/MessageTimeline';
import { RetryBar } from '@/components/chat/RetryBar';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useBotsStore } from '@/stores/bots';
import { activeDelegations, pendingOwners } from '@/stores/bots/delegations';
import { chatSummary, type PendingItem, pendingItems } from '@/stores/bots/selectors';
import { buildTimeline } from '@/stores/sessions/timeline';
import { useSettingsStore } from '@/stores/settings';
import { BotAvatar, GroupAvatar } from './BotAvatar';
import { BotComposer } from './BotComposer';
import { BotProfilePanel } from './BotProfilePanel';
import { chatErrorText, chatTitle } from './botText';
import { DelegationCard } from './DelegationCard';
import { GroupInfoPanel } from './GroupInfoPanel';
import { GroupTimeline } from './GroupTimeline';
import { SessionHistoryDialog } from './SessionHistoryDialog';
import { WorkspaceMenu } from './WorkspaceMenu';

const PANEL_KEY = 'enso-bot-panel';

export function useModelLabel(bot: BotProfile | undefined): string {
  const { t } = useI18n();
  const providers = useSettingsStore((s) => s.providers);
  if (!bot?.engine) return t('Default model');
  const { providerId, modelId } = bot.engine;
  const model = providers.find((p) => p.id === providerId)?.models.find((m) => m.id === modelId);
  return model?.label ?? modelId;
}

export function BotChatView({ chat }: { chat: BotChat }) {
  const { t } = useI18n();
  const bots = useBotsStore((s) => s.bots);
  const chats = useBotsStore((s) => s.chats);
  const sessions = useBotsStore((s) => s.sessions);
  const queue = useBotsStore((s) => s.queue);
  const delegations = useBotsStore((s) => s.delegations);
  const timeline = useBotsStore((s) => s.timelines[chat.id]);
  const runtime = useBotsStore((s) => s.runtime[chat.id]);
  const markRead = useBotsStore((s) => s.markRead);
  const [panelOpen, setPanelOpen] = useState(() => localStorage.getItem(PANEL_KEY) !== '0');
  const [history, setHistory] = useState<{ id: string; title: string } | null>(null);

  const byId = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const names = useMemo(() => Object.fromEntries(bots.map((bot) => [bot.id, bot.name])), [bots]);
  const members = chat.members.map((id) => byId.get(id)).filter((bot): bot is BotProfile => !!bot);
  const summary = chatSummary(chat, { sessions, timeline, queue, names });
  const chatDelegations = useMemo(
    () => delegations.filter((item) => item.chatId === chat.id),
    [delegations, chat.id]
  );
  const pending = useMemo(
    () => pendingItems(sessions, pendingOwners(chats, delegations), chat.id),
    [sessions, chats, delegations, chat.id]
  );

  /** 只读会话的发言人：委派子会话 → 目标成员；否则按会话归属或时间线条目 */
  const speakerOf = (conversationId: string): BotProfile | undefined => {
    const delegated = chatDelegations.find((item) => item.childConversationId === conversationId);
    if (delegated) return byId.get(delegated.targetBotId);
    const owner = Object.entries(chat.sessions).find(
      ([, session]) => session.conversationId === conversationId
    )?.[0];
    const entry = timeline?.entries.find(
      (item) => item.kind === 'bot' && item.conversationId === conversationId
    );
    return byId.get(
      owner ?? (entry?.kind === 'bot' ? entry.botId : chat.kind === 'direct' ? chat.members[0] : '')
    );
  };
  const historySpeaker = history ? speakerOf(history.id) : undefined;

  useEffect(() => {
    markRead(summary.key, summary.marker);
  }, [markRead, summary.key, summary.marker]);

  useEffect(() => {
    if (chat.kind === 'group') {
      void useBotsStore.getState().loadLatest(chat.id);
      void useBotsStore.getState().refreshRuntime(chat.id);
    }
  }, [chat.id, chat.kind]);

  const togglePanel = () => {
    localStorage.setItem(PANEL_KEY, panelOpen ? '0' : '1');
    setPanelOpen(!panelOpen);
  };

  const direct = chat.kind === 'direct' ? members[0] : undefined;
  const archived = chat.archivedAt !== undefined;
  const replying = runtime?.current ? byId.get(runtime.current) : undefined;

  const hint = (() => {
    if (archived) return t('This chat is archived. Restore it before sending.');
    if (chat.kind === 'group') {
      const base =
        chat.routing.mode === 'smart'
          ? t('Without @, the best-fit member is picked to reply')
          : t('Without @, the group owner replies');
      if (replying)
        return `${base} · ${t('{{name}} is replying; new messages are routed after they finish', { name: replying.name })}`;
      return base;
    }
    if (summary.queued) return t('Queued until a session slot frees up');
    if (summary.running && direct)
      return t('{{name}} is working; your message joins the current turn', { name: direct.name });
    return null;
  })();

  const send = async (
    text: string,
    images: Parameters<typeof window.electronAPI.bots.send>[0]['images']
  ) => {
    const result = await useBotsStore.getState().send(chat.id, text, images ?? []);
    if (!result.ok) {
      addToast({
        type: 'error',
        title: t('Message not sent'),
        description: chatErrorText(result.error, t),
      });
      return false;
    }
    if (result.queued) addToast({ type: 'info', title: t('Queued until a session slot frees up') });
    return true;
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b px-4">
          {direct ? (
            <BotAvatar bot={direct} busy={summary.running} />
          ) : (
            <GroupAvatar bots={members} busy={summary.running} />
          )}
          <div className="min-w-0">
            <div className="truncate font-semibold text-sm">{chatTitle(chat, bots, t)}</div>
            <div className="truncate text-muted-foreground text-xs">
              {direct ? (
                <DirectSubtitle bot={direct} running={summary.running} queued={summary.queued} />
              ) : (
                t('{{n}} members · Owner {{name}}', {
                  n: members.length,
                  name: byId.get(chat.bossBotId ?? '')?.name ?? '—',
                })
              )}
            </div>
          </div>
          <div className="flex-1" />
          <WorkspaceMenu chat={chat} />
          {chat.kind === 'group' && (
            <span className="hidden h-7 items-center rounded-md border px-2 text-muted-foreground text-xs md:flex">
              {t('Relay limit {{n}}', { n: chat.routing.maxHops })}
            </span>
          )}
          {direct && (
            <button
              type="button"
              disabled={archived}
              onClick={() =>
                void window.electronAPI.bots.newSession(chat.id).then((result) => {
                  if (!result.ok)
                    addToast({ type: 'error', title: chatErrorText(result.error, t) });
                  else void useBotsStore.getState().refreshChats();
                })
              }
              className="flex h-7 items-center gap-1 rounded-md border px-2 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
              {t('New conversation')}
            </button>
          )}
          <button
            type="button"
            onClick={togglePanel}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-muted',
              panelOpen ? 'text-foreground' : 'text-muted-foreground'
            )}
            title={chat.kind === 'group' ? t('Group info') : t('Member profile')}
          >
            <PanelRight className="h-4 w-4" />
          </button>
        </header>

        {direct ? (
          <>
            <ActiveDelegations
              items={activeDelegations(chatDelegations, chat.id)}
              bots={byId}
              onOpenConversation={(id, title) => setHistory({ id, title })}
            />
            <DirectTimeline chat={chat} bot={direct} />
          </>
        ) : (
          <GroupTimeline
            chat={chat}
            bots={byId}
            timeline={timeline}
            runtime={runtime}
            delegations={chatDelegations}
            onLoadOlder={() => void useBotsStore.getState().loadOlder(chat.id)}
            onOpenConversation={(id, title) => setHistory({ id, title })}
          />
        )}

        <div className="@container pt-1">
          <div className={cn(CHAT_COL, 'pb-4')}>
            <PendingBars items={pending} bots={byId} showNames={chat.kind === 'group'} />
            <BotComposer
              draftKey={`bot:${chat.id}`}
              placeholder={
                direct
                  ? t('Message {{name}}…', { name: direct.name })
                  : t('@ a member, or just say it…')
              }
              members={chat.kind === 'group' ? members : undefined}
              running={summary.running || Boolean(runtime?.current || runtime?.routing)}
              disabled={archived}
              hint={hint}
              toolbar={direct ? <DirectChips bot={direct} /> : null}
              onSend={send}
              onStop={() => void useBotsStore.getState().stop(chat.id)}
            />
          </div>
        </div>
      </div>

      {panelOpen && (
        <aside className="flex w-80 shrink-0 flex-col overflow-hidden border-l bg-background">
          {direct ? (
            <BotProfilePanel
              botId={direct.id}
              chat={chat}
              onOpenHistory={(id, title) => setHistory({ id, title })}
            />
          ) : (
            <GroupInfoPanel chat={chat} />
          )}
        </aside>
      )}

      <SessionHistoryDialog
        conversationId={history?.id ?? null}
        title={history?.title ?? ''}
        speaker={
          historySpeaker
            ? { name: historySpeaker.name, color: historySpeaker.avatar.color }
            : undefined
        }
        onClose={() => setHistory(null)}
      />
    </div>
  );
}

/** 私聊顶部：该成员发起、仍在进行的委派 */
function ActiveDelegations({
  items,
  bots,
  onOpenConversation,
}: {
  items: ReturnType<typeof activeDelegations>;
  bots: Map<string, BotProfile>;
  onOpenConversation: (conversationId: string, title: string) => void;
}) {
  const { t } = useI18n();
  if (items.length === 0) return null;
  return (
    <div className="shrink-0 border-b bg-muted/30">
      <div className={cn(CHAT_COL, 'py-2')}>
        <div className="mb-1.5 text-muted-foreground text-xs">
          {t('Delegations in progress · {{n}}', { n: items.length })}
        </div>
        <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
          {items.map((record) => (
            <DelegationCard
              key={record.id}
              record={record}
              bots={bots}
              onOpenConversation={onOpenConversation}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function DirectSubtitle({
  bot,
  running,
  queued,
}: {
  bot: BotProfile;
  running: boolean;
  queued: boolean;
}) {
  const { t } = useI18n();
  const model = useModelLabel(bot);
  const status = running ? t('Working') : queued ? t('Queued') : t('Idle');
  return <>{[bot.title, model, status].filter(Boolean).join(' · ')}</>;
}

function DirectChips({ bot }: { bot: BotProfile }) {
  const { t } = useI18n();
  const model = useModelLabel(bot);
  const meta = APPROVAL_MODE_META[bot.approvalMode];
  return (
    <>
      <span className="flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground text-xs">
        <Sparkles className="h-3 w-3 shrink-0" />
        <span className="max-w-32 truncate">{model}</span>
      </span>
      <span className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground text-xs">
        <Shield className="h-3 w-3" />
        {t(meta.labelKey)}
      </span>
    </>
  );
}

function DirectTimeline({ chat, bot }: { chat: BotChat; bot: BotProfile }) {
  const { t } = useI18n();
  const conversationId = chat.sessions[bot.id]?.conversationId ?? null;
  const projection = useBotsStore((s) => (conversationId ? s.sessions[conversationId] : undefined));
  const historyLoading = useBotsStore((s) =>
    conversationId ? Boolean(s.sessionHistoryLoading[conversationId]) : false
  );
  const timelineRef = useRef<MessageTimelineHandle>(null);
  const running = projection?.status === 'running';
  const items = useMemo(
    () =>
      projection
        ? buildTimeline(projection.messages, running, projection.customEntries, undefined, {
            historyBaseIndex: projection.historyBaseIndex,
            toolOutputs: projection.toolOutputs,
            pendingApprovals: projection.pendingApprovals,
            toolStartedAt: projection.toolStartedAt,
          })
        : [],
    [projection, running]
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: items 是触发信号
  useEffect(() => {
    if (timelineRef.current?.isAtBottom()) timelineRef.current.pinToBottom();
  }, [items]);

  const host = useMemo(
    () => ({
      sessionId: conversationId,
      canRewind: false,
      canRetry: false,
      speaker: { name: bot.name, color: bot.avatar.color },
    }),
    [conversationId, bot.name, bot.avatar.color]
  );
  const hasOlder = (projection?.historyBaseIndex ?? 0) > 0;

  if (!conversationId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <BotAvatar bot={bot} size="lg" />
        <p className="font-medium text-lg">{bot.name}</p>
        <p className="max-w-sm text-muted-foreground text-sm">{bot.scope || bot.title}</p>
      </div>
    );
  }
  return (
    <ChatHostContext.Provider value={host}>
      <div className="@container flex min-h-0 flex-1 flex-col">
        <MessageTimeline
          key={conversationId}
          ref={timelineRef}
          items={items}
          busy={running}
          loading={false}
          running={running}
          runStartedAt={projection?.runStartedAt}
          lastOutputAt={projection?.lastOutputAt}
          error={projection?.status === 'failed' ? projection.error : undefined}
          emptyTitle={t('Say hi to {{name}}', { name: bot.name })}
          historyLoading={historyLoading}
          hasOlder={hasOlder}
          olderCursor={projection?.historyBaseIndex}
          onStartReached={
            hasOlder
              ? () => void useBotsStore.getState().loadOlderSession(conversationId)
              : undefined
          }
        />
        {projection?.retry && (
          <div className={CHAT_COL}>
            <RetryBar retry={projection.retry} />
          </div>
        )}
      </div>
    </ChatHostContext.Provider>
  );
}

/** 该聊天相关成员会话的待审批 / 提问，按会话分组内联在输入框上方 */
export function PendingBars({
  items,
  bots,
  showNames,
}: {
  items: PendingItem[];
  bots: Map<string, BotProfile>;
  showNames: boolean;
}) {
  const { t } = useI18n();
  const groups = new Map<string, PendingItem[]>();
  for (const item of items)
    groups.set(item.conversationId, [...(groups.get(item.conversationId) ?? []), item]);
  return (
    <>
      {[...groups.entries()].map(([conversationId, list]) => {
        const bot = bots.get(list[0].botId);
        const delegation = list[0].delegation;
        const name = bot?.name ?? t('Deleted member');
        const approvals = list.flatMap((item) => (item.kind === 'approval' ? [item.request] : []));
        const asks = list.flatMap((item) => (item.kind === 'ask' ? [item.request] : []));
        return (
          <div key={conversationId}>
            {(showNames || delegation) && (
              <div className="mb-1 flex items-center gap-1.5 text-muted-foreground text-xs">
                <BotAvatar bot={bot} size="xs" />
                {delegation
                  ? t('{{name}} (on behalf of {{owner}}) needs you', {
                      name,
                      owner: bots.get(delegation.parentBotId)?.name ?? t('Deleted member'),
                    })
                  : t('{{name}} needs you', { name })}
              </div>
            )}
            <ApprovalBar
              approvals={approvals}
              onRespond={(requestId, decision) =>
                void window.electronAPI.agent.respondApproval(conversationId, requestId, decision)
              }
            />
            <AskBar
              asks={asks}
              onAnswer={(requestId, answer) =>
                void window.electronAPI.agent.respondAsk(conversationId, requestId, answer)
              }
            />
          </div>
        );
      })}
    </>
  );
}
