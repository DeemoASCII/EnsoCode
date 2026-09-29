import type { EnsobotCardFace, EnsobotSnapshot } from '@shared/ensobot/snapshot';
import {
  ArrowRight,
  Bot,
  BriefcaseBusiness,
  ChevronRight,
  Hash,
  Import,
  LayoutGrid,
  MessageCircle,
  MessagesSquare,
  Network,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { NodeSwitcher } from '@/components/nodes/NodeSwitcher';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useRemoteNodesStore } from '@/stores/remoteNodes';
import { CharacterCardDialog } from './CharacterCardDialog';
import { Board, ChatPane, GroupDialog } from './EnsobotChat';
import { EnsobotInteractions } from './EnsobotInteractions';
import { CirclePhoto, EmptyState, SurfaceHeader, TaskStatus } from './EnsobotPrimitives';
import { EnsobotWorkspace } from './EnsobotWorkspace';
import { type ChatSelection, lastPreview, reconcileChat } from './ensobotView';
import { type CardDetails, useEnsobotSnapshot } from './useEnsobot';

type Page = 'chats' | 'members' | 'board' | 'workspace';
const NO_CARDS: EnsobotCardFace[] = [];

/** 节点是完整的 UI 身份边界，切换后不能沿用另一节点的人物卡、草稿或序列号。 */
export function EnsobotDesk() {
  const nodeId = useRemoteNodesStore((state) => state.activeNodeId);
  const { snapshot, error } = useEnsobotSnapshot();
  return <Desk key={nodeId} snapshot={snapshot} loadError={error} local={nodeId === 'local'} />;
}

function Desk({
  snapshot,
  loadError,
  local,
}: {
  snapshot: EnsobotSnapshot | null;
  loadError: string;
  local: boolean;
}) {
  const { t } = useI18n();
  const [page, setPage] = useState<Page>('chats');
  const [selection, setSelection] = useState<ChatSelection | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'dm' | 'room'>('all');
  const [groupOpen, setGroupOpen] = useState(false);
  const [editing, setEditing] = useState<CardDetails['cards'][number] | null>(null);
  const [listed, setListed] = useState<CardDetails | null>(null);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const cards = snapshot?.cards ?? NO_CARDS;
  const cardsKey = JSON.stringify(cards);
  const reloadCards = () => {
    if (local)
      void window.electronAPI.ensobot
        .listCards()
        .then(setListed)
        .catch((reason: unknown) => setError(String(reason)));
  };
  useEffect(() => {
    if (!local || !cardsKey) return;
    let disposed = false;
    void window.electronAPI.ensobot
      .listCards()
      .then((value) => {
        if (!disposed) setListed(value);
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(String(reason));
      });
    return () => {
      disposed = true;
    };
  }, [local, cardsKey]);
  useEffect(() => {
    if (snapshot) setSelection((current) => reconcileChat(current, snapshot));
  }, [snapshot]);
  const importCard = async () => {
    setImporting(true);
    setError('');
    try {
      const result = await window.electronAPI.ensobot.importCard();
      if (!result.ok || !result.cardId) {
        if (result.error !== 'cancelled') setError(result.error ?? t('Failed'));
        return;
      }
      const details = await window.electronAPI.ensobot.listCards();
      setListed(details);
      setSelection({ kind: 'dm', cardId: result.cardId });
      setEditing(details.cards.find((card) => card.id === result.cardId) ?? null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setImporting(false);
    }
  };
  const editCard = (id: string) => {
    const card = listed?.cards.find((item) => item.id === id);
    if (card) setEditing(card);
  };
  const choose = (next: ChatSelection) => {
    setSelection(next);
    setPage('chats');
    setError('');
  };
  const visibleCards = cards.filter((card) =>
    card.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  );
  const groups = (snapshot?.groups ?? []).filter((room) =>
    room.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  );
  const busyCount =
    snapshot?.tasks.filter((task) => task.status === 'doing' || task.status === 'claimed').length ??
    0;
  const chatKey =
    selection?.kind === 'dm'
      ? `dm:${selection.cardId}`
      : selection
        ? `room:${selection.roomId}`
        : '';
  return (
    <div data-slot="ensobot-desk" className="flex min-h-0 flex-1 bg-background">
      <nav
        aria-label={t('EnsoBot navigation')}
        className="flex w-[74px] shrink-0 flex-col items-center border-r py-5"
      >
        <span className="mb-7 flex size-10 items-center justify-center rounded-2xl bg-brand/10 text-brand">
          <Bot className="size-6" strokeWidth={1.5} />
        </span>
        {(
          [
            { id: 'chats', icon: MessagesSquare, label: 'Bot chats' },
            { id: 'members', icon: Users, label: 'Members' },
            { id: 'board', icon: LayoutGrid, label: 'Message board' },
            { id: 'workspace', icon: BriefcaseBusiness, label: 'Shared workspace' },
          ] as const
        ).map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            type="button"
            aria-current={page === id ? 'page' : undefined}
            onClick={() => setPage(id)}
            className={cn(
              'mb-2 flex w-[62px] flex-col items-center gap-1.5 rounded-xl px-1 py-3 text-[10px] focus-visible:outline-2 focus-visible:outline-ring',
              page === id
                ? 'bg-brand/10 font-medium text-brand'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            <Icon className="size-5" strokeWidth={1.7} />
            {t(label)}
          </button>
        ))}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          title={t('Settings')}
          aria-label={t('Settings')}
          onClick={() => window.electronAPI.window.openSettings()}
        >
          <Settings2 className="size-4 text-muted-foreground" />
        </Button>
      </nav>
      <aside
        data-slot="ensobot-conversations"
        className="flex w-[258px] shrink-0 flex-col border-r max-[1000px]:w-[214px]"
      >
        <div className="flex h-[72px] shrink-0 items-center justify-between px-5">
          <div>
            <h2 className="text-base font-semibold tracking-tight">EnsoBot</h2>
            <p className="mt-0.5 text-[10px] tracking-widest text-muted-foreground">
              {t('YOUR AI TEAM')}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!local || importing}
            onClick={() => void importCard()}
            aria-label={t('Add bot')}
            title={t('Add bot')}
          >
            <Plus className="size-4" />
          </Button>
        </div>
        <div className="px-4 pb-4">
          <label className="flex items-center gap-2 rounded-lg border bg-muted/30 px-2.5 py-2 text-muted-foreground">
            <Search className="size-3.5 shrink-0" />
            <input
              aria-label={t('Search bots and chats')}
              placeholder={t('Search bots and chats')}
              className="min-w-0 flex-1 bg-transparent text-xs outline-none"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        <div className="mx-4 mb-4 flex gap-1 border-b pb-2">
          {(['all', 'dm', 'room'] as const).map((id) => (
            <button
              key={id}
              type="button"
              className={cn(
                'rounded-md px-2 py-1.5 text-xs focus-visible:outline-2 focus-visible:outline-ring',
                filter === id
                  ? 'bg-muted font-medium'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {t(id === 'all' ? 'All' : id === 'dm' ? 'Direct messages' : 'Groups')}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2">
          {filter !== 'room' ? (
            <section className="mb-5">
              <SidebarHeading label={t('Direct messages')} count={visibleCards.length} />
              {visibleCards.map((card) => {
                const working = snapshot?.tasks.some(
                  (task) =>
                    task.cardId === card.id &&
                    (task.status === 'doing' || task.status === 'claimed')
                );
                return (
                  <ConversationRow
                    key={card.id}
                    name={card.name}
                    selected={
                      page === 'chats' && selection?.kind === 'dm' && selection.cardId === card.id
                    }
                    preview={
                      lastPreview(
                        (snapshot?.bubbles ?? []).filter((bubble) => bubble.cardId === card.id)
                      ) || t(card.bare ? 'Complete this character card' : 'Start a conversation')
                    }
                    onClick={() => choose({ kind: 'dm', cardId: card.id })}
                  >
                    <span className="relative">
                      <CirclePhoto
                        src={card.previewUrl}
                        crop={card.crop}
                        width={card.width}
                        height={card.height}
                        size={37}
                        alt={card.name}
                      />
                      {working ? (
                        <span
                          title={t('Working')}
                          className="absolute right-0 bottom-0 size-2.5 rounded-full border-2 border-background bg-brand"
                        />
                      ) : null}
                    </span>
                  </ConversationRow>
                );
              })}
            </section>
          ) : null}
          {filter !== 'dm' ? (
            <section className="mb-5">
              <SidebarHeading label={t('Groups')} count={groups.length}>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title={t('New group chat')}
                  aria-label={t('New group chat')}
                  disabled={cards.length < 2}
                  onClick={() => setGroupOpen(true)}
                >
                  <Plus className="size-3" />
                </Button>
              </SidebarHeading>
              {groups.map((room) => (
                <ConversationRow
                  key={room.id}
                  name={room.name}
                  selected={
                    page === 'chats' && selection?.kind === 'room' && selection.roomId === room.id
                  }
                  preview={
                    lastPreview(
                      (snapshot?.roomMessages ?? []).filter((message) => message.roomId === room.id)
                    ) || t('{{count}} members', { count: room.memberIds.length })
                  }
                  onClick={() => choose({ kind: 'room', roomId: room.id })}
                >
                  <span className="flex size-[37px] shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                    <Hash className="size-5" />
                  </span>
                </ConversationRow>
              ))}
            </section>
          ) : null}
          {!cards.length ? (
            <p className="px-3 text-xs leading-6 text-muted-foreground">
              {t('Your team starts with one character.')}
            </p>
          ) : !visibleCards.length && !groups.length ? (
            <p className="px-3 text-xs text-muted-foreground">{t('No matching chats')}</p>
          ) : null}
        </div>
        <div className="space-y-3 border-t p-3">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg bg-muted/40 px-3 py-2.5 text-left text-xs hover:bg-muted"
            onClick={() => setPage('workspace')}
          >
            <span
              className={cn(
                'size-1.5 rounded-full',
                busyCount ? 'bg-brand' : 'bg-muted-foreground/50'
              )}
            />
            <span className="flex-1 text-muted-foreground">
              {busyCount
                ? t('{{count}} tasks running', { count: busyCount })
                : t('No background tasks running')}
            </span>
            <ChevronRight className="size-3" />
          </button>
          <NodeSwitcher className="max-w-full" />
        </div>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {snapshot && <EnsobotInteractions snapshot={snapshot} />}
        {error || loadError ? (
          <div
            role="alert"
            className="border-b bg-destructive/5 px-5 py-2 text-xs text-destructive"
          >
            {error || loadError}
          </div>
        ) : null}
        {!local ? (
          <p className="flex items-center gap-2 border-b px-5 py-2 text-xs text-muted-foreground">
            <Network className="size-3.5" />
            {t('Connected node · edit character cards on their home node.')}
          </p>
        ) : null}
        {!snapshot ? (
          <div className="m-auto p-8">
            <EmptyState
              icon={Network}
              title={t('Waiting for node data')}
              description={t('Check the node connection or switch to this computer.')}
            />
          </div>
        ) : page === 'members' ? (
          <Members
            snapshot={snapshot}
            listed={listed}
            local={local}
            importing={importing}
            onImport={() => void importCard()}
            onEdit={editCard}
            onChat={(id) => choose({ kind: 'dm', cardId: id })}
          />
        ) : page === 'workspace' ? (
          <EnsobotWorkspace snapshot={snapshot} />
        ) : page === 'board' ? (
          <Board snapshot={snapshot} />
        ) : selection ? (
          <ChatPane
            key={chatKey}
            snapshot={snapshot}
            selection={selection}
            local={local}
            onEdit={editCard}
            canEdit={!!listed}
            onWorkspace={() => setPage('workspace')}
            text={drafts[chatKey] ?? ''}
            setText={(update) =>
              setDrafts((current) => ({
                ...current,
                [chatKey]: typeof update === 'function' ? update(current[chatKey] ?? '') : update,
              }))
            }
          />
        ) : (
          <Welcome
            local={local}
            importing={importing}
            onImport={() => void importCard()}
            onBoard={() => setPage('board')}
          />
        )}
      </main>
      {editing ? (
        <CharacterCardDialog
          key={editing.id}
          summary={editing}
          onClose={() => setEditing(null)}
          onChanged={reloadCards}
          onRemoved={() => {
            setEditing(null);
            reloadCards();
          }}
        />
      ) : null}
      {groupOpen ? (
        <GroupDialog
          cards={cards}
          onClose={() => setGroupOpen(false)}
          onCreated={(roomId) => {
            setSelection({ kind: 'room', roomId });
            setPage('chats');
            setGroupOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function SidebarHeading({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children?: ReactNode;
}) {
  return (
    <div className="mb-1 flex h-6 items-center gap-2 px-3 text-[10px] font-medium text-muted-foreground">
      <span>{label}</span>
      <span className="font-mono opacity-60">{count}</span>
      <span className="ml-auto">{children}</span>
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
        'relative my-0.5 flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left focus-visible:outline-2 focus-visible:outline-ring',
        selected ? 'bg-brand/8' : 'hover:bg-muted/60'
      )}
    >
      {selected ? (
        <span className="absolute left-0 top-1/3 h-1/3 w-0.5 rounded-full bg-brand" />
      ) : null}
      {children}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{name}</span>
        <span className="mt-1 block truncate text-[11px] text-muted-foreground">{preview}</span>
      </span>
    </button>
  );
}
function Welcome({
  local,
  importing,
  onImport,
  onBoard,
}: {
  local: boolean;
  importing: boolean;
  onImport: () => void;
  onBoard: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-0 flex-1 overflow-auto">
      <div className="m-auto w-full max-w-2xl px-8 py-10">
        <div className="mb-7 flex items-center gap-3">
          <span className="flex size-14 items-center justify-center rounded-2xl border bg-muted/30 text-brand">
            <Bot className="size-8" strokeWidth={1.2} />
          </span>
          <span className="text-[11px] tracking-[0.18em] text-muted-foreground">
            ENSOBOT / {t('YOUR AI TEAM')}
          </span>
        </div>
        <h1 className="text-[30px] font-semibold leading-tight tracking-tight">
          {t('A team you can talk to.')}
        </h1>
        <p className="mt-4 max-w-md text-sm leading-7 text-muted-foreground">
          {t(
            'Give each bot a personality and a role. Talk in private, think together, and let the work continue in EnsoCode.'
          )}
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Button size="lg" disabled={!local || importing} onClick={onImport}>
            <Import className="size-4" />
            {t('Add your first bot')}
          </Button>
          <Button size="lg" variant="ghost" onClick={onBoard}>
            {t('Explore the message board')}
            <ArrowRight className="size-4" />
          </Button>
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          {t('Import a PNG / JPG, or an EnsoBot character card.')}
        </p>
        <div className="mt-12 grid grid-cols-3 gap-5 border-t pt-6 max-[900px]:grid-cols-1">
          {[
            {
              icon: Bot,
              title: 'A distinct personality',
              text: 'Portrait, personality and a role of their own.',
            },
            {
              icon: MessagesSquare,
              title: 'Conversation comes first',
              text: 'Private chats and groups, without stopping background work.',
            },
            {
              icon: Network,
              title: 'Work on your nodes',
              text: 'Your tools, your workspace, your EnsoCode.',
            },
          ].map(({ icon: Icon, title, text }) => (
            <div key={title}>
              <Icon className="mb-3 size-4 text-muted-foreground" />
              <h2 className="text-xs font-medium">{t(title)}</h2>
              <p className="mt-2 text-[11px] leading-5 text-muted-foreground">{t(text)}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
function Members({
  snapshot,
  listed,
  local,
  importing,
  onImport,
  onEdit,
  onChat,
}: {
  snapshot: EnsobotSnapshot;
  listed: CardDetails | null;
  local: boolean;
  importing: boolean;
  onImport: () => void;
  onEdit: (id: string) => void;
  onChat: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <SurfaceHeader
        eyebrow="PEOPLE"
        title={t('Members')}
        description={t('A personality to talk to. A role to work with.')}
      >
        <Button onClick={onImport} disabled={!local || importing}>
          <Plus className="size-4" />
          {t('Add bot')}
        </Button>
      </SurfaceHeader>
      <div className="min-h-0 flex-1 overflow-auto p-6">
        {!snapshot.cards.length ? (
          <EmptyState
            icon={Users}
            title={t('Your team starts with one character.')}
            description={t('Import a PNG / JPG, or an EnsoBot character card.')}
          >
            <Button onClick={onImport} disabled={!local || importing}>
              <Import className="size-4" />
              {t('Import picture')}
            </Button>
          </EmptyState>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
            {snapshot.cards.map((card) => {
              const detail = listed?.cards.find((item) => item.id === card.id)?.card;
              const task = snapshot.tasks.find(
                (item) =>
                  item.cardId === card.id && (item.status === 'doing' || item.status === 'claimed')
              );
              return (
                <article key={card.id} className="flex min-w-0 flex-col rounded-xl border p-5">
                  <div className="flex items-start justify-between">
                    <CirclePhoto
                      src={card.previewUrl}
                      crop={card.crop}
                      width={card.width}
                      height={card.height}
                      size={56}
                      alt={card.name}
                    />
                    {card.coordinator ? (
                      <ShieldCheck className="size-4 text-brand" aria-label={t('Coordinator')} />
                    ) : null}
                  </div>
                  <h2 className="mt-4 truncate text-base font-semibold">{card.name}</h2>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {t(
                      card.bare ? 'Needs setup' : card.coordinator ? 'Coordinator' : 'Team member'
                    )}
                  </p>
                  <p className="mt-3 line-clamp-3 min-h-14 text-xs leading-6 text-muted-foreground">
                    {detail?.role.duty ||
                      detail?.persona.personality ||
                      t('Give this bot a personality and a responsibility.')}
                  </p>
                  <div className="my-4 border-t pt-3">
                    {task ? (
                      <TaskStatus status={task.status} />
                    ) : (
                      <span className="text-[11px] text-muted-foreground">
                        {t('No background tasks running')}
                      </span>
                    )}
                  </div>
                  <div className="mt-auto flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => onChat(card.id)}
                    >
                      <MessageCircle className="size-3.5" />
                      {t('Private chat')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('Edit character card')}
                      title={t('Edit character card')}
                      disabled={!local || !listed}
                      onClick={() => onEdit(card.id)}
                    >
                      <Settings2 className="size-3.5" />
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {listed?.errors.length ? (
          <p role="status" className="mt-4 text-xs text-warning">
            {t('Some card files could not be read. The rest of the list is still here.')}
          </p>
        ) : null}
      </div>
    </section>
  );
}
