import type { BotProfile } from '@shared/types/bot';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from '@/components/ui/preview-card';
import { type TFunction, useI18n } from '@/i18n';
import { useBotsStore } from '@/stores/bots';
import { formatElapsed } from '@/stores/bots/delegations';
import {
  heldBrowserTab,
  lastHumanAt,
  memberSources,
  type PresenceInfo,
  presenceOf,
} from '@/stores/bots/presence';
import { BotAvatar } from './BotAvatar';
import { failureText } from './DelegationCard';
import { PresenceChip, presenceLabel } from './PresenceMark';

/** 成员在该聊天的状态（成员会话 + 进行中委派子会话；做完 / 失败保留到下一条人类消息） */
export function useMemberPresence(
  chatId: string,
  botId: string
): PresenceInfo & { browserTab?: string } {
  const chat = useBotsStore((s) => s.chats.find((item) => item.id === chatId));
  const sessions = useBotsStore((s) => s.sessions);
  const queue = useBotsStore((s) => s.queue);
  const silences = useBotsStore((s) => s.silences);
  const delegations = useBotsStore((s) => s.delegations);
  const holders = useBotsStore((s) => s.browserHolders);
  const chatTabs = useBotsStore((s) => s.browserTabs[chatId]?.tabs);
  const clearedAt = useBotsStore((s) => lastHumanAt(s.timelines[chatId]?.entries ?? []));
  return useMemo(() => {
    const sources = memberSources(botId, chat ?? { id: chatId, sessions: {} }, delegations);
    const browserTab = heldBrowserTab(sources.conversationIds, holders, chatTabs ?? []);
    return {
      ...presenceOf({ ...sources, sessions, queue, silences, clearedAt }),
      ...(browserTab ? { browserTab } : {}),
    };
  }, [botId, chat, chatId, delegations, sessions, queue, silences, clearedAt, holders, chatTabs]);
}

function waitText(info: PresenceInfo, t: TFunction): string | undefined {
  const wait = info.wait;
  switch (wait?.kind) {
    case 'approval':
      return t('Your approval: {{title}}', { title: wait.title });
    case 'ask':
      return t('Your answer: {{title}}', { title: wait.title });
    case 'file':
      return t('{{holder}} is editing {{file}}', { holder: wait.holder, file: wait.file });
    case 'workspace':
      return t('{{holder}} is running a workspace-wide command', { holder: wait.holder });
    case 'capacity':
      return t('A free slot (concurrency limit, not a person)');
    case 'turn':
      return t('Its previous turn to finish');
    default:
      return undefined;
  }
}

/** 跳到输入框上方该会话的审批 / 提问条并闪一下 */
function revealPending(conversationId: string) {
  const el = document.querySelector<HTMLElement>(
    `[data-pending-conversation="${CSS.escape(conversationId)}"]`
  );
  el?.scrollIntoView({ block: 'nearest' });
  el?.animate([{ backgroundColor: 'var(--color-warning)' }, { backgroundColor: 'transparent' }], {
    duration: 1200,
  });
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-12 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

/** 带状态角标的成员头像；悬停看在做什么、谁派的、用时、在等什么 */
export function PresenceAvatar({
  chatId,
  botId,
  bot,
  size = 'sm',
}: {
  chatId: string;
  botId: string;
  bot: BotProfile | undefined;
  size?: 'xs' | 'sm' | 'md';
}) {
  const { t } = useI18n();
  const info = useMemberPresence(chatId, botId);
  const parent = useBotsStore((s) =>
    info.delegation ? s.bots.find((item) => item.id === info.delegation?.parentBotId) : undefined
  );
  const record = info.delegation;
  const wait = waitText(info, t);
  const browserTitle = useBotsStore((s) =>
    info.browserTab ? s.browserTitles[info.browserTab] || t('Browser') : undefined
  );
  const pending = info.wait && 'conversationId' in info.wait ? info.wait.conversationId : undefined;
  return (
    <PreviewCard>
      <PreviewCardTrigger render={<span className="relative inline-flex shrink-0" />}>
        <BotAvatar bot={bot} size={size} presence={info.state} />
        <span className="sr-only">{presenceLabel(info, t)}</span>
      </PreviewCardTrigger>
      <PreviewCardPopup align="start" className="w-72 flex-col gap-1.5 p-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm">{bot?.name ?? t('Deleted member')}</span>
          <PresenceChip info={info} />
        </div>
        {info.state === 'idle' ? (
          <div className="text-muted-foreground">{t('Nothing in progress')}</div>
        ) : (
          <>
            {record && (
              <>
                <Row label={t('Task')}>
                  <span className="line-clamp-2">{record.task}</span>
                </Row>
                <Row label={t('From')}>{parent?.name ?? t('Deleted member')}</Row>
                <Row label={t('Time')}>
                  {formatElapsed((record.finishedAt ?? Date.now()) - record.createdAt)}
                </Row>
              </>
            )}
            {wait && <Row label={t('Waiting on')}>{wait}</Row>}
            {browserTitle && (
              <Row label={t('Browser')}>
                <span className="line-clamp-1">{browserTitle}</span>
              </Row>
            )}
            {info.quietSince !== undefined && (
              <div className="text-muted-foreground">
                {t('Still running, no output for {{time}}', {
                  time: formatElapsed(Date.now() - info.quietSince),
                })}
              </div>
            )}
            {record && info.state === 'stuck' && record.state === 'failed' && (
              <div className="text-muted-foreground">{failureText(record, t)}</div>
            )}
            {record && info.state === 'done' && record.result && (
              <div className="line-clamp-3 text-muted-foreground">{record.result}</div>
            )}
            {pending && (
              <Button size="xs" className="mt-1 self-start" onClick={() => revealPending(pending)}>
                {t('Go handle it')}
              </Button>
            )}
          </>
        )}
      </PreviewCardPopup>
    </PreviewCard>
  );
}
