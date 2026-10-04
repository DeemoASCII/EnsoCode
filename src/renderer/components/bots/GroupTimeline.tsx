import type { ProjectedMessage } from '@shared/types/agent';
import type { BotChat, BotProfile, BotRoutedBy, Delegation, GroupEntry } from '@shared/types/bot';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Markdown } from '@/components/chat/Markdown';
import { useI18n } from '@/i18n';
import { toolLabel } from '@/lib/toolLabels';
import { cn } from '@/lib/utils';
import { type ChatRuntime, type TimelineState, useBotsStore } from '@/stores/bots';
import { isRetried } from '@/stores/bots/delegations';
import { focusStep } from '@/stores/bots/focus';
import {
  anchorDelegations,
  buildRows,
  locateTurn,
  type TurnStep,
  turnSteps,
} from '@/stores/bots/groupTimeline';
import { ArtifactCards } from './ArtifactCards';
import { BotAvatar } from './BotAvatar';
import { DelegationCard } from './DelegationCard';
import { RoutineProposalCard } from './RoutineCards';
import { SilenceNote } from './SilenceNote';

const timeOf = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const ROUTED_BY_LABELS: Record<BotRoutedBy, string> = {
  smart: 'Smart pick',
  'smart:build': 'Smart pick · build',
  'smart:answer': 'Smart pick · answer',
  'smart:discuss': 'Smart pick · discuss',
};

interface GroupTimelineProps {
  chat: BotChat;
  bots: Map<string, BotProfile>;
  timeline: TimelineState | undefined;
  runtime: ChatRuntime | undefined;
  /** 本群全部委派记录；进行中的接在时间线末尾 */
  delegations: Delegation[];
  /** 搜索跳转：滚到该条并短暂高亮 */
  focus?: { seq: number; query: string; nonce: number };
  onFocusDone?: (nonce: number) => void;
  onLoadOlder: () => void;
  onOpenConversation: (conversationId: string, title: string) => void;
  /** 实时查看正在回复成员的群会话 */
  onOpenLive: (conversationId: string, botId: string) => void;
}

export function GroupTimeline({
  chat,
  bots,
  timeline,
  runtime,
  delegations,
  focus,
  onFocusDone,
  onLoadOlder,
  onOpenConversation,
  onOpenLive,
}: GroupTimelineProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const prependRef = useRef<{ firstSeq: number; height: number } | null>(null);
  const entries = timeline?.entries ?? [];
  const rows = useMemo(() => buildRows(entries), [entries]);
  const records = useMemo(
    () =>
      new Map(
        delegations.map((item) => [
          item.id,
          { record: item, retried: isRetried(item, delegations) },
        ])
      ),
    [delegations]
  );
  const active = useMemo(
    () =>
      delegations
        .filter((item) => item.state === 'queued' || item.state === 'running')
        .sort((a, b) => a.createdAt - b.createdAt),
    [delegations]
  );
  const placed = useMemo(() => anchorDelegations(entries, active), [entries, active]);
  const card = (record: Delegation) => (
    <DelegationCard
      key={record.id}
      record={record}
      bots={bots}
      onOpenConversation={onOpenConversation}
    />
  );
  const replying = runtime?.current ? bots.get(runtime.current) : undefined;
  const replyingId = runtime?.current ? chat.sessions[runtime.current]?.conversationId : undefined;
  const replyingSession = useBotsStore((s) => (replyingId ? s.sessions[replyingId] : undefined));
  const activity = currentActivity(replyingSession?.messages);

  // 进入聊天先贴底
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在切换聊天时执行
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
  }, [chat.id]);

  // 上翻页落地后保持视口位置；底部新消息在贴底时跟随
  // biome-ignore lint/correctness/useExhaustiveDependencies: 条目、委派与 typing 变化是触发信号
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const pending = prependRef.current;
    if (pending && entries[0] && entries[0].seq < pending.firstSeq) {
      el.scrollTop += el.scrollHeight - pending.height;
      prependRef.current = null;
      return;
    }
    if (atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [entries, active.length, replying?.id, activity, runtime?.routing]);

  useEffect(() => {
    if (!timeline?.loading) prependRef.current = null;
  }, [timeline?.loading]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (el.scrollTop < 80 && timeline?.hasOlder && !timeline.loading && entries[0]) {
      prependRef.current = { firstSeq: entries[0].seq, height: el.scrollHeight };
      onLoadOlder();
    }
  };

  const [flashSeq, setFlashSeq] = useState<number | null>(null);
  const handledFocus = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 条目加载与翻页状态是推进信号
  useEffect(() => {
    if (!focus || handledFocus.current === focus.nonce) return;
    const step = focusStep({
      target: focus.seq,
      earliest: timeline ? (entries[0]?.seq ?? Number.POSITIVE_INFINITY) : undefined,
      hasOlder: Boolean(timeline?.hasOlder),
      loading: Boolean(timeline?.loading),
    });
    if (step === 'wait') return;
    if (step === 'load') {
      onLoadOlder();
      return;
    }
    handledFocus.current = focus.nonce;
    onFocusDone?.(focus.nonce);
    if (step !== 'scroll') return;
    atBottomRef.current = false;
    setFlashSeq(focus.seq);
    requestAnimationFrame(() =>
      scrollRef.current
        ?.querySelector(`[data-seq="${focus.seq}"]`)
        ?.scrollIntoView({ block: 'center' })
    );
  }, [focus, entries, timeline?.hasOlder, timeline?.loading]);
  useEffect(() => {
    if (flashSeq === null) return;
    const timer = window.setTimeout(() => setFlashSeq(null), 2500);
    return () => window.clearTimeout(timer);
  }, [flashSeq]);

  return (
    <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-4">
        {timeline?.loading && (
          <div className="flex justify-center py-1 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        )}
        {timeline && !timeline.hasOlder && entries.length > 0 && (
          <div className="text-center text-[11px] text-muted-foreground">
            {t('Beginning of the chat')}
          </div>
        )}
        {!timeline && (
          <div className="flex justify-center py-6 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        )}
        {timeline && entries.length === 0 && (
          <p className="py-10 text-center text-muted-foreground text-sm">
            {t('Say something. Mention a member with @, or the group owner replies.')}
          </p>
        )}
        {placed.head.map(card)}
        {rows.map((row) =>
          row.kind === 'day' ? (
            <div key={row.key} className="py-1 text-center text-[11px] text-muted-foreground">
              {new Date(row.at).toLocaleDateString()}
            </div>
          ) : (
            <Fragment key={row.key}>
              <div
                data-seq={row.entry.seq}
                className={cn(
                  '-mx-2 flex flex-col rounded-lg px-2 transition-colors duration-500',
                  flashSeq === row.entry.seq && 'bg-brand/10'
                )}
              >
                <EntryRow
                  chatId={chat.id}
                  entry={row.entry}
                  continued={row.continued}
                  bots={bots}
                  records={records}
                  onOpenConversation={onOpenConversation}
                />
              </div>
              {placed.after.get(row.entry.id)?.map(card)}
            </Fragment>
          )
        )}
        {!replying && runtime?.routing && (
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <TypingDots />
            {t('Choosing who replies…')}
          </div>
        )}
        {replying && (
          <button
            type="button"
            disabled={!replyingId}
            title={t('View live')}
            onClick={() => replyingId && onOpenLive(replyingId, replying.id)}
            className="-mx-2 flex gap-2.5 rounded-lg px-2 py-1 text-left hover:bg-muted/60 disabled:pointer-events-none"
          >
            <BotAvatar bot={replying} size="sm" busy />
            <div className="min-w-0">
              <div className="text-muted-foreground text-xs">
                <span className="mr-1.5 font-semibold text-foreground">{replying.name}</span>
                {t('Replying')}
              </div>
              <div className="flex items-center gap-2 text-muted-foreground text-xs">
                <TypingDots />
                {activity && <span className="truncate">{toolLabel(activity, t)}…</span>}
                <SilenceNote conversationId={replyingId} />
                {replyingId && (
                  <span className="shrink-0 underline-offset-2 hover:underline">
                    {t('View live')}
                  </span>
                )}
              </div>
            </div>
          </button>
        )}
      </div>
    </div>
  );
}

/** 正在进行的最后一个工具调用名 */
function currentActivity(messages: ProjectedMessage[] | undefined): string | undefined {
  const last = messages?.at(-1);
  if (last?.role !== 'assistant') return undefined;
  const call = [...last.content].reverse().find((part) => part.type === 'toolCall');
  return call?.type === 'toolCall' ? call.name : undefined;
}

function TypingDots() {
  return (
    <span className="flex gap-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground"
          style={{ animationDelay: `${i * 0.2}s` }}
        />
      ))}
    </span>
  );
}

function EntryRow({
  chatId,
  entry,
  continued,
  bots,
  records,
  onOpenConversation,
}: {
  chatId: string;
  entry: GroupEntry;
  continued: boolean;
  bots: Map<string, BotProfile>;
  records: Map<string, { record: Delegation; retried: boolean }>;
  onOpenConversation: (conversationId: string, title: string) => void;
}) {
  const { t } = useI18n();
  switch (entry.kind) {
    case 'system':
      return entry.routine ? (
        <RoutineProposalCard text={entry.text} target={entry.routine} />
      ) : (
        <div className="self-center rounded-full bg-muted px-2.5 py-0.5 text-center text-muted-foreground text-xs">
          {entry.text}
        </div>
      );
    case 'human':
      return (
        <div className="flex max-w-[80%] flex-col items-end self-end">
          <div className="whitespace-pre-wrap break-words rounded-xl rounded-tr-sm bg-primary px-3 py-2 text-primary-foreground text-sm">
            <MentionText text={entry.text} bots={bots} />
          </div>
          {!continued && (
            <span className="mt-0.5 text-[11px] text-muted-foreground">{timeOf(entry.at)}</span>
          )}
        </div>
      );
    case 'delegation':
      return (
        <DelegationCard
          record={records.get(entry.delegationId)?.record}
          retried={records.get(entry.delegationId)?.retried}
          entry={entry}
          bots={bots}
          onOpenConversation={onOpenConversation}
        />
      );
    case 'bot': {
      const bot = bots.get(entry.botId);
      return (
        <div className={cn('flex max-w-[85%] gap-2.5', continued && '-mt-1.5')}>
          {continued ? <span className="w-6 shrink-0" /> : <BotAvatar bot={bot} size="sm" />}
          <div className="min-w-0">
            {!continued && (
              <div className="mb-0.5 text-muted-foreground text-xs">
                <span className="mr-1.5 font-semibold text-foreground">
                  {bot?.name ?? t('Deleted member')}
                </span>
                {bot?.title ? `${bot.title} · ` : ''}
                {timeOf(entry.at)}
                {entry.routedBy && (
                  <span
                    title={t('Picked automatically because nobody was @-mentioned')}
                    className="ml-1.5 rounded border px-1 py-px text-[10px]"
                  >
                    {t(ROUTED_BY_LABELS[entry.routedBy])}
                  </span>
                )}
              </div>
            )}
            <div className="rounded-xl rounded-tl-sm bg-muted px-3 py-2 text-sm">
              <Markdown text={entry.text} />
            </div>
            <ArtifactCards target={{ chatId, entryId: entry.id }} />
            <TurnProcess
              entry={entry}
              onOpen={() => onOpenConversation(entry.conversationId, bot?.name ?? '')}
            />
          </div>
        </div>
      );
    }
  }
}

function MentionText({ text, bots }: { text: string; bots: Map<string, BotProfile> }) {
  const parts = useMemo(() => {
    const names = [...bots.values()].map((bot) => bot.name).sort((a, b) => b.length - a.length);
    if (names.length === 0) return [text];
    const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
    return text.split(new RegExp(`(@(?:${escaped.join('|')}|所有人|everyone|all))`, 'giu'));
  }, [text, bots]);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith('@') && index % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 拆分片段按位置稳定
          <span key={index} className="font-medium underline underline-offset-2">
            {part}
          </span>
        ) : (
          part
        )
      )}
    </>
  );
}

/** 「查看过程」：按 conversationId 读会话，定位该轮并列出工具调用 */
function TurnProcess({
  entry,
  onOpen,
}: {
  entry: Extract<GroupEntry, { kind: 'bot' }>;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<
    { steps: TurnStep[]; exact: boolean } | { error: string } | null
  >(null);

  useEffect(() => {
    if (!open || state) return;
    let alive = true;
    const resolve = (messages: ProjectedMessage[]) => {
      const range = locateTurn(messages, entry.text);
      if (!alive) return;
      if (!range) return setState({ error: t('No process recorded.') });
      setState({ steps: turnSteps(messages.slice(range.start, range.end)), exact: range.exact });
    };
    const live = useBotsStore.getState().sessions[entry.conversationId]?.messages;
    if (live?.some((message) => message.role === 'assistant')) {
      resolve(live);
    } else {
      void window.electronAPI.bots
        .sessionHistory({ conversationId: entry.conversationId })
        .then((result) =>
          result.ok ? resolve(result.messages) : alive && setState({ error: result.error })
        );
    }
    return () => {
      alive = false;
    };
  }, [open, state, entry.conversationId, entry.text, t]);

  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
      >
        <Icon className="h-3 w-3" />
        {t('View process')}
        {state && 'steps' in state && ` · ${t('{{n}} steps', { n: state.steps.length })}`}
      </button>
      {open && (
        <div className="mt-1.5 rounded-lg border bg-card px-3 py-2 font-mono text-muted-foreground text-xs leading-relaxed">
          {!state && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {state && 'error' in state && <span>{state.error}</span>}
          {state && 'steps' in state && (
            <>
              {!state.exact && (
                <div className="mb-1 font-sans italic">
                  {t('Could not locate this reply; showing the latest turn.')}
                </div>
              )}
              {state.steps.length === 0 && (
                <div className="font-sans">{t('No tool calls in this turn.')}</div>
              )}
              {state.steps.map((step) => (
                <div key={step.id} className={cn('truncate', step.error && 'text-destructive')}>
                  {step.error ? '✗' : '·'} {toolLabel(step.name, t)}
                  {step.detail && <span className="text-foreground/80"> {step.detail}</span>}
                </div>
              ))}
            </>
          )}
          <button
            type="button"
            onClick={onOpen}
            className="mt-1.5 font-sans text-foreground underline-offset-2 hover:underline"
          >
            {t('Open full conversation')}
          </button>
        </div>
      )}
    </div>
  );
}
