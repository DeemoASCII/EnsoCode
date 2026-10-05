import type {
  PairBotActivity,
  PairBotChatState,
  PairBotChatSummary,
  PairBotMember,
  PairDelegationState,
  PairGroupEntry,
} from '@enso/pair';
import { ArrowUp, ChevronRight, Loader2, PanelLeft, Square } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { ApprovalBar } from '@/components/chat/ApprovalBar';
import { AskBar } from '@/components/chat/AskBar';
import { Markdown } from '@/components/chat/Markdown';
import { cn } from '@/lib/utils';
import { BotActivityRow } from './BotActivityRow';
import { BotArtifacts } from './BotArtifacts';
import { BotAvatar } from './BotAvatar';
import {
  activeMention,
  type GroupTimelineState,
  insertMention,
  type MentionOption,
  mentionOptions,
} from './botState';
import type { ConnState, SessionView } from './client';
import { readOnlyBanner } from './readOnly';

export interface MemberPending {
  sessionId: string;
  botId: string;
  view: SessionView;
}

interface Props {
  chat: PairBotChatSummary;
  bots: ReadonlyMap<string, PairBotMember>;
  timeline: GroupTimelineState | undefined;
  state: PairBotChatState | undefined;
  pending: MemberPending[];
  /** 本群成员（含委派子会话）的实时运行态 */
  activities: PairBotActivity[];
  clockOffset: number;
  connState: ConnState;
  stateLabel: string;
  notice: string | null;
  /** 离线待发队列；有它时断线也可发送（先入队，连上后重发） */
  outbox?: ReactNode;
  /** 桌面把本设备设为只读：只能看时间线 */
  deviceReadOnly?: boolean;
  /** 有写操作刚被桌面以只读拦下 */
  readOnlyRejected?: boolean;
  onOpenDrawer(): void;
  onLoadOlder(): void;
  onSend(text: string): void;
  onStop(): void;
  onOpenProcess(conversationId: string): void;
  onApproval(
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'allowSession' | 'deny'
  ): void;
  onAsk(sessionId: string, requestId: string, answer: string): void;
}

const DELEGATION_TEXT: Record<PairDelegationState, string> = {
  queued: '排队中',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
};

const timeOf = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** 已知成员名的 @提及高亮 */
function withMentions(text: string, names: readonly string[]): ReactNode[] {
  const sorted = [...names].sort((a, b) => b.length - a.length);
  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest) {
    const at = rest.indexOf('@');
    const name = at < 0 ? undefined : sorted.find((n) => rest.startsWith(n, at + 1));
    if (at < 0 || !name) {
      out.push(rest);
      break;
    }
    if (at > 0) out.push(rest.slice(0, at));
    out.push(
      <span key={key++} className="font-medium text-brand">
        @{name}
      </span>
    );
    rest = rest.slice(at + 1 + name.length);
  }
  return out;
}

/** 群聊：时间线 + @ 补全输入框；成员会话过程按需只读查看 */
export function GroupChatScreen(props: Props) {
  const { chat, bots, timeline, state } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  const stickRef = useRef(true);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const entries = timeline?.entries ?? [];
  const members = chat.members
    .map((id) => bots.get(id))
    .filter((bot): bot is PairBotMember => Boolean(bot && !bot.archived));
  const names = members.map((bot) => bot.name);
  const running = Boolean(state?.current) || chat.status !== 'idle';
  const mention = activeMention(text, caret);
  const options: MentionOption[] = mention ? mentionOptions(mention.query, members) : [];
  const firstSeq = entries[0]?.seq;
  const lastSeq = entries.at(-1)?.seq;

  // 旧页插到顶部后补偿 scrollTop；新条目到达时若原本贴底则跟随
  // biome-ignore lint/correctness/useExhaustiveDependencies: 首末 seq 变化即为触发信号
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const anchor = anchorRef.current;
    if (anchor) {
      anchorRef.current = null;
      el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
    } else if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [firstSeq, lastSeq, state?.current, props.activities.length]);

  const loadOlder = () => {
    const el = scrollRef.current;
    if (!timeline?.hasOlder || !el) return;
    anchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
    props.onLoadOlder();
  };

  const pick = (option: MentionOption) => {
    if (!mention) return;
    const next = insertMention(text, mention, caret, option.name);
    setText(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const submit = () => {
    if (!text.trim()) return;
    props.onSend(text);
    setText('');
    setCaret(0);
    stickRef.current = true;
  };

  const renderEntry = (entry: PairGroupEntry) => {
    switch (entry.kind) {
      case 'human':
        return (
          <div key={entry.seq} className="flex justify-end">
            <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-brand/10 px-3 py-2 text-sm">
              {withMentions(entry.text, names)}
            </div>
          </div>
        );
      case 'bot': {
        const bot = bots.get(entry.botId);
        return (
          <div key={entry.seq} className="flex gap-2">
            <BotAvatar bot={bot} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="flex items-baseline gap-1.5 text-xs">
                <span className="font-medium">{bot?.name ?? '成员'}</span>
                <span className="text-muted-foreground">{timeOf(entry.at)}</span>
              </p>
              <div className="mt-0.5 min-w-0 text-sm">
                <Markdown text={entry.text} />
              </div>
              <BotArtifacts target={{ chatId: props.chat.id, entryId: entry.id }} />
              <button
                type="button"
                onClick={() => props.onOpenProcess(entry.conversationId)}
                className="mt-0.5 flex items-center gap-0.5 text-muted-foreground text-xs hover:text-foreground"
              >
                <ChevronRight className="h-3 w-3" />
                查看过程
              </button>
            </div>
          </div>
        );
      }
      case 'delegation':
        return (
          <div key={entry.seq} className="rounded-lg border bg-muted/30 px-3 py-2 text-xs">
            <p className="flex items-center gap-1.5">
              <span className="font-medium">
                {bots.get(entry.from)?.name ?? '成员'} → {bots.get(entry.to)?.name ?? '成员'}
              </span>
              <span
                className={cn(
                  'rounded px-1.5 py-0.5',
                  entry.state === 'running' || entry.state === 'queued'
                    ? 'bg-brand/10 text-brand'
                    : entry.state === 'failed'
                      ? 'bg-destructive/10 text-destructive'
                      : 'bg-muted text-muted-foreground'
                )}
              >
                {DELEGATION_TEXT[entry.state]}
              </span>
            </p>
            {entry.summary && (
              <p className="mt-1 line-clamp-3 text-muted-foreground">{entry.summary}</p>
            )}
          </div>
        );
      case 'system':
        return (
          <p key={entry.seq} className="text-center text-muted-foreground text-xs">
            {entry.text}
          </p>
        );
    }
  };

  const current = state?.current ? bots.get(state.current) : undefined;

  return (
    <div className="phone-chat-root flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-1 border-b bg-background px-2 py-2 pt-safe">
        <button
          type="button"
          onClick={props.onOpenDrawer}
          aria-label="打开会话列表"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PanelLeft className="h-4.5 w-4.5" />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <p className="truncate font-medium text-sm">{chat.title || '群聊'}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {props.connState === 'online' ? `${chat.members.length} 位成员` : props.stateLabel}
          </p>
        </div>
        <span className="h-9 w-9 shrink-0" />
      </header>

      <div
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (el.scrollTop < 60) loadOlder();
        }}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
      >
        {timeline === undefined ? (
          <p className="flex items-center justify-center gap-1.5 py-8 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            读取中…
          </p>
        ) : timeline.hasOlder ? (
          <button
            type="button"
            onClick={loadOlder}
            className="w-full py-1 text-center text-muted-foreground text-xs"
          >
            加载更早的消息
          </button>
        ) : entries.length === 0 ? (
          <p className="py-8 text-center text-muted-foreground text-sm">
            @ 成员开始对话，未 @ 时由群主回复
          </p>
        ) : null}
        {entries.map(renderEntry)}
        {props.activities.map((item) => (
          <BotActivityRow
            key={item.conversationId}
            item={item}
            bots={bots}
            clockOffset={props.clockOffset}
            onOpen={props.onOpenProcess}
          />
        ))}
        {current && props.activities.length === 0 && (
          <div className="flex items-center gap-2">
            <BotAvatar bot={current} size="sm" busy />
            <span className="text-muted-foreground text-xs">{current.name} 正在回复…</span>
          </div>
        )}
      </div>

      <div className="phone-dock shrink-0 space-y-2 px-3 pt-1 pb-safe">
        {props.outbox}
        {props.notice && (
          <p className="rounded-md bg-destructive/10 px-2 py-1 text-destructive text-xs">
            {props.notice}
          </p>
        )}
        {props.deviceReadOnly && (
          <p className="rounded-md bg-muted px-2 py-1 text-center text-muted-foreground text-xs">
            {readOnlyBanner(props.readOnlyRejected)}
          </p>
        )}
        {!props.deviceReadOnly &&
          props.pending.map(({ sessionId, botId, view }) =>
            view.approvals.length > 0 || view.asks.length > 0 ? (
              <div key={sessionId} className="space-y-1">
                <p className="text-muted-foreground text-xs">{bots.get(botId)?.name ?? '成员'}</p>
                <ApprovalBar
                  approvals={view.approvals}
                  clockOffset={props.clockOffset}
                  onRespond={(requestId, decision) =>
                    props.onApproval(sessionId, requestId, decision)
                  }
                />
                <AskBar
                  asks={view.asks}
                  clockOffset={props.clockOffset}
                  onAnswer={(requestId, answer) => props.onAsk(sessionId, requestId, answer)}
                />
              </div>
            ) : null
          )}
        <div className={cn('relative', props.deviceReadOnly && 'hidden')}>
          {options.length > 0 && (
            <div className="absolute right-0 bottom-full left-0 mb-1 max-h-48 overflow-y-auto rounded-lg border bg-popover p-1 shadow-md">
              {options.map((option) => {
                const bot = bots.get(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => pick(option)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    {bot ? (
                      <BotAvatar bot={bot} size="sm" />
                    ) : (
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs">
                        @
                      </span>
                    )}
                    <span className="font-medium">{option.name}</span>
                    {bot?.title && (
                      <span className="truncate text-muted-foreground text-xs">{bot.title}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex items-end gap-2 rounded-2xl border bg-background px-3 py-2">
            <textarea
              ref={inputRef}
              rows={1}
              value={text}
              placeholder="@ 成员，或直接说…"
              onChange={(event) => {
                setText(event.target.value);
                setCaret(event.target.selectionStart ?? event.target.value.length);
              }}
              onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
              className="max-h-32 min-h-6 flex-1 resize-none bg-transparent text-sm outline-none field-sizing-content"
            />
            {running && (
              <button
                type="button"
                aria-label="停止"
                onClick={props.onStop}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-foreground"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </button>
            )}
            <button
              type="button"
              aria-label="发送"
              disabled={!text.trim() || (!props.outbox && props.connState !== 'online')}
              onClick={submit}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-brand-foreground disabled:opacity-40"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
