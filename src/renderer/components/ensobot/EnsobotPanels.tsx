import type { PhoneToHost } from '@enso/pair';
import type { CharacterCardData, CharacterRole, CircleCrop } from '@shared/characterCard';
import { EMPTY_PERSONA, EMPTY_ROLE } from '@shared/characterCard';
import { resolveEnsobotModel } from '@shared/defaultModel';
import type { EnsobotActionResult, EnsobotSnapshot } from '@shared/ensobot/snapshot';
import { applyEnsobotSnapshot } from '@shared/ensobot/snapshot';
import { Plus, Send, UserRound } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useOauthCredentialStore } from '@/stores/oauthCredentials';
import { useRemoteNodesStore } from '@/stores/remoteNodes';
import { useSettingsStore } from '@/stores/settings';

type Selection = { kind: 'dm'; cardId: string } | { kind: 'room'; roomId: string };

type CardDetails = Awaited<ReturnType<typeof window.electronAPI.ensobot.listCards>>;

const NO_CARDS: EnsobotSnapshot['cards'] = [];
const NO_GROUPS: NonNullable<EnsobotSnapshot['groups']> = [];

const APPROVAL: readonly { id: CharacterRole['approvalScope']; label: string }[] = [
  { id: 'supervised', label: 'Supervised' },
  { id: 'auto-edits', label: 'Auto-accept edits' },
  { id: 'full', label: 'Full access' },
  { id: 'assistant', label: 'Assistant' },
];

export function useEnsobotSnapshot(): EnsobotSnapshot | null {
  const [snapshot, setSnapshot] = useState<EnsobotSnapshot | null>(null);
  const currentRef = useRef<EnsobotSnapshot | null>(null);
  useEffect(() => {
    const apply = (next: EnsobotSnapshot) => {
      currentRef.current = applyEnsobotSnapshot(currentRef.current, next);
      setSnapshot(currentRef.current);
    };
    const applyLocal = (next: EnsobotSnapshot) => {
      if (useRemoteNodesStore.getState().activeNodeId !== 'local') return;
      apply(next);
    };
    const offLocal = window.electronAPI.ensobot.onChanged(applyLocal);
    void window.electronAPI.ensobot.getState().then(applyLocal);
    const offRemote = window.electronAPI.nodes.onMessage((message) => {
      const active = useRemoteNodesStore.getState().activeNodeId;
      if (active === 'local' || message.nodeId !== active) return;
      const payload = message.payload;
      if (!payload || typeof payload !== 'object') return;
      const frame = payload as { type?: string; snapshot?: EnsobotSnapshot };
      if (frame.type !== 'ensobot-snapshot' || !frame.snapshot) return;
      apply(frame.snapshot);
    });
    return () => {
      offLocal();
      offRemote();
    };
  }, []);
  return snapshot;
}

async function runCommand(
  command: PhoneToHost,
  local: () => Promise<EnsobotActionResult>,
  deliveryId?: string
): Promise<EnsobotActionResult> {
  const nodeId = useRemoteNodesStore.getState().activeNodeId;
  if (nodeId === 'local') return local();
  const transport = await window.electronAPI.nodes.send(nodeId, command);
  if (!transport.ok) return transport;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      off();
      resolve({ ok: false, error: 'timeout' });
    }, 10_000);
    const off = window.electronAPI.nodes.onMessage((message) => {
      const payload = message.payload;
      if (!payload || typeof payload !== 'object') return;
      const frame = payload as {
        type?: string;
        ok?: boolean;
        error?: string;
        disposition?: string;
        deliveryId?: string;
        roomId?: string;
      };
      if (frame.type !== 'ensobot-result') return;
      if (deliveryId && frame.deliveryId && frame.deliveryId !== deliveryId) return;
      window.clearTimeout(timer);
      off();
      resolve({
        ok: frame.ok === true,
        ...(frame.error ? { error: frame.error } : {}),
        ...(frame.disposition ? { disposition: frame.disposition } : {}),
        ...(frame.roomId ? { roomId: frame.roomId } : {}),
      });
    });
  });
}

export function EnsobotDesk() {
  const { t } = useI18n();
  const snapshot = useEnsobotSnapshot();
  const local = useRemoteNodesStore((state) => state.activeNodeId) === 'local';
  const cards = snapshot?.cards ?? NO_CARDS;
  const groups = snapshot?.groups ?? NO_GROUPS;
  const [selection, setSelection] = useState<Selection | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [text, setText] = useState('');
  const [retarget, setRetarget] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [listed, setListed] = useState<CardDetails | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const reloadCards = () => {
    if (!local) return;
    void window.electronAPI.ensobot.listCards().then(setListed);
  };

  useEffect(() => {
    if (!local || !snapshot) return;
    void window.electronAPI.ensobot.listCards().then(setListed);
  }, [local, snapshot]);

  useEffect(() => {
    if (!snapshot) return;
    setSelection((current) => {
      if (current?.kind === 'dm' && snapshot.cards.some((card) => card.id === current.cardId)) {
        return current;
      }
      if (
        current?.kind === 'room' &&
        (snapshot.groups ?? NO_GROUPS).some((room) => room.id === current.roomId)
      ) {
        return current;
      }
      if (current?.kind === 'room') return current;
      const first = snapshot.cards[0];
      if (first) return { kind: 'dm', cardId: first.id };
      const room = snapshot.groups?.[0];
      if (room) return { kind: 'room', roomId: room.id };
      return null;
    });
  }, [snapshot]);

  const activeCard =
    selection?.kind === 'dm' ? cards.find((card) => card.id === selection.cardId) : undefined;
  const activeRoom =
    selection?.kind === 'room' ? groups.find((room) => room.id === selection.roomId) : undefined;
  const messages = useMemo(() => {
    if (selection?.kind === 'dm') {
      return (snapshot?.bubbles ?? [])
        .filter((bubble) => bubble.cardId === selection.cardId)
        .slice()
        .sort((a, b) => a.seq - b.seq);
    }
    if (selection?.kind === 'room') {
      return (snapshot?.roomMessages ?? [])
        .filter((message) => message.roomId === selection.roomId)
        .slice()
        .sort((a, b) => a.seq - b.seq);
    }
    return [];
  }, [selection, snapshot?.bubbles, snapshot?.roomMessages]);

  useEffect(() => {
    if (messages.length < 0 || selection === null) return;
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, selection]);

  const send = () => {
    if (!selection || text.trim().length === 0 || sending) return;
    const body = text;
    const deliveryId = crypto.randomUUID();
    setSending(true);
    setError('');
    setNote('');
    const job =
      selection.kind === 'dm'
        ? runCommand(
            {
              type: 'ensobot-send',
              cardId: selection.cardId,
              text: body,
              deliveryId,
              ...(retarget ? { retarget: true } : {}),
            },
            () =>
              window.electronAPI.ensobot.send({
                cardId: selection.cardId,
                text: body,
                deliveryId,
                retarget,
              }),
            deliveryId
          )
        : runCommand(
            { type: 'ensobot-room-send', roomId: selection.roomId, text: body, deliveryId },
            () =>
              window.electronAPI.ensobot.sendRoom({
                roomId: selection.roomId,
                text: body,
                deliveryId,
              }),
            deliveryId
          );
    void job.then((result) => {
      setSending(false);
      if (!result.ok) {
        setError(result.error ?? 'failed');
        return;
      }
      setText('');
      setRetarget(false);
      if (result.disposition === 'partial') {
        setNote(t('The message is in the room, but someone could not be woken.'));
      }
    });
  };

  return (
    <div className="flex min-h-0 flex-1">
      <aside
        aria-label={t('Bot chats')}
        data-slot="ensobot-conversations"
        className="flex w-[280px] shrink-0 flex-col border-r bg-background/80"
      >
        <div className="flex items-center justify-between gap-2 px-3 py-3">
          <h1 className="text-sm font-medium">{t('Bot chats')}</h1>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            onClick={() => setGroupOpen(true)}
            disabled={cards.length < 2}
            title={cards.length < 2 ? t('Select at least two people.') : t('New group chat')}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('New group chat')}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {cards.length > 0 ? (
            <Section label={t('Direct messages')}>
              {cards.map((card) => (
                <ConversationRow
                  key={card.id}
                  name={card.name}
                  preview={lastPreview(
                    (snapshot?.bubbles ?? []).filter((bubble) => bubble.cardId === card.id)
                  )}
                  selected={selection?.kind === 'dm' && selection.cardId === card.id}
                  onClick={() => {
                    setSelection({ kind: 'dm', cardId: card.id });
                    setError('');
                    setNote('');
                  }}
                >
                  <CirclePhoto
                    src={card.previewUrl}
                    crop={card.crop}
                    width={card.width}
                    height={card.height}
                    size={36}
                    alt={card.name}
                  />
                </ConversationRow>
              ))}
            </Section>
          ) : null}
          {groups.length > 0 ? (
            <Section label={t('Groups')}>
              {groups.map((room) => (
                <ConversationRow
                  key={room.id}
                  name={room.name}
                  preview={lastPreview(
                    (snapshot?.roomMessages ?? []).filter((message) => message.roomId === room.id)
                  )}
                  selected={selection?.kind === 'room' && selection.roomId === room.id}
                  onClick={() => {
                    setSelection({ kind: 'room', roomId: room.id });
                    setProfileOpen(false);
                    setError('');
                    setNote('');
                  }}
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-xs font-medium">
                    {room.memberIds.length}
                  </span>
                </ConversationRow>
              ))}
            </Section>
          ) : null}
          {cards.length === 0 && groups.length === 0 ? (
            <p className="px-2 py-6 text-sm leading-6 text-muted-foreground">
              {t('No bots yet. Import a picture to add one.')}
            </p>
          ) : null}
        </div>
        {local ? (
          <div className="border-t p-2">
            <button
              type="button"
              className="w-full rounded-lg px-2 py-2 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => {
                void window.electronAPI.ensobot.importCard().then((result) => {
                  if (!result.ok || !result.cardId) setError(result.error ?? 'failed');
                  else {
                    setSelection({ kind: 'dm', cardId: result.cardId });
                    setProfileOpen(true);
                    reloadCards();
                  }
                });
              }}
            >
              {t('Import picture')}
            </button>
          </div>
        ) : null}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col bg-background/55">
        {selection && (activeCard || activeRoom) ? (
          <>
            <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
              {activeCard ? (
                <CirclePhoto
                  src={activeCard.previewUrl}
                  crop={activeCard.crop}
                  width={activeCard.width}
                  height={activeCard.height}
                  size={32}
                  alt={activeCard.name}
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {activeCard?.name ?? activeRoom?.name}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {activeRoom ? memberNames(activeRoom.memberIds, cards) : t('Private chat')}
                </p>
              </div>
              {local && activeCard ? (
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-pressed={profileOpen}
                  onClick={() => setProfileOpen((open) => !open)}
                >
                  <UserRound className="h-3.5 w-3.5" />
                  {t('Profile')}
                </button>
              ) : null}
            </header>
            <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <ul data-slot="ensobot-transcript" className="mx-auto flex max-w-3xl flex-col gap-3">
                {messages.length === 0 ? (
                  <li className="py-8 text-center text-sm text-muted-foreground">
                    {t('No messages yet.')}
                  </li>
                ) : (
                  messages.map((message) => (
                    <Bubble
                      key={message.deliveryId}
                      mine={message.authorKind === 'human' && authorIsHuman(message)}
                      label={bubbleLabel(message, cards, t('You'))}
                      text={message.text}
                    />
                  ))
                )}
              </ul>
            </div>
            <form
              data-slot="ensobot-composer"
              className="shrink-0 border-t px-4 py-3"
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
            >
              <div className="mx-auto flex max-w-3xl flex-col gap-2">
                <div className="flex items-end gap-2 rounded-2xl border bg-background px-3 py-2">
                  <textarea
                    value={text}
                    rows={1}
                    onChange={(event) => setText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    placeholder={
                      activeRoom
                        ? t('Message the group. Use @name so only the people you name speak.')
                        : t('Type a message')
                    }
                    className="max-h-32 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none"
                  />
                  <button
                    type="submit"
                    aria-label={t('Send')}
                    disabled={sending || text.trim().length === 0}
                    className="mb-0.5 inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                </div>
                {activeCard ? (
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={retarget}
                      onChange={(event) => setRetarget(event.target.checked)}
                    />
                    {t('Replace the goal')}
                  </label>
                ) : null}
                {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
                {error ? <p className="text-sm text-destructive">{error}</p> : null}
              </div>
            </form>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center p-8">
            <p className="max-w-sm text-center text-sm leading-6 text-muted-foreground">
              {cards.length === 0
                ? t('No bots yet. Import a picture to add one.')
                : t('Pick a chat on the left, or start a group.')}
            </p>
          </div>
        )}
      </section>

      {profileOpen && local && activeCard ? (
        <ProfilePanel
          cardId={activeCard.id}
          listed={listed}
          onClose={() => setProfileOpen(false)}
          onChanged={reloadCards}
          onRemoved={() => {
            setProfileOpen(false);
            setSelection(null);
          }}
        />
      ) : null}

      <GroupDialog
        open={groupOpen}
        cards={cards}
        onOpenChange={setGroupOpen}
        onCreated={(roomId) => {
          setSelection({ kind: 'room', roomId });
          setProfileOpen(false);
        }}
      />
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-3">
      <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function ConversationRow({
  name,
  preview,
  selected,
  onClick,
  children,
}: {
  name: string;
  preview: string;
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left',
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
      )}
    >
      {children}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{name}</span>
        <span className="block truncate text-xs text-muted-foreground">{preview}</span>
      </span>
    </button>
  );
}

function Bubble({ mine, label, text }: { mine: boolean; label: string; text: string }) {
  return (
    <li
      className={cn('flex max-w-[78%] flex-col gap-1', mine ? 'self-end items-end' : 'self-start')}
    >
      <span className="px-1 text-[11px] text-muted-foreground">{label}</span>
      <p
        className={cn(
          'rounded-2xl px-3 py-2 text-sm leading-6',
          mine
            ? 'rounded-br-md bg-primary text-primary-foreground'
            : 'rounded-bl-md bg-muted text-foreground'
        )}
      >
        {text}
      </p>
    </li>
  );
}

function authorIsHuman(message: { authorKind: 'human' | 'bot'; authorId?: string }): boolean {
  if (message.authorKind !== 'human') return false;
  return !message.authorId || message.authorId === 'human';
}

function bubbleLabel(
  message: { authorKind: 'human' | 'bot'; authorId?: string; cardId?: string },
  cards: { id: string; name: string }[],
  you: string
): string {
  if (authorIsHuman(message)) return you;
  const id = message.authorId && message.authorId !== 'human' ? message.authorId : message.cardId;
  return cards.find((card) => card.id === id)?.name ?? you;
}

function lastPreview(messages: { text: string; seq: number }[]): string {
  const latest = messages
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .at(-1);
  if (!latest) return '';
  return latest.text.replace(/\s+/g, ' ').slice(0, 48);
}

function memberNames(ids: string[], cards: { id: string; name: string }[]): string {
  return ids.map((id) => cards.find((card) => card.id === id)?.name ?? id.slice(0, 8)).join('、');
}

function CirclePhoto({
  src,
  crop,
  width,
  height,
  size,
  alt,
}: {
  src: string;
  crop: CircleCrop | null;
  width: number;
  height: number;
  size: number;
  alt: string;
}) {
  const fitted =
    crop && crop.r > 0 && width > 0 && height > 0
      ? {
          width: (width * size) / (crop.r * 2),
          height: (height * size) / (crop.r * 2),
          marginLeft: -((crop.cx - crop.r) * size) / (crop.r * 2),
          marginTop: -((crop.cy - crop.r) * size) / (crop.r * 2),
          maxWidth: 'none' as const,
        }
      : null;
  return (
    <span
      data-slot="ensobot-avatar"
      className="inline-block shrink-0 overflow-hidden rounded-full bg-muted"
      style={{ width: size, height: size }}
    >
      {src ? (
        <img
          alt={alt}
          src={src}
          className={fitted ? 'block' : 'h-full w-full object-cover'}
          style={fitted ?? undefined}
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-xs">
          {alt.slice(0, 1)}
        </span>
      )}
    </span>
  );
}

function GroupDialog({
  open,
  cards,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  cards: { id: string; name: string }[];
  onOpenChange: (open: boolean) => void;
  onCreated: (roomId: string) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) {
      setName('');
      setMembers([]);
      setError('');
    }
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('New group chat')}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('Group name')}
            className="rounded-md border bg-background px-2 py-1.5 text-sm"
          />
          <p className="text-xs text-muted-foreground">{t('Select at least two people.')}</p>
          <div className="flex flex-col gap-1">
            {cards.map((card) => (
              <label key={card.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={members.includes(card.id)}
                  onChange={(event) => {
                    setMembers((current) =>
                      event.target.checked
                        ? [...current, card.id]
                        : current.filter((id) => id !== card.id)
                    );
                  }}
                />
                {card.name}
              </label>
            ))}
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
            disabled={name.trim().length === 0 || members.length < 2}
            onClick={() => {
              const roomName = name.trim();
              const memberIds = members;
              void runCommand({ type: 'ensobot-room-create', name: roomName, memberIds }, () =>
                window.electronAPI.ensobot.createRoom({ name: roomName, memberIds })
              ).then((result) => {
                if (!result.ok || !result.roomId) {
                  setError(result.error ?? 'failed');
                  return;
                }
                onCreated(result.roomId);
                onOpenChange(false);
              });
            }}
          >
            {t('Create group')}
          </button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ProfilePanel({
  cardId,
  listed,
  onClose,
  onChanged,
  onRemoved,
}: {
  cardId: string;
  listed: CardDetails | null;
  onClose: () => void;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const { t } = useI18n();
  const providers = useSettingsStore((state) => state.providers);
  const defaultModel = useSettingsStore((state) => state.defaultModel);
  const oauth = useOauthCredentialStore((state) => state.snapshot.availability);
  const [error, setError] = useState('');
  const summary = listed?.cards.find((card) => card.id === cardId) ?? null;
  const draft = useMemo(() => summary?.card ?? blank(cardId), [summary, cardId]);
  const [persona, setPersona] = useState(draft.persona);
  const [role, setRole] = useState(draft.role);
  const [crop, setCrop] = useState(draft.crop);
  useEffect(() => {
    setPersona(draft.persona);
    setRole(draft.role);
    setCrop(draft.crop);
  }, [draft]);
  const decision = resolveEnsobotModel({
    cardModel:
      role.providerId && role.modelId
        ? { providerId: role.providerId, modelId: role.modelId }
        : null,
    defaultModel,
    providers,
    credentials: { oauthCredentials: oauth },
  });
  const provider = providers.find((item) => item.id === role.providerId);
  const width = summary?.width ?? 0;
  const height = summary?.height ?? 0;
  return (
    <aside
      data-slot="ensobot-profile"
      className="flex w-[340px] shrink-0 flex-col border-l bg-background/90"
    >
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-medium">{t('Profile')}</h2>
        <button type="button" className="text-xs text-muted-foreground" onClick={onClose}>
          {t('Close profile')}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-md border px-2 py-1 text-xs"
            onClick={() => {
              void window.electronAPI.ensobot.importCard().then((result) => {
                if (!result.ok) setError(result.error ?? 'failed');
                else onChanged();
              });
            }}
          >
            {t('Import picture')}
          </button>
          {summary ? (
            <>
              <button
                type="button"
                className="rounded-md border px-2 py-1 text-xs"
                onClick={() => {
                  void window.electronAPI.ensobot.exportCard(summary.id).then((result) => {
                    if (!result.ok) setError(result.error ?? 'failed');
                  });
                }}
              >
                {t('Export PNG')}
              </button>
              <button
                type="button"
                className="rounded-md border px-2 py-1 text-xs"
                onClick={() => {
                  void window.electronAPI.ensobot.deleteCard(summary.id).then((result) => {
                    if (!result.ok) setError(result.error ?? 'failed');
                    else onRemoved();
                  });
                }}
              >
                {t('Delete card')}
              </button>
            </>
          ) : null}
        </div>
        {summary ? (
          <div className="mb-4 flex flex-col items-center gap-3">
            <CirclePhoto
              src={summary.previewUrl}
              crop={crop}
              width={width}
              height={height}
              size={96}
              alt={persona.name || t('Character')}
            />
            <button
              type="button"
              className="relative w-full overflow-hidden rounded-lg border bg-muted/40"
              style={{ aspectRatio: `${Math.max(width, 1)} / ${Math.max(height, 1)}` }}
              onClick={(event) => {
                if (!width || !height) return;
                const rect = event.currentTarget.getBoundingClientRect();
                const cx = ((event.clientX - rect.left) / rect.width) * width;
                const cy = ((event.clientY - rect.top) / rect.height) * height;
                setCrop(placeCrop(crop, width, height, { cx, cy }));
              }}
            >
              <img alt="" src={summary.previewUrl} className="absolute inset-0 h-full w-full" />
              {crop && width > 0 && height > 0 ? (
                <span
                  className="pointer-events-none absolute rounded-full border-2 border-primary"
                  style={{
                    left: `${((crop.cx - crop.r) / width) * 100}%`,
                    top: `${((crop.cy - crop.r) / height) * 100}%`,
                    width: `${((crop.r * 2) / width) * 100}%`,
                    height: `${((crop.r * 2) / height) * 100}%`,
                  }}
                />
              ) : null}
            </button>
            <label className="flex w-full items-center gap-2 text-xs text-muted-foreground">
              {t('Radius')}
              <input
                type="range"
                min={1}
                max={Math.max(1, Math.min(width, height) / 2)}
                value={crop?.r ?? Math.min(width, height) / 4}
                onChange={(event) =>
                  setCrop(placeCrop(crop, width, height, { r: Number(event.target.value) }))
                }
                className="flex-1"
              />
            </label>
            <p className="text-xs text-muted-foreground">
              {t('Circle crop uses source pixels. The file keeps the whole picture.')}
            </p>
          </div>
        ) : null}
        <section data-slot="ensobot-persona" className="mb-4 flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t('Persona')}</h3>
          <input
            value={persona.name}
            onChange={(event) => setPersona({ ...persona, name: event.target.value })}
            placeholder={t('Name')}
            className="rounded-md border bg-background px-2 py-1 text-sm"
          />
          <textarea
            value={persona.personality}
            onChange={(event) => setPersona({ ...persona, personality: event.target.value })}
            placeholder={t('Personality')}
            rows={3}
            className="rounded-md border bg-background px-2 py-1 text-sm"
          />
          <textarea
            value={persona.setting}
            onChange={(event) => setPersona({ ...persona, setting: event.target.value })}
            placeholder={t('Character setting')}
            rows={3}
            className="rounded-md border bg-background px-2 py-1 text-sm"
          />
        </section>
        <section data-slot="ensobot-role" className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t('Duties')}</h3>
          <textarea
            value={role.duty}
            onChange={(event) => setRole({ ...role, duty: event.target.value })}
            placeholder={t('Duty')}
            rows={3}
            className="rounded-md border bg-background px-2 py-1 text-sm"
          />
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('Permissions')}
            <select
              className="rounded-md border bg-background px-2 py-1 text-sm text-foreground"
              value={role.approvalScope}
              onChange={(event) =>
                setRole({
                  ...role,
                  approvalScope: event.target.value as CharacterRole['approvalScope'],
                })
              }
            >
              {APPROVAL.map((item) => (
                <option key={item.id} value={item.id}>
                  {t(item.label)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={role.coordinator}
              onChange={(event) => setRole({ ...role, coordinator: event.target.checked })}
            />
            {t('Coordinator: assign work, do not edit the shared workspace')}
          </label>
          <div className="flex flex-wrap gap-2">
            <select
              aria-label={t('Provider')}
              className="rounded-md border bg-background px-2 py-1 text-sm"
              value={role.providerId}
              onChange={(event) =>
                setRole({ ...role, providerId: event.target.value, modelId: '' })
              }
            >
              <option value="">{t('Provider')}</option>
              {providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name || item.id}
                </option>
              ))}
            </select>
            <select
              aria-label={t('Model')}
              className="rounded-md border bg-background px-2 py-1 text-sm"
              value={role.modelId}
              onChange={(event) => setRole({ ...role, modelId: event.target.value })}
            >
              <option value="">{t('Model')}</option>
              {(provider?.models ?? []).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label || model.id}
                </option>
              ))}
            </select>
            <input
              type="number"
              min={1}
              max={32}
              value={role.concurrency}
              onChange={(event) =>
                setRole({ ...role, concurrency: Number(event.target.value) || 1 })
              }
              className="w-20 rounded-md border bg-background px-2 py-1 text-sm"
              aria-label={t('Concurrency')}
            />
          </div>
          <p className="text-xs text-muted-foreground" data-slot="ensobot-model">
            {decision.kind === 'card'
              ? t('Using the card model')
              : decision.kind === 'default'
                ? t('Card model is missing, so this falls back to the default')
                : decision.kind === 'oauth-blocked'
                  ? decision.reason
                  : t('No usable model')}
          </p>
        </section>
        {listed?.errors.length ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {t('Some card files could not be read. The rest of the list is still here.')}
          </p>
        ) : null}
        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
      </div>
      {summary ? (
        <div className="border-t p-3">
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
            onClick={() => {
              const next: CharacterCardData = {
                id: summary.id,
                ...(summary.card?.originId ? { originId: summary.card.originId } : {}),
                persona,
                role: normalizeRole(role),
                crop: width > 0 && height > 0 ? placeCrop(crop, width, height, {}) : crop,
              };
              void window.electronAPI.ensobot.updateCard(summary.id, next).then((result) => {
                if (!result.ok) setError(result.error ?? 'failed');
                else onChanged();
              });
            }}
          >
            {t('Save card')}
          </button>
        </div>
      ) : null}
    </aside>
  );
}

function placeCrop(
  current: CircleCrop | null,
  width: number,
  height: number,
  next: Partial<CircleCrop>
): CircleCrop {
  const limit = Math.max(1, Math.min(width, height) / 2);
  const r = clamp(next.r ?? current?.r ?? Math.min(width, height) / 4, 1, limit);
  const cx = clamp(next.cx ?? current?.cx ?? width / 2, r, Math.max(r, width - r));
  const cy = clamp(next.cy ?? current?.cy ?? height / 2, r, Math.max(r, height - r));
  return { cx, cy, r };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function blank(id: string): CharacterCardData {
  return { id, persona: { ...EMPTY_PERSONA }, role: { ...EMPTY_ROLE }, crop: null };
}

function normalizeRole(role: CharacterRole): CharacterRole {
  const concurrency = Math.max(1, Math.min(32, Math.round(role.concurrency) || 1));
  return { ...role, concurrency };
}
