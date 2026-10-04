import type { BotChat, BotProfile } from '@shared/types/bot';
import {
  Archive,
  ArchiveRestore,
  Inbox,
  LayoutTemplate,
  PanelLeftClose,
  Pin,
  PinOff,
  Plus,
  Settings,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { NodeSwitcher } from '@/components/nodes/NodeSwitcher';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useBotPendingCount, useBotsStore } from '@/stores/bots';
import { pendingOwners } from '@/stores/bots/delegations';
import { type ChatSummary, chatSummary, pendingItems, sortChats } from '@/stores/bots/selectors';
import { isUnread } from '@/stores/bots/unread';
import { BotAvatar, GroupAvatar } from './BotAvatar';
import { BotSearchButton } from './BotSearchDialog';
import { chatErrorText, chatTitle } from './botText';

const ICON_BUTTON_CLASS =
  'relative flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

interface BotSidebarProps {
  width: number;
  onCollapse: () => void;
  onNewMember: () => void;
  onNewGroup: () => void;
  onNewTeam: () => void;
}

export function BotSidebar({
  width,
  onCollapse,
  onNewMember,
  onNewGroup,
  onNewTeam,
}: BotSidebarProps) {
  const { t, locale } = useI18n();
  const bots = useBotsStore((s) => s.bots);
  const chats = useBotsStore((s) => s.chats);
  const queue = useBotsStore((s) => s.queue);
  const sessions = useBotsStore((s) => s.sessions);
  const delegations = useBotsStore((s) => s.delegations);
  const timelines = useBotsStore((s) => s.timelines);
  const reads = useBotsStore((s) => s.reads);
  const view = useBotsStore((s) => s.view);
  const setView = useBotsStore((s) => s.setView);
  const openDirect = useBotsStore((s) => s.openDirect);
  const upsertChat = useBotsStore((s) => s.upsertChat);
  const upsertBot = useBotsStore((s) => s.upsertBot);
  const [showArchived, setShowArchived] = useState(false);
  const [deleting, setDeleting] = useState<BotChat | null>(null);

  const byId = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const names = useMemo(() => Object.fromEntries(bots.map((bot) => [bot.id, bot.name])), [bots]);
  const pending = useMemo(
    () => pendingItems(sessions, pendingOwners(chats, delegations)),
    [sessions, chats, delegations]
  );
  const rows = useMemo(
    () =>
      chats.map((chat) => ({
        chat,
        summary: {
          ...chatSummary(chat, { sessions, timeline: timelines[chat.id], queue, names }),
          pending: pending.filter((item) => item.chatId === chat.id).length,
        },
      })),
    [chats, sessions, timelines, queue, names, pending]
  );
  const groups = sortChats(rows.filter((row) => row.chat.kind === 'group' && !row.chat.archivedAt));
  const directByBot = new Map(
    rows
      .filter((row) => row.chat.kind === 'direct' && !row.chat.archivedAt)
      .map((row) => [row.chat.members[0], row])
  );
  const members = bots
    .filter((bot) => bot.archivedAt === undefined)
    .map((bot) => ({ bot, row: directByBot.get(bot.id) }))
    .sort((a, b) => {
      const pin = Number(b.row?.chat.pinned ?? false) - Number(a.row?.chat.pinned ?? false);
      return (
        pin ||
        (b.row?.summary.activityAt ?? b.bot.updatedAt) -
          (a.row?.summary.activityAt ?? a.bot.updatedAt)
      );
    });
  const archivedChats = rows.filter((row) => row.chat.archivedAt !== undefined);
  const archivedBots = bots.filter((bot) => bot.archivedAt !== undefined);
  const inboxCount = useBotPendingCount();
  const activeChatId = view?.kind === 'chat' ? view.chatId : null;

  const updateChat = async (chat: BotChat, patch: { pinned?: boolean; archived?: boolean }) => {
    const result = await window.electronAPI.bots.updateChat({ chatId: chat.id, ...patch });
    if (result.ok) upsertChat(result.chat);
    else addToast({ type: 'error', title: chatErrorText(result.error, t) });
  };
  const archiveBot = async (bot: BotProfile, archived: boolean) => {
    const result = await window.electronAPI.bots.archive(bot.id, archived);
    if (result.ok) upsertBot(result.bot);
    else addToast({ type: 'error', title: result.error });
  };

  const status = (summary: ChatSummary | undefined): string | null => {
    if (!summary) return null;
    if (summary.running) return t('Working');
    if (summary.queued) return t('Queued');
    return summary.activityAt ? formatRelativeTime(summary.activityAt, locale) : null;
  };

  return (
    <aside
      className="flex shrink-0 flex-col overflow-hidden border-r bg-background"
      style={{ width }}
    >
      <div className="flex h-12 shrink-0 items-center gap-1 pr-2 pl-1.5">
        <NodeSwitcher className="max-w-32" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <SectionHeader title={t('Group chats')} onAdd={onNewGroup} addLabel={t('New group chat')} />
        {groups.length === 0 && (
          <p className="px-4 py-1 text-muted-foreground text-xs">{t('No group chats yet')}</p>
        )}
        {groups.map(({ chat, summary }) => (
          <ChatContextMenu
            key={chat.id}
            chat={chat}
            onPin={() => void updateChat(chat, { pinned: !chat.pinned })}
            onArchive={() => void updateChat(chat, { archived: true })}
            onDelete={() => setDeleting(chat)}
          >
            <ChatRow
              active={activeChatId === chat.id}
              avatar={
                <GroupAvatar bots={chat.members.map((id) => byId.get(id))} busy={summary.running} />
              }
              title={chatTitle(chat, bots, t)}
              pinned={chat.pinned}
              meta={status(summary)}
              preview={summary.preview}
              unread={isUnread(summary.marker, reads[summary.key]) && activeChatId !== chat.id}
              pending={summary.pending}
              onClick={() => setView({ kind: 'chat', chatId: chat.id })}
            />
          </ChatContextMenu>
        ))}

        <SectionHeader title={t('Members')} onAdd={onNewMember} addLabel={t('New member')} />
        {members.length === 0 && (
          <p className="px-4 py-1 text-muted-foreground text-xs">{t('No members yet')}</p>
        )}
        {members.map(({ bot, row }) => (
          <ChatContextMenu
            key={bot.id}
            chat={row?.chat}
            onPin={row ? () => void updateChat(row.chat, { pinned: !row.chat.pinned }) : undefined}
            onArchive={row ? () => void updateChat(row.chat, { archived: true }) : undefined}
            onArchiveMember={() => void archiveBot(bot, true)}
          >
            <ChatRow
              active={Boolean(row && activeChatId === row.chat.id)}
              avatar={<BotAvatar bot={bot} busy={row?.summary.running} />}
              title={bot.name}
              pinned={row?.chat.pinned}
              meta={status(row?.summary)}
              preview={row?.summary.preview || bot.title || bot.scope}
              unread={Boolean(
                row &&
                  isUnread(row.summary.marker, reads[row.summary.key]) &&
                  activeChatId !== row.chat.id
              )}
              pending={row?.summary.pending ?? 0}
              onClick={() => void openDirect(bot.id)}
            />
          </ChatContextMenu>
        ))}

        {showArchived && (
          <>
            <SectionHeader title={t('Archived')} />
            {archivedChats.length === 0 && archivedBots.length === 0 && (
              <p className="px-4 py-1 text-muted-foreground text-xs">{t('Nothing archived')}</p>
            )}
            {archivedChats.map(({ chat, summary }) => (
              <ChatRow
                key={chat.id}
                active={activeChatId === chat.id}
                avatar={
                  chat.kind === 'group' ? (
                    <GroupAvatar bots={chat.members.map((id) => byId.get(id))} />
                  ) : (
                    <BotAvatar bot={byId.get(chat.members[0])} />
                  )
                }
                title={chatTitle(chat, bots, t)}
                preview={summary.preview}
                action={{
                  label: t('Restore'),
                  onClick: () => void updateChat(chat, { archived: false }),
                }}
                onClick={() => setView({ kind: 'chat', chatId: chat.id })}
              />
            ))}
            {archivedBots.map((bot) => (
              <ChatRow
                key={bot.id}
                active={false}
                avatar={<BotAvatar bot={bot} />}
                title={bot.name}
                preview={bot.title || bot.scope}
                action={{ label: t('Restore'), onClick: () => void archiveBot(bot, false) }}
              />
            ))}
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t p-2">
        <button
          type="button"
          onClick={onCollapse}
          className={ICON_BUTTON_CLASS}
          title={t('Collapse sidebar')}
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
        <div className="flex items-center">
          <BotSearchButton className={ICON_BUTTON_CLASS} />
          <button
            type="button"
            className={ICON_BUTTON_CLASS}
            onClick={onNewMember}
            title={t('New member')}
          >
            <UserPlus className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={ICON_BUTTON_CLASS}
            onClick={onNewGroup}
            title={t('New group chat')}
          >
            <Users className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={ICON_BUTTON_CLASS}
            onClick={onNewTeam}
            title={t('Create team from template')}
          >
            <LayoutTemplate className="h-4 w-4" />
          </button>
          {(inboxCount > 0 || view?.kind === 'inbox') && (
            <button
              type="button"
              className={cn(
                ICON_BUTTON_CLASS,
                view?.kind === 'inbox' && 'bg-muted text-foreground'
              )}
              onClick={() => setView({ kind: 'inbox' })}
              title={t('Inbox')}
            >
              <Inbox className="h-4 w-4" />
              {inboxCount > 0 && (
                <CountBadge count={inboxCount} className="-top-0.5 -right-1 absolute" />
              )}
            </button>
          )}
          <button
            type="button"
            className={cn(ICON_BUTTON_CLASS, showArchived && 'bg-muted text-foreground')}
            onClick={() => setShowArchived((value) => !value)}
            title={t('Archived')}
          >
            <Archive className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={ICON_BUTTON_CLASS}
            onClick={() => void window.electronAPI.window.openSettings()}
            title={t('Settings')}
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('Delete group chat?')}
        description={t(
          'The group timeline and its standalone workspace are deleted. Member sessions stay readable in their history.'
        )}
        confirmLabel={t('Delete')}
        onConfirm={() => {
          const chat = deleting;
          setDeleting(null);
          if (!chat) return;
          void window.electronAPI.bots.deleteChat(chat.id).then((result) => {
            if (!result.ok) addToast({ type: 'error', title: chatErrorText(result.error, t) });
            else {
              if (activeChatId === chat.id) setView(null);
              void useBotsStore.getState().refreshChats();
            }
          });
        }}
      />
    </aside>
  );
}

export function CountBadge({ count, className }: { count: number; className?: string }) {
  return (
    <span
      className={cn(
        'min-w-4 rounded-full bg-destructive px-1 text-center font-medium text-[10px] text-white leading-4',
        className
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

function SectionHeader({
  title,
  onAdd,
  addLabel,
}: {
  title: string;
  onAdd?: () => void;
  addLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between px-4 pt-3 pb-1 text-[11px] text-muted-foreground">
      <span>{title}</span>
      {onAdd && (
        <button
          type="button"
          onClick={onAdd}
          title={addLabel}
          aria-label={addLabel}
          className="rounded p-0.5 transition-colors hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

interface ChatRowProps extends React.ComponentProps<'div'> {
  active: boolean;
  avatar: ReactNode;
  title: string;
  pinned?: boolean;
  meta?: string | null;
  preview?: string;
  unread?: boolean;
  pending?: number;
  action?: { label: string; onClick: () => void };
}

function ChatRow({
  active,
  avatar,
  title,
  pinned,
  meta,
  preview,
  unread,
  pending = 0,
  action,
  className,
  ...rest
}: ChatRowProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      {...rest}
      onKeyDown={(event) => {
        if (event.key === 'Enter') rest.onClick?.(event as never);
      }}
      className={cn(
        'mx-1.5 flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-muted',
        active && 'bg-muted',
        className
      )}
    >
      {avatar}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 truncate font-medium text-sm">{title}</span>
          {pinned && <Pin className="h-3 w-3 shrink-0 text-muted-foreground" />}
          <span className="flex-1" />
          {pending > 0 ? (
            <CountBadge count={pending} />
          ) : (
            meta && <span className="shrink-0 text-[11px] text-muted-foreground">{meta}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">{preview}</span>
          {unread && <span className="h-2 w-2 shrink-0 rounded-full bg-info" />}
          {action && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                action.onClick();
              }}
              className="shrink-0 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-background hover:text-foreground"
            >
              {action.label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatContextMenu({
  chat,
  children,
  onPin,
  onArchive,
  onDelete,
  onArchiveMember,
}: {
  chat: BotChat | undefined;
  children: React.ReactElement;
  onPin?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
  onArchiveMember?: () => void;
}) {
  const { t } = useI18n();
  return (
    <ContextMenu>
      <ContextMenuTrigger render={children as React.ReactElement<Record<string, unknown>>} />
      <ContextMenuPopup className="min-w-40">
        {onPin && (
          <ContextMenuItem onClick={onPin}>
            {chat?.pinned ? <PinOff /> : <Pin />}
            {chat?.pinned ? t('Unpin') : t('Pin')}
          </ContextMenuItem>
        )}
        {onArchive && (
          <ContextMenuItem onClick={onArchive}>
            <Archive />
            {t('Archive chat')}
          </ContextMenuItem>
        )}
        {onArchiveMember && (
          <ContextMenuItem onClick={onArchiveMember}>
            <ArchiveRestore />
            {t('Archive member')}
          </ContextMenuItem>
        )}
        {onDelete && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 />
              {t('Delete group chat')}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuPopup>
    </ContextMenu>
  );
}
