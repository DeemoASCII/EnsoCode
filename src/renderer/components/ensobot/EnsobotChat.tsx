import type { EnsobotWorkStep } from '@shared/ensobot/activity';
import { RELAY_LIMIT } from '@shared/ensobot/discussion';
import { type EnsobotRoom, RELAY_LIMIT_MAX } from '@shared/ensobot/rooms';
import type { EnsobotCardFace, EnsobotSnapshot } from '@shared/ensobot/snapshot';
import {
  AtSign,
  Bot,
  BriefcaseBusiness,
  ChevronRight,
  Crown,
  Hash,
  LayoutGrid,
  MessageCircle,
  MessagesSquare,
  Send,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { EnsobotInteractionItem } from './EnsobotInteractions';
import { BotSelect, CirclePhoto, EmptyState, SurfaceHeader, TaskStatus } from './EnsobotPrimitives';
import {
  EnsobotMarkdown,
  LiveRow,
  MentionText,
  StatusDot,
  useStatusLabel,
  WorkLog,
} from './EnsobotWork';
import {
  type ChatSelection,
  inlineInteractionIds,
  type MemberStatusKind,
  memberStatus,
  surfaceActivity,
} from './ensobotView';
import { runCommand } from './useEnsobot';

const LIVE_KINDS = new Set<MemberStatusKind>([
  'thinking',
  'typing',
  'tool',
  'retrying',
  'approval',
  'ask',
]);

export function ChatPane({
  snapshot,
  selection,
  local,
  canEdit,
  onEdit,
  onWorkspace,
  text,
  setText,
}: {
  snapshot: EnsobotSnapshot;
  selection: ChatSelection;
  local: boolean;
  canEdit: boolean;
  onEdit: (id: string) => void;
  onWorkspace: () => void;
  text: string;
  setText: (value: string | ((current: string) => string)) => void;
}) {
  const { t } = useI18n();
  const label = useStatusLabel();
  const [sending, setSending] = useState(false);
  const [retarget, setRetarget] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const card =
    selection.kind === 'dm'
      ? snapshot.cards.find((item) => item.id === selection.cardId)
      : undefined;
  const room =
    selection.kind === 'room'
      ? snapshot.groups.find((item) => item.id === selection.roomId)
      : undefined;
  const members = room
    ? snapshot.cards.filter((item) => room.memberIds.includes(item.id))
    : card
      ? [card]
      : [];
  const messages = (
    selection.kind === 'dm'
      ? snapshot.bubbles.filter((item) => item.cardId === selection.cardId)
      : snapshot.roomMessages.filter((item) => item.roomId === selection.roomId)
  ).sort((a, b) => a.seq - b.seq);
  const live = surfaceActivity(snapshot, selection);
  const inline = useMemo(() => inlineInteractionIds(snapshot, selection), [snapshot, selection]);
  const hostId = room?.hostId;
  const hostName = members.find((member) => member.id === hostId)?.name;
  const statusOf = (id: string) => memberStatus(snapshot, id);
  const busy = members
    .map((member) => ({ member, status: statusOf(member.id) }))
    .filter((item) => item.status.kind !== 'idle');
  // 只有对方正在干活时“替换”才有意义；空闲时这句话本来就会开一轮新的。
  const canRetarget = !!card && LIVE_KINDS.has(statusOf(card.id).kind);
  const tasks = snapshot.tasks.filter(
    (task) =>
      members.some((member) => member.id === task.cardId) &&
      (task.status === 'doing' || task.status === 'claimed' || task.status === 'waiting-directory')
  );
  useEffect(() => {
    if (snapshot.seq >= 0 && atBottom.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [snapshot.seq]);
  const send = async () => {
    if (sending || !text.trim()) return;
    const body = text;
    const deliveryId = crypto.randomUUID();
    const replace = retarget && canRetarget;
    setSending(true);
    setError('');
    setNote('');
    const result =
      selection.kind === 'dm'
        ? await runCommand(
            {
              type: 'ensobot-send',
              cardId: selection.cardId,
              text: body,
              deliveryId,
              retarget: replace,
            },
            () =>
              window.electronAPI.ensobot.send({
                cardId: selection.cardId,
                text: body,
                deliveryId,
                retarget: replace,
              }),
            deliveryId
          )
        : await runCommand(
            { type: 'ensobot-room-send', roomId: selection.roomId, text: body, deliveryId },
            () =>
              window.electronAPI.ensobot.sendRoom({
                roomId: selection.roomId,
                text: body,
                deliveryId,
              }),
            deliveryId
          );
    setSending(false);
    if (!result.ok) {
      setError(result.error ?? t('Failed'));
      return;
    }
    setText((current) => (current === body ? '' : current));
    setRetarget(false);
    atBottom.current = true;
    if (result.disposition === 'partial')
      setNote(t('The message is in the room, but someone could not be woken.'));
  };
  if (!card && !room) return null;
  return (
    <section data-slot="ensobot-chat" className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-[72px] shrink-0 items-center gap-3 border-b px-6">
        {card ? (
          <span className="relative shrink-0">
            <CirclePhoto
              src={card.previewUrl}
              crop={card.crop}
              width={card.width}
              height={card.height}
              size={38}
              alt={card.name}
            />
            <StatusDot kind={statusOf(card.id).kind} className="absolute right-0 bottom-0" />
          </span>
        ) : (
          <span className="flex size-10 items-center justify-center rounded-xl bg-muted">
            <Hash className="size-5" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{card?.name ?? room?.name}</h1>
          <p
            data-slot="ensobot-chat-status"
            className="mt-1 truncate text-[11px] text-muted-foreground"
          >
            {busy.length
              ? busy
                  .map((item) =>
                    room ? `${item.member.name} ${label(item.status)}` : label(item.status)
                  )
                  .join(' · ')
              : room
                ? members.map((member) => member.name).join(' · ')
                : t('Private chat')}
          </p>
        </div>
        {room ? (
          <ul data-slot="ensobot-member-strip" className="flex shrink-0 items-center gap-1.5">
            {members.map((member) => {
              const status = statusOf(member.id);
              return (
                <li
                  key={member.id}
                  data-card={member.id}
                  data-status={status.kind}
                  className="relative"
                  title={`${member.name}${member.id === hostId ? ` · ${t('Group host')}` : ''} · ${label(status)}`}
                >
                  <CirclePhoto
                    src={member.previewUrl}
                    crop={member.crop}
                    width={member.width}
                    height={member.height}
                    size={28}
                    alt={member.name}
                  />
                  {member.id === hostId ? (
                    <Crown
                      aria-label={t('Group host')}
                      className="absolute -top-1.5 -right-1 size-3 rounded-full bg-background p-px text-warning"
                    />
                  ) : null}
                  <StatusDot kind={status.kind} className="absolute -right-0.5 -bottom-0.5" />
                </li>
              );
            })}
          </ul>
        ) : null}
        {card && local ? (
          <Button variant="ghost" size="sm" disabled={!canEdit} onClick={() => onEdit(card.id)}>
            <Settings2 className="size-3.5" />
            {t('Character card')}
          </Button>
        ) : null}
        {room ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('Group settings')}
            title={t('Group settings')}
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 className="size-3.5" />
          </Button>
        ) : null}
      </header>
      {room && settingsOpen ? (
        <RoomSettingsDialog room={room} members={members} onClose={() => setSettingsOpen(false)} />
      ) : null}
      {tasks.length ? (
        <button
          type="button"
          onClick={onWorkspace}
          className="flex items-center gap-2 border-b bg-brand/5 px-6 py-2.5 text-left text-xs"
        >
          <BriefcaseBusiness className="size-3.5 shrink-0 text-brand" />
          <span className="truncate">{tasks[0].title}</span>
          <span className="ml-auto shrink-0">
            <TaskStatus status={tasks[0].status} />
          </span>
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      ) : null}
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-6"
        onScroll={(event) => {
          const node = event.currentTarget;
          atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
      >
        {messages.length || live.length ? (
          <ul data-slot="ensobot-transcript" className="mx-auto flex max-w-3xl flex-col gap-6">
            {messages.map((message) => {
              if (message.authorKind === 'system') {
                return (
                  <li
                    key={message.deliveryId}
                    data-slot="ensobot-system-line"
                    className="flex max-w-[80%] flex-col items-center self-center text-center"
                  >
                    <p className="rounded-full bg-muted/50 px-3 py-1 text-[11px] leading-5 text-muted-foreground">
                      {message.text}
                    </p>
                    {message.work?.length ? <WorkLog steps={message.work} /> : null}
                  </li>
                );
              }
              const author =
                message.authorKind === 'bot'
                  ? snapshot.cards.find(
                      (item) => item.id === ('authorId' in message ? message.authorId : card?.id)
                    )
                  : undefined;
              return (
                <Message
                  key={message.deliveryId}
                  text={message.text}
                  mine={message.authorKind === 'human'}
                  author={author}
                  members={members}
                  work={message.work}
                  label={message.authorKind === 'human' ? t('You') : (author?.name ?? t('Bot'))}
                />
              );
            })}
            {live.map((activity) => {
              const member = snapshot.cards.find((item) => item.id === activity.cardId);
              return (
                <LiveRow
                  key={`live:${activity.cardId}`}
                  card={member}
                  activity={activity}
                  status={statusOf(activity.cardId)}
                >
                  {(snapshot.interactions ?? [])
                    .filter((item) => item.cardId === activity.cardId && inline.has(item.id))
                    .map((item) => (
                      <div key={item.id} className="mt-2">
                        <EnsobotInteractionItem
                          item={item}
                          name={member?.name ?? item.cardId}
                          inline
                        />
                      </div>
                    ))}
                </LiveRow>
              );
            })}
          </ul>
        ) : (
          <div className="flex h-full flex-col items-center justify-center py-8 text-center">
            {card ? (
              <CirclePhoto
                src={card.previewUrl}
                crop={card.crop}
                width={card.width}
                height={card.height}
                size={76}
                alt={card.name}
              />
            ) : (
              <MessagesSquare className="mb-2 size-10 text-muted-foreground" strokeWidth={1.2} />
            )}
            <h2 className="mt-5 text-lg font-medium">
              {card ? t('Say hello to {{name}}', { name: card.name }) : room?.name}
            </h2>
            <p className="mt-2 max-w-sm text-xs leading-6 text-muted-foreground">
              {t(
                card?.bare
                  ? 'Complete this character card before starting a conversation.'
                  : room
                    ? 'Messages without @ go to the host, who splits the work and sums up.'
                    : 'Private chats and groups, without stopping background work.'
              )}
            </p>
            {card?.bare && local ? (
              <Button
                className="mt-4"
                variant="outline"
                onClick={() => onEdit(card.id)}
                disabled={!canEdit}
              >
                {t('Complete this character card')}
              </Button>
            ) : null}
          </div>
        )}
      </div>
      <form
        className="shrink-0 px-6 pb-5 pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="mx-auto max-w-3xl">
          {room ? (
            <div className="mb-2 space-y-1.5">
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                <AtSign className="mr-1 size-3.5" />
                {members.map((member) => (
                  <button
                    key={member.id}
                    type="button"
                    data-slot="ensobot-mention-chip"
                    className="flex items-center gap-1 rounded-full border px-2 py-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={() =>
                      setText(
                        (current) =>
                          `${current}${current && !current.endsWith(' ') ? ' ' : ''}@${member.name} `
                      )
                    }
                  >
                    {member.id === hostId ? <Crown className="size-3 text-warning" /> : null}
                    {member.name}
                  </button>
                ))}
              </div>
              {hostName ? (
                <p data-slot="ensobot-host-hint" className="text-[10px] text-muted-foreground">
                  {t(
                    'Messages without @ go to the host {{name}}. Use @name to reach someone directly.',
                    { name: hostName }
                  )}
                </p>
              ) : null}
            </div>
          ) : null}
          <div
            data-slot="composer"
            className="rounded-2xl border bg-background shadow-xs focus-within:border-ring/60"
          >
            <textarea
              data-slot="ensobot-composer"
              aria-label={t('Type a message')}
              className="block max-h-40 min-h-[76px] w-full resize-none bg-transparent px-4 py-3 text-sm leading-6 outline-none"
              rows={2}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={t('Type a message')}
              disabled={!!card?.bare}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229
                ) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="flex items-center gap-2 px-3 pb-3">
              <span className="text-[10px] text-muted-foreground">
                {t('Enter to send · Shift + Enter for a new line')}
              </span>
              <Button
                type="submit"
                className="ml-auto rounded-xl"
                size="icon"
                aria-label={t('Send')}
                disabled={sending || !text.trim() || !!card?.bare}
              >
                <Send className="size-4" />
              </Button>
            </div>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="size-3" />
              {t('Background tasks continue while you chat.')}
            </span>
            {card && canRetarget ? (
              <label
                data-slot="ensobot-retarget"
                className="flex items-center gap-1.5"
                title={t(
                  'Off: your message is added to what they are doing. On: they drop it and do this instead.'
                )}
              >
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={retarget}
                  onChange={(event) => setRetarget(event.target.checked)}
                />
                {t('Replace what they are doing')}
              </label>
            ) : null}
          </div>
          {note ? (
            <p role="status" className="mt-2 text-xs text-warning">
              {note}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}

function Message({
  mine,
  text,
  label,
  author,
  members,
  work,
}: {
  mine: boolean;
  text: string;
  label: string;
  author?: EnsobotCardFace;
  members: readonly EnsobotCardFace[];
  work?: EnsobotWorkStep[];
}) {
  return (
    <li
      data-slot="ensobot-message"
      data-author={mine ? 'human' : (author?.id ?? 'bot')}
      className={cn('flex max-w-[88%] items-start gap-2.5', mine ? 'self-end' : 'self-start')}
    >
      {!mine ? (
        author ? (
          <CirclePhoto
            src={author.previewUrl}
            crop={author.crop}
            width={author.width}
            height={author.height}
            size={28}
            alt={author.name}
          />
        ) : (
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
            <Bot className="size-4" />
          </span>
        )
      ) : null}
      <div className="min-w-0">
        <p className={cn('mb-1.5 text-[10px] text-muted-foreground', mine && 'text-right')}>
          {label}
        </p>
        {mine ? (
          <p className="whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm bg-brand/10 px-4 py-2.5 text-sm leading-7">
            <MentionText text={text} members={members} />
          </p>
        ) : (
          <div className="min-w-0 rounded-2xl rounded-tl-sm bg-muted/55 px-4 py-2.5 text-sm leading-7">
            <EnsobotMarkdown text={text} members={members} />
          </div>
        )}
        {!mine && work?.length ? <WorkLog steps={work} /> : null}
      </div>
    </li>
  );
}

export function Board({ snapshot }: { snapshot: EnsobotSnapshot }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <section data-slot="ensobot-board" className="flex min-h-0 flex-1 flex-col">
      <SurfaceHeader
        eyebrow="COMMON ROOM"
        title={t('Message board')}
        description={t('Shared context for the whole team. Mention a bot to invite a response.')}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {snapshot.board.length ? (
            snapshot.board.map((note) => {
              const author = snapshot.cards.find((card) => card.id === note.authorId);
              return (
                <article key={note.seq} className="rounded-xl border p-5">
                  <div className="flex items-center gap-3">
                    {author ? (
                      <CirclePhoto
                        src={author.previewUrl}
                        crop={author.crop}
                        width={author.width}
                        height={author.height}
                        size={30}
                        alt={author.name}
                      />
                    ) : (
                      <span className="flex size-8 items-center justify-center rounded-full bg-muted">
                        <MessageCircle className="size-4 text-muted-foreground" />
                      </span>
                    )}
                    <span className="text-xs font-medium">
                      {note.authorKind === 'human'
                        ? t('You')
                        : note.authorKind === 'system'
                          ? t('System')
                          : (author?.name ?? t('Bot'))}
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                      #{note.seq}
                    </span>
                  </div>
                  {note.authorKind === 'bot' ? (
                    <div className="mt-4 text-sm leading-7">
                      <EnsobotMarkdown text={note.text} members={snapshot.cards} />
                    </div>
                  ) : (
                    <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-7">
                      {note.text}
                    </p>
                  )}
                  {note.work?.length ? <WorkLog steps={note.work} /> : null}
                  {note.mentions.length ? (
                    <p className="mt-3 text-xs text-brand">
                      {note.mentions
                        .map(
                          (id) =>
                            `@${snapshot.cards.find((card) => card.id === id)?.name ?? id.slice(0, 8)}`
                        )
                        .join(' ')}
                    </p>
                  ) : null}
                </article>
              );
            })
          ) : (
            <EmptyState
              icon={LayoutGrid}
              title={t('A place to think together.')}
              description={t('The board is empty. A note only wakes the people you name.')}
            />
          )}
        </div>
      </div>
      <form
        className="shrink-0 border-t px-6 py-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || !text.trim()) return;
          const body = text;
          const deliveryId = crypto.randomUUID();
          const input = { text: body, mentions, deliveryId };
          setBusy(true);
          setError('');
          const result = await runCommand(
            { type: 'ensobot-board', ...input },
            () => window.electronAPI.ensobot.postBoard(input),
            deliveryId
          );
          setBusy(false);
          if (!result.ok) setError(result.error ?? t('Failed'));
          else {
            setText((current) => (current === body ? '' : current));
            setMentions([]);
          }
        }}
      >
        <div className="mx-auto max-w-3xl">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <AtSign className="size-3.5" />
            <span>{t('Notify')}</span>
            {snapshot.cards.map((card) => (
              <button
                key={card.id}
                type="button"
                aria-pressed={mentions.includes(card.id)}
                className={cn(
                  'rounded-full border px-2.5 py-1 focus-visible:outline-2 focus-visible:outline-ring',
                  mentions.includes(card.id)
                    ? 'border-brand/30 bg-brand/10 text-brand'
                    : 'hover:bg-muted'
                )}
                onClick={() =>
                  setMentions((current) =>
                    current.includes(card.id)
                      ? current.filter((id) => id !== card.id)
                      : [...current, card.id]
                  )
                }
              >
                {card.name}
              </button>
            ))}
          </div>
          <div
            data-slot="composer"
            className="flex items-end gap-3 rounded-xl border bg-background p-3"
          >
            <textarea
              aria-label={t('Write on the board')}
              className="min-w-0 flex-1 resize-none bg-transparent text-sm leading-6 outline-none"
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={2}
              placeholder={t('Share a decision, a question, or a useful finding…')}
            />
            <Button type="submit" disabled={busy || !text.trim()}>
              <Send className="size-3.5" />
              {t('Post')}
            </Button>
          </div>
          {error ? (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}

export function GroupDialog({
  cards,
  onClose,
  onCreated,
}: {
  cards: EnsobotCardFace[];
  onClose: () => void;
  onCreated: (roomId: string) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [host, setHost] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 没手动挑就按宿主的默认规则预选：第一个协调者，否则第一个选中的人。
  const hostId =
    host && members.includes(host)
      ? host
      : (members.find((id) => cards.some((card) => card.id === id && card.coordinator)) ??
        members[0]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('New group chat')}</DialogTitle>
          <DialogDescription>
            {t('Select at least two people. The host takes messages that mention no one.')}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="flex flex-col gap-2 text-xs font-medium">
            {t('Group name')}
            <input
              className="ensobot-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {cards.map((card) => (
              <label
                key={card.id}
                className="flex cursor-pointer items-center gap-3 rounded-lg p-2 hover:bg-muted"
              >
                <CirclePhoto
                  src={card.previewUrl}
                  crop={card.crop}
                  width={card.width}
                  height={card.height}
                  size={34}
                  alt={card.name}
                />
                <span className="flex-1 text-sm">{card.name}</span>
                <input
                  className="accent-primary"
                  type="checkbox"
                  aria-label={card.name}
                  checked={members.includes(card.id)}
                  onChange={(event) =>
                    setMembers((current) =>
                      event.target.checked
                        ? [...current, card.id]
                        : current.filter((id) => id !== card.id)
                    )
                  }
                />
              </label>
            ))}
          </div>
          {members.length >= 2 && hostId ? (
            <BotSelect
              label={t('Group host')}
              value={hostId}
              items={members.map((id) => ({
                value: id,
                label: cards.find((card) => card.id === id)?.name ?? id.slice(0, 8),
              }))}
              onChange={setHost}
            />
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            disabled={busy || !name.trim() || members.length < 2}
            onClick={async () => {
              setBusy(true);
              setError('');
              const input = {
                name: name.trim(),
                memberIds: members,
                ...(hostId ? { hostId } : {}),
              };
              const result = await runCommand({ type: 'ensobot-room-create', ...input }, () =>
                window.electronAPI.ensobot.createRoom(input)
              );
              setBusy(false);
              if (!result.ok || !result.roomId) setError(result.error ?? t('Failed'));
              else onCreated(result.roomId);
            }}
          >
            {t('Create group')}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** 建群后改主持人和接力上限。上限留空就回到默认值。 */
function RoomSettingsDialog({
  room,
  members,
  onClose,
}: {
  room: EnsobotRoom;
  members: EnsobotCardFace[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [hostId, setHostId] = useState(room.hostId ?? members[0]?.id ?? '');
  const [limit, setLimit] = useState(room.relayLimit ? String(room.relayLimit) : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const trimmed = limit.trim();
  const parsed = trimmed ? Number(trimmed) : null;
  const limitValid =
    parsed === null || (Number.isInteger(parsed) && parsed >= 1 && parsed <= RELAY_LIMIT_MAX);
  const save = async () => {
    if (busy || !limitValid) return;
    setBusy(true);
    setError('');
    const input = { roomId: room.id, hostId: hostId || null, relayLimit: parsed };
    const result = await runCommand({ type: 'ensobot-room-update', ...input }, () =>
      window.electronAPI.ensobot.updateRoom(input)
    );
    setBusy(false);
    if (!result.ok) setError(result.error ?? t('Failed'));
    else onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Group settings')}</DialogTitle>
          <DialogDescription>{room.name}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <BotSelect
            label={t('Group host')}
            value={hostId}
            items={members.map((member) => ({ value: member.id, label: member.name }))}
            onChange={setHostId}
          />
          <p className="-mt-2 text-[11px] leading-5 text-muted-foreground">
            {t('Messages without @ go to the host, who splits the work and sums up.')}
          </p>
          <label className="flex flex-col gap-2 text-xs font-medium">
            {t('Relay limit')}
            <input
              className="ensobot-input"
              inputMode="numeric"
              aria-label={t('Relay limit')}
              aria-invalid={!limitValid}
              placeholder={t('Default {{count}}', { count: RELAY_LIMIT })}
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
            />
          </label>
          <p className="-mt-2 text-[11px] leading-5 text-muted-foreground">
            {t(
              'How many times bots may wake each other in one discussion before it stops. 1 to {{max}}; leave empty for the default.',
              { max: RELAY_LIMIT_MAX }
            )}
          </p>
          {!limitValid ? (
            <p role="alert" className="text-xs text-destructive">
              {t('Enter a whole number from 1 to {{max}}.', { max: RELAY_LIMIT_MAX })}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button disabled={busy || !limitValid} onClick={() => void save()}>
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
