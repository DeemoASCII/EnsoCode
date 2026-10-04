import { Bot, Inbox, LayoutTemplate, PanelLeft, Settings, UserPlus, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ResizeHandle } from '@/components/chat/ResizeHandle';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useBotPendingCount, useBotsStore } from '@/stores/bots';
import { BotChatView } from './BotChatView';
import { BotInbox } from './BotInbox';
import { BotSearchButton, BotSearchDialog } from './BotSearchDialog';
import { BotSidebar, CountBadge } from './BotSidebar';
import { NewBotDialog } from './NewBotDialog';
import { NewGroupDialog } from './NewGroupDialog';
import { NewTeamDialog } from './NewTeamDialog';

const RAIL_BUTTON =
  'relative flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

interface BotViewProps {
  sidebarWidth: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onResize: (deltaX: number) => void;
}

/** Bot 模式整块内容区：成员/群聊侧栏 + 聊天 / 收件箱 */
export function BotView({ sidebarWidth, collapsed, onToggleCollapse, onResize }: BotViewProps) {
  const { t } = useI18n();
  const view = useBotsStore((s) => s.view);
  const chats = useBotsStore((s) => s.chats);
  const bots = useBotsStore((s) => s.bots);
  const loaded = useBotsStore((s) => s.loaded);
  const setView = useBotsStore((s) => s.setView);
  const [newMember, setNewMember] = useState(false);
  const [newGroup, setNewGroup] = useState(false);
  const [newTeam, setNewTeam] = useState(false);
  const inboxCount = useBotPendingCount();

  const chat = view?.kind === 'chat' ? chats.find((item) => item.id === view.chatId) : undefined;

  // 记住的聊天已被删除：回到空态
  useEffect(() => {
    if (loaded && view?.kind === 'chat' && !chat) setView(null);
  }, [loaded, view, chat, setView]);

  return (
    <>
      {collapsed ? (
        <aside className="flex w-12 shrink-0 flex-col items-center gap-1 border-r bg-background py-2">
          <BotSearchButton className={RAIL_BUTTON} />
          <button
            type="button"
            className={RAIL_BUTTON}
            onClick={() => setNewMember(true)}
            title={t('New member')}
          >
            <UserPlus className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={RAIL_BUTTON}
            onClick={() => setNewGroup(true)}
            title={t('New group chat')}
          >
            <Users className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={RAIL_BUTTON}
            onClick={() => setNewTeam(true)}
            title={t('Create team from template')}
          >
            <LayoutTemplate className="h-4 w-4" />
          </button>
          {(inboxCount > 0 || view?.kind === 'inbox') && (
            <button
              type="button"
              className={cn(RAIL_BUTTON, view?.kind === 'inbox' && 'bg-muted text-foreground')}
              onClick={() => setView({ kind: 'inbox' })}
              title={t('Inbox')}
            >
              <Inbox className="h-4 w-4" />
              {inboxCount > 0 && (
                <CountBadge count={inboxCount} className="-top-0.5 -right-1 absolute" />
              )}
            </button>
          )}
          <div className="flex-1" />
          <button
            type="button"
            className={RAIL_BUTTON}
            onClick={() => void window.electronAPI.window.openSettings()}
            title={t('Settings')}
          >
            <Settings className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={RAIL_BUTTON}
            onClick={onToggleCollapse}
            title={t('Expand sidebar')}
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        </aside>
      ) : (
        <>
          <BotSidebar
            width={sidebarWidth}
            onCollapse={onToggleCollapse}
            onNewMember={() => setNewMember(true)}
            onNewGroup={() => setNewGroup(true)}
            onNewTeam={() => setNewTeam(true)}
          />
          <ResizeHandle onResize={onResize} />
        </>
      )}

      {view?.kind === 'inbox' ? (
        <BotInbox />
      ) : chat ? (
        <BotChatView key={chat.id} chat={chat} />
      ) : (
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-background px-6 text-center">
          <Bot className="h-8 w-8 text-muted-foreground" />
          <p className="font-medium text-lg">{t('Bot mode')}</p>
          <p className="max-w-md text-muted-foreground text-sm">
            {bots.length === 0
              ? t(
                  'Create members with their own persona, model and tools, then chat with them alone or in groups.'
                )
              : t('Pick a member or a group chat on the left.')}
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setNewMember(true)}>
              <UserPlus />
              {t('New member')}
            </Button>
            {bots.length >= 2 && (
              <Button size="sm" variant="outline" onClick={() => setNewGroup(true)}>
                <Users />
                {t('New group chat')}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setNewTeam(true)}>
              <LayoutTemplate />
              {t('Create team from template')}
            </Button>
          </div>
        </div>
      )}

      <NewBotDialog open={newMember} onOpenChange={setNewMember} />
      <NewGroupDialog open={newGroup} onOpenChange={setNewGroup} />
      <BotSearchDialog />
      <NewTeamDialog open={newTeam} onOpenChange={setNewTeam} />
    </>
  );
}
