import type { EnsobotCardFace, EnsobotSnapshot } from '@shared/ensobot/snapshot';
import {
  AtSign,
  Bot,
  BriefcaseBusiness,
  ChevronRight,
  Hash,
  LayoutGrid,
  MessageCircle,
  MessagesSquare,
  Send,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
import { CirclePhoto, EmptyState, SurfaceHeader, TaskStatus } from './EnsobotPrimitives';
import type { ChatSelection } from './ensobotView';
import { runCommand } from './useEnsobot';

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
  const [sending, setSending] = useState(false);
  const [retarget, setRetarget] = useState(false);
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
  const latestSeq = messages.at(-1)?.seq ?? 0;
  const tasks = snapshot.tasks.filter(
    (task) =>
      members.some((member) => member.id === task.cardId) &&
      (task.status === 'doing' || task.status === 'claimed' || task.status === 'waiting-directory')
  );
  useEffect(() => {
    if (latestSeq >= 0 && atBottom.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [latestSeq]);
  const send = async () => {
    if (sending || !text.trim()) return;
    const body = text;
    const deliveryId = crypto.randomUUID();
    setSending(true);
    setError('');
    setNote('');
    const result =
      selection.kind === 'dm'
        ? await runCommand(
            { type: 'ensobot-send', cardId: selection.cardId, text: body, deliveryId, retarget },
            () =>
              window.electronAPI.ensobot.send({
                cardId: selection.cardId,
                text: body,
                deliveryId,
                retarget,
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
          <CirclePhoto
            src={card.previewUrl}
            crop={card.crop}
            width={card.width}
            height={card.height}
            size={38}
            alt={card.name}
          />
        ) : (
          <span className="flex size-10 items-center justify-center rounded-xl bg-muted">
            <Hash className="size-5" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{card?.name ?? room?.name}</h1>
          <p className="mt-1 truncate text-[11px] text-muted-foreground">
            {room ? members.map((member) => member.name).join(' · ') : t('Private chat')}
          </p>
        </div>
        {card && local ? (
          <Button variant="ghost" size="sm" disabled={!canEdit} onClick={() => onEdit(card.id)}>
            <Settings2 className="size-3.5" />
            {t('Character card')}
          </Button>
        ) : null}
      </header>
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
        {messages.length ? (
          <ul data-slot="ensobot-transcript" className="mx-auto flex max-w-3xl flex-col gap-6">
            {messages.map((message) => {
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
                  label={message.authorKind === 'human' ? t('You') : (author?.name ?? t('Bot'))}
                />
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
                    ? 'Message the group. Use @name so only the people you name speak.'
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
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <AtSign className="mr-1 size-3.5" />
              {members.map((member) => (
                <button
                  key={member.id}
                  type="button"
                  className="rounded-full border px-2 py-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() =>
                    setText(
                      (current) =>
                        `${current}${current && !current.endsWith(' ') ? ' ' : ''}@${member.name} `
                    )
                  }
                >
                  {member.name}
                </button>
              ))}
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
            {card ? (
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={retarget}
                  onChange={(event) => setRetarget(event.target.checked)}
                />
                {t('Replace the goal')}
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
}: {
  mine: boolean;
  text: string;
  label: string;
  author?: EnsobotCardFace;
}) {
  return (
    <li className={cn('flex max-w-[88%] items-start gap-2.5', mine ? 'self-end' : 'self-start')}>
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
        <p
          className={cn(
            'whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-7',
            mine ? 'rounded-tr-sm bg-brand/10' : 'rounded-tl-sm bg-muted/55'
          )}
        >
          {text}
        </p>
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
                      {note.authorKind === 'human' ? t('You') : (author?.name ?? t('Bot'))}
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                      #{note.seq}
                    </span>
                  </div>
                  <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-7">
                    {note.text}
                  </p>
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
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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
          <DialogDescription>{t('Select at least two people.')}</DialogDescription>
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
              const input = { name: name.trim(), memberIds: members };
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
