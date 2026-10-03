import type { BotProfile } from '@shared/types/bot';
import { Inbox } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { toolLabel } from '@/lib/toolLabels';
import { useBotsStore } from '@/stores/bots';
import { type PendingItem, pendingItems, sessionOwners } from '@/stores/bots/selectors';
import { BotAvatar } from './BotAvatar';
import { chatTitle } from './botText';

/** 收件箱：所有成员会话里待你处理的审批与提问 */
export function BotInbox() {
  const { t } = useI18n();
  const sessions = useBotsStore((s) => s.sessions);
  const chats = useBotsStore((s) => s.chats);
  const bots = useBotsStore((s) => s.bots);
  const items = useMemo(() => pendingItems(sessions, sessionOwners(chats)), [sessions, chats]);
  const byId = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b px-4">
        <div className="font-semibold text-sm">{t('Inbox')}</div>
        <div className="text-muted-foreground text-xs">
          {t('Everything members are waiting on you for')}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl space-y-2.5 px-6 py-4">
          {items.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
              <Inbox className="h-6 w-6" />
              <p className="text-sm">{t('Nothing needs your attention')}</p>
            </div>
          )}
          {items.map((item) => (
            <InboxCard
              key={`${item.conversationId}:${item.request.requestId}`}
              item={item}
              bot={byId.get(item.botId)}
              chatName={(() => {
                const chat = chats.find((entry) => entry.id === item.chatId);
                return chat ? chatTitle(chat, bots, t) : '';
              })()}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function InboxCard({
  item,
  bot,
  chatName,
}: {
  item: PendingItem;
  bot: BotProfile | undefined;
  chatName: string;
}) {
  const { t } = useI18n();
  const setView = useBotsStore((s) => s.setView);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const run = (task: Promise<unknown>) => {
    setBusy(true);
    void task.finally(() => setBusy(false));
  };
  const approve = (decision: 'allow' | 'allowSession' | 'deny') =>
    run(
      window.electronAPI.agent.respondApproval(
        item.conversationId,
        item.request.requestId,
        decision
      )
    );
  const reply = (text: string) =>
    text.trim() &&
    run(
      window.electronAPI.agent.respondAsk(item.conversationId, item.request.requestId, text.trim())
    );
  const reviewing = item.kind === 'approval' && item.request.phase === 'reviewing';

  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <BotAvatar bot={bot} size="sm" />
        <span className="text-foreground">{bot?.name ?? t('Deleted member')}</span>
        {chatName && <span>· {chatName}</span>}
        <span
          className={
            item.kind === 'approval'
              ? 'rounded bg-warning/20 px-1.5 text-[11px] text-warning'
              : 'rounded bg-info/15 px-1.5 text-[11px] text-info'
          }
        >
          {item.kind === 'approval' ? t('Approval') : t('Question')}
        </span>
      </div>
      {item.kind === 'approval' ? (
        <div className="mt-2 text-sm">
          {toolLabel(item.request.tool, t)}
          <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 px-2 py-1.5 font-mono text-xs">
            {item.request.summary}
          </pre>
        </div>
      ) : (
        <div className="mt-2 whitespace-pre-wrap text-sm">{item.request.question}</div>
      )}
      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5">
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setView({ kind: 'chat', chatId: item.chatId })}
        >
          {t('Go to chat')}
        </Button>
        {item.kind === 'approval' ? (
          reviewing ? (
            <span className="text-muted-foreground text-xs">{t('Assistant reviewing…')}</span>
          ) : (
            <>
              <Button size="xs" variant="outline" disabled={busy} onClick={() => approve('deny')}>
                {t('Deny')}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => approve('allowSession')}
              >
                {t('Always allow in this session')}
              </Button>
              <Button size="xs" disabled={busy} onClick={() => approve('allow')}>
                {t('Allow')}
              </Button>
            </>
          )
        ) : (
          <>
            {item.request.options?.map((option) => (
              <Button
                key={option}
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => reply(option)}
              >
                {option}
              </Button>
            ))}
            <Input
              className="h-7 w-48"
              value={answer}
              placeholder={t('Custom answer…')}
              onChange={(event) => setAnswer(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && reply(answer)}
            />
            <Button size="xs" disabled={busy || !answer.trim()} onClick={() => reply(answer)}>
              {t('Reply')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
