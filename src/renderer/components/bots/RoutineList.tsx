import { describeCron } from '@shared/bots/cron';
import type { BotRoutine } from '@shared/types/bot';
import { Loader2, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { addToast } from '@/components/ui/toast';
import { type TFunction, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';
import { useBotsStore } from '@/stores/bots';
import { chatRoutines } from '@/stores/bots/groupBoard';
import {
  ROUTINE_PRESETS,
  type RoutineDraftIssue,
  routineDraftIssue,
  routineTargets,
  schedulePreview,
} from '@/stores/bots/routines';
import { FieldLabel } from './BotFields';
import { chatTitle } from './botText';

const PRESET_LABELS = ['Daily at 9:00', 'Weekdays at 9:00', 'Mondays at 9:00', 'Hourly'];

const stamp = (at: number) =>
  new Date(at).toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

function routineErrorText(error: string, t: TFunction): string {
  switch (error) {
    case 'invalid':
      return t(
        'Check the title, prompt and schedule, and that the member is still in the target chat.'
      );
    case 'not-found':
      return t('This routine no longer exists.');
    case 'unavailable':
      return t('The member or target chat is archived or unavailable.');
    case 'disabled':
      return t('Bot mode is off.');
    default:
      return error;
  }
}

function issueText(issue: RoutineDraftIssue, t: TFunction): string {
  switch (issue) {
    case 'title':
      return t('Enter a title.');
    case 'prompt':
      return t('Enter what the member should do.');
    case 'schedule':
      return t('Invalid cron expression (minute hour day month weekday).');
    case 'chat':
      return t('Choose a target chat.');
  }
}

/**
 * 例行任务列表：列表、启停、立即运行、编辑、删除。
 * 传 botId = 成员资料「例行」页签；传 chatId = 群信息里本群的例行任务（跨成员，显示成员名）。
 */
export function RoutineList({
  botId,
  chatId,
}: { botId: string; chatId?: never } | { botId?: never; chatId: string }) {
  const { t, locale } = useI18n();
  const chats = useBotsStore((s) => s.chats);
  const bots = useBotsStore((s) => s.bots);
  const [routines, setRoutines] = useState<BotRoutine[] | null>(null);
  const [editing, setEditing] = useState<BotRoutine | 'new' | null>(null);
  const [deleting, setDeleting] = useState<BotRoutine | null>(null);

  const refresh = useCallback(async () => {
    const result = await window.electronAPI.bots.routines
      .list(botId ? { botId } : {})
      .catch(() => null);
    const list = result?.ok ? result.routines : [];
    setRoutines(chatId ? chatRoutines(list, chatId) : list);
  }, [botId, chatId]);

  useEffect(() => {
    setRoutines(null);
    void refresh();
    return window.electronAPI.bots.onEvent((event) => {
      if (event.kind === 'routine') void refresh();
    });
  }, [refresh]);

  const toggle = async (routine: BotRoutine, enabled: boolean) => {
    const { id, title, prompt, schedule } = routine;
    const result = await window.electronAPI.bots.routines.save({
      botId: routine.botId,
      id,
      title,
      prompt,
      schedule,
      chatId: routine.chatId,
      enabled,
    });
    if (!result.ok)
      addToast({
        type: 'error',
        title: t('Routine not saved'),
        description: routineErrorText(result.error, t),
      });
    void refresh();
  };

  const runNow = async (routine: BotRoutine) => {
    const result = await window.electronAPI.bots.routines.runNow({
      botId: routine.botId,
      id: routine.id,
    });
    if (result.ok) addToast({ type: 'success', title: t('Routine started') });
    else
      addToast({
        type: 'error',
        title: t('Routine did not run'),
        description: routineErrorText(result.error, t),
      });
  };

  const remove = async (routine: BotRoutine) => {
    setDeleting(null);
    const result = await window.electronAPI.bots.routines.remove({
      botId: routine.botId,
      id: routine.id,
    });
    if (!result.ok)
      addToast({
        type: 'error',
        title: t('Routine not deleted'),
        description: routineErrorText(result.error, t),
      });
    void refresh();
  };

  if (routines === null) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  return (
    <div className="space-y-1.5">
      <Button size="xs" variant="outline" onClick={() => setEditing('new')}>
        <Plus />
        {t('New routine')}
      </Button>
      {routines.length === 0 && (
        <p className="text-muted-foreground text-xs">{t('No routines yet')}</p>
      )}
      {routines.map((routine) => {
        const chat = chats.find((item) => item.id === routine.chatId);
        return (
          <div
            key={routine.id}
            className={cn(
              'rounded-lg border bg-card px-2.5 py-2 text-xs',
              !routine.enabled && 'opacity-70'
            )}
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium text-sm">{routine.title}</span>
              <Switch
                checked={routine.enabled}
                onCheckedChange={(enabled) => void toggle(routine, enabled)}
                title={routine.enabled ? t('Enabled') : t('Paused')}
              />
            </div>
            <div className="mt-0.5 text-muted-foreground">
              {chatId
                ? `${bots.find((bot) => bot.id === routine.botId)?.name ?? t('Deleted member')} · `
                : ''}
              {describeCron(routine.schedule, locale)}
              {chatId
                ? ''
                : ` · ${
                    chat
                      ? t('Posts to {{chat}}', { chat: chatTitle(chat, bots, t) })
                      : t('Target chat missing')
                  }`}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-muted-foreground">
              <span>
                {routine.lastRunAt
                  ? t('Last run {{time}} · {{result}}', {
                      time: stamp(routine.lastRunAt),
                      result:
                        routine.lastResult === 'ok'
                          ? '✓'
                          : routine.lastResult === 'error'
                            ? t('Error')
                            : t('Skipped'),
                    })
                  : t('Never run')}
              </span>
              {routine.missed ? (
                <span className="rounded bg-warning/20 px-1.5 text-warning">
                  {t('Missed {{n}} times', { n: routine.missed })}
                </span>
              ) : null}
            </div>
            <div className="mt-1.5 flex justify-end gap-1">
              <Button
                size="xs"
                variant="ghost"
                disabled={!routine.enabled}
                onClick={() => void runNow(routine)}
              >
                <Play />
                {t('Run now')}
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setEditing(routine)}>
                <Pencil />
                {t('Edit')}
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setDeleting(routine)}>
                <Trash2 />
                {t('Delete')}
              </Button>
            </div>
          </div>
        );
      })}

      {editing && (
        <RoutineEditor
          botId={botId}
          chatId={chatId}
          routine={editing === 'new' ? undefined : editing}
          onClose={(saved) => {
            setEditing(null);
            if (saved) void refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('Delete routine "{{title}}"?', { title: deleting?.title ?? '' })}
        description={t('It will no longer run. This cannot be undone.')}
        confirmLabel={t('Delete')}
        onConfirm={() => deleting && void remove(deleting)}
      />
    </div>
  );
}

/** 群模式（fixedChatId）：目标聊天固定为本群，新建时选本群成员，编辑时成员不可改 */
function RoutineEditor({
  botId: memberId,
  chatId: fixedChatId,
  routine,
  onClose,
}: {
  botId?: string;
  chatId?: string;
  routine?: BotRoutine;
  onClose: (saved: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const chats = useBotsStore((s) => s.chats);
  const bots = useBotsStore((s) => s.bots);
  const members = useMemo(() => {
    const chat = chats.find((item) => item.id === fixedChatId);
    return (chat?.members ?? []).flatMap((id) => {
      const bot = bots.find((item) => item.id === id && item.archivedAt === undefined);
      return bot ? [bot] : [];
    });
  }, [chats, bots, fixedChatId]);
  const [botId, setBotId] = useState(routine?.botId ?? memberId ?? members[0]?.id ?? '');
  const targets = useMemo(() => routineTargets(chats, botId), [chats, botId]);
  const [title, setTitle] = useState(routine?.title ?? '');
  const [prompt, setPrompt] = useState(routine?.prompt ?? '');
  const [schedule, setSchedule] = useState(routine?.schedule ?? ROUTINE_PRESETS[0]);
  const [chatId, setChatId] = useState(routine?.chatId ?? fixedChatId ?? targets[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const preview = schedulePreview(schedule, locale, Date.now());
  const chatLabel = (id: string) => {
    const chat = chats.find((item) => item.id === id);
    if (!chat) return t('Target chat missing');
    return `${chatTitle(chat, bots, t)} · ${chat.kind === 'group' ? t('Group chat') : t('Private chat')}`;
  };
  const options =
    targets.some((chat) => chat.id === chatId) || !chatId
      ? targets.map((chat) => chat.id)
      : [chatId, ...targets.map((chat) => chat.id)];

  const save = async () => {
    if (!botId) return setError(t('Choose a member.'));
    const issue = routineDraftIssue({ title, prompt, schedule, chatId });
    if (issue) return setError(issueText(issue, t));
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.bots.routines.save({
        botId,
        title,
        prompt,
        schedule,
        chatId,
        ...(routine ? { id: routine.id, enabled: routine.enabled } : {}),
      });
      if (result.ok) onClose(true);
      else setError(routineErrorText(result.error, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose(false)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{routine ? t('Edit routine') : t('New routine')}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="max-h-[65vh] space-y-4">
          <div>
            <FieldLabel>{t('Routine title')}</FieldLabel>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <div>
            <FieldLabel hint={t('Sent to the member as the task each time it runs')}>
              {t('Prompt')}
            </FieldLabel>
            <Textarea rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </div>
          <div>
            <FieldLabel hint={t('cron: minute hour day month weekday, local time')}>
              {t('Schedule')}
            </FieldLabel>
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {ROUTINE_PRESETS.map((preset, index) => (
                <Button
                  key={preset}
                  size="xs"
                  variant={
                    schedulePreview(schedule, locale, 0)?.source === preset ? 'default' : 'outline'
                  }
                  onClick={() => setSchedule(preset)}
                >
                  {t(PRESET_LABELS[index])}
                </Button>
              ))}
            </div>
            <Input
              className="font-mono"
              value={schedule}
              placeholder="0 9 * * 1-5"
              onChange={(event) => setSchedule(event.target.value)}
            />
            <p
              className={cn('mt-1 text-xs', preview ? 'text-muted-foreground' : 'text-destructive')}
            >
              {preview
                ? `${preview.description} · ${
                    preview.next
                      ? t('Next run {{time}}', { time: stamp(preview.next) })
                      : t('Never runs')
                  }`
                : issueText('schedule', t)}
            </p>
          </div>
          {fixedChatId ? (
            <div>
              <FieldLabel>{t('Member')}</FieldLabel>
              <Select
                items={members.map((bot) => ({ value: bot.id, label: bot.name }))}
                value={botId}
                disabled={Boolean(routine)}
                onValueChange={(value) => setBotId(value as string)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                  {members.map((bot) => (
                    <SelectItem key={bot.id} value={bot.id}>
                      {bot.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : (
            <div>
              <FieldLabel>{t('Target chat')}</FieldLabel>
              {options.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  {t('This member is not in any chat yet. Start a private chat first.')}
                </p>
              ) : (
                <Select
                  items={options.map((id) => ({ value: id, label: chatLabel(id) }))}
                  value={chatId}
                  onValueChange={(value) => setChatId(value as string)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                    {options.map((id) => (
                      <SelectItem key={id} value={id}>
                        {chatLabel(id)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              )}
            </div>
          )}
          {error && <p className="text-destructive text-sm">{error}</p>}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onClose(false)}>
            {t('Cancel')}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void save()}>
            {busy && <Loader2 className="animate-spin" />}
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
