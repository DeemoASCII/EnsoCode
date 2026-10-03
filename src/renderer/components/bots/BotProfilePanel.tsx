import { describeCron } from '@shared/bots/cron';
import type { ApprovalMode } from '@shared/types/agent';
import type { BotChat, BotEngine, BotList, BotProfile, BotRoutine } from '@shared/types/bot';
import type { BotDraftInput, BotSessionRecord } from '@shared/types/botIpc';
import { Archive, Download, Loader2, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { DetailRows, PickList, setFilteredIds } from '@/components/settings/PresetsSettings';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { useBotsStore } from '@/stores/bots';
import { useSettingsStore } from '@/stores/settings';
import { BotAvatar } from './BotAvatar';
import {
  ApprovalSelect,
  ColorPicker,
  EngineField,
  FieldLabel,
  nameError,
  Segmented,
} from './BotFields';
import { botErrorText, chatTitle } from './botText';
import { MemorySpaceList } from './MemorySpaceList';

interface FormState {
  name: string;
  title: string;
  scope: string;
  persona: string;
  color: string;
  engine: BotEngine | null;
  tools: BotProfile['tools'];
  approvalMode: ApprovalMode;
  skillIds: string[];
  mcpServerIds: string[];
  canDelegateTo: BotList;
  acceptFrom: BotList;
  memoryEnabled: boolean;
}

function formOf(bot: BotProfile, persona: string): FormState {
  return {
    name: bot.name,
    title: bot.title,
    scope: bot.scope,
    persona,
    color: bot.avatar.color,
    engine: bot.engine ?? null,
    tools: bot.tools,
    approvalMode: bot.approvalMode,
    skillIds: bot.skillIds,
    mcpServerIds: bot.mcpServerIds,
    canDelegateTo: bot.delegation.canDelegateTo,
    acceptFrom: bot.delegation.acceptFrom,
    memoryEnabled: bot.memory.enabled,
  };
}

function draftOf(form: FormState): BotDraftInput {
  return {
    name: form.name.trim(),
    title: form.title.trim(),
    scope: form.scope.trim(),
    persona: form.persona,
    avatar: { color: form.color },
    engine: form.engine,
    tools: form.tools,
    approvalMode: form.approvalMode,
    skillIds: form.skillIds,
    mcpServerIds: form.mcpServerIds,
    delegation: { canDelegateTo: form.canDelegateTo, acceptFrom: form.acceptFrom },
    memory: { enabled: form.memoryEnabled },
  };
}

/** SillyTavern V2 人物卡导出（renderer 内生成并下载，不经 Main） */
function exportCard(bot: BotProfile, persona: string) {
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: bot.name,
      description: persona,
      personality: '',
      scenario: bot.scope,
      first_mes: '',
      mes_example: '',
      creator_notes: bot.title,
      tags: [],
      extensions: { enso: { title: bot.title, color: bot.avatar.color } },
    },
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(card, null, 2)], { type: 'application/json' })
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `${bot.name}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

interface BotProfilePanelProps {
  botId: string;
  chat: BotChat;
  onOpenHistory: (conversationId: string, title: string) => void;
}

export function BotProfilePanel({ botId, chat, onOpenHistory }: BotProfilePanelProps) {
  const { t } = useI18n();
  const bot = useBotsStore((s) => s.bots.find((item) => item.id === botId));
  const bots = useBotsStore((s) => s.bots);
  const [persona, setPersona] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [edited, setEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<'archive' | 'delete' | null>(null);

  const reload = useCallback(async () => {
    const result = await window.electronAPI.bots.get(botId);
    if (!result.ok) return;
    useBotsStore.getState().upsertBot(result.bot);
    setPersona(result.persona);
    setForm(formOf(result.bot, result.persona));
    setEdited(false);
  }, [botId]);

  useEffect(() => {
    setPersona(null);
    setForm(null);
    void reload();
  }, [reload]);

  const baseline = useMemo(
    () => (bot && persona !== null ? formOf(bot, persona) : null),
    [bot, persona]
  );
  const dirty =
    edited && Boolean(form && baseline && JSON.stringify(form) !== JSON.stringify(baseline));

  // 别处改了成员且本地没有未保存修改：跟随最新版本
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在版本变化时同步
  useEffect(() => {
    if (!edited && baseline) setForm(baseline);
  }, [bot?.version]);

  if (!bot || !form) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const patch = (next: Partial<FormState>) => {
    setForm({ ...form, ...next });
    setEdited(true);
  };
  const nameIssue = nameError(form.name, bots, t, bot.id);

  const save = async () => {
    setSaving(true);
    try {
      const result = await window.electronAPI.bots.update({
        botId: bot.id,
        expectedVersion: bot.version,
        draft: draftOf(form),
      });
      if (result.ok) {
        useBotsStore.getState().upsertBot(result.bot);
        setPersona(form.persona);
        setForm(formOf(result.bot, form.persona));
        setEdited(false);
        return;
      }
      addToast({
        type: 'error',
        title: botErrorText(result.reason, result.error, t),
        ...(result.reason === 'conflict'
          ? { actions: [{ label: t('Refresh'), onClick: () => void reload() }] }
          : {}),
      });
    } finally {
      setSaving(false);
    }
  };

  const runDanger = async () => {
    const action = confirm;
    setConfirm(null);
    if (action === 'archive') {
      const result = await window.electronAPI.bots.archive(bot.id, true);
      if (result.ok) useBotsStore.getState().upsertBot(result.bot);
      else addToast({ type: 'error', title: botErrorText(result.reason, result.error, t) });
      return;
    }
    const result = await window.electronAPI.bots.remove(bot.id);
    if (result.ok) {
      useBotsStore.getState().setView(null);
      await Promise.all([
        useBotsStore.getState().refreshCatalog(),
        useBotsStore.getState().refreshChats(),
      ]);
      return;
    }
    if (result.reason === 'boss') {
      const chats = useBotsStore.getState().chats;
      const titles = (result.chatIds ?? [])
        .map((id) => chats.find((item) => item.id === id))
        .filter((item): item is BotChat => Boolean(item))
        .map((item) => chatTitle(item, bots, t));
      addToast({
        type: 'warning',
        title: t('{{name}} owns group chats', { name: bot.name }),
        description: t('Choose another owner in {{groups}} first.', { groups: titles.join('、') }),
      });
      return;
    }
    addToast({ type: 'error', title: botErrorText(result.reason, result.error, t) });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 px-4 pt-4">
        <BotAvatar bot={{ name: form.name || bot.name, avatar: { color: form.color } }} size="lg" />
        <div className="min-w-0">
          <div className="truncate font-semibold text-base">{bot.name}</div>
          <div className="truncate text-muted-foreground text-sm">{bot.title}</div>
          <Button
            size="xs"
            variant="outline"
            className="mt-1"
            onClick={() => exportCard(bot, persona ?? '')}
          >
            <Download />
            {t('Export character card')}
          </Button>
        </div>
      </div>

      <Tabs defaultValue="profile" className="mt-3 flex min-h-0 flex-1 flex-col">
        <TabsList variant="underline" className="shrink-0 px-2">
          <TabsTab value="profile">{t('Profile')}</TabsTab>
          <TabsTab value="abilities">{t('Abilities')}</TabsTab>
          <TabsTab value="memory">{t('Memory')}</TabsTab>
          <TabsTab value="routines">{t('Routines')}</TabsTab>
          <TabsTab value="history">{t('History')}</TabsTab>
        </TabsList>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <TabsPanel value="profile" className="space-y-3">
            <div>
              <FieldLabel hint={t('Used for @ in groups; must be unique')}>{t('Name')}</FieldLabel>
              <Input value={form.name} onChange={(event) => patch({ name: event.target.value })} />
              {nameIssue && <p className="mt-1 text-destructive text-xs">{nameIssue}</p>}
            </div>
            <div>
              <FieldLabel>{t('Title')}</FieldLabel>
              <Input
                value={form.title}
                onChange={(event) => patch({ title: event.target.value })}
              />
            </div>
            <div>
              <FieldLabel hint={t('Used for routing and the delegation directory')}>
                {t('Responsibilities')}
              </FieldLabel>
              <Textarea
                rows={2}
                value={form.scope}
                onChange={(event) => patch({ scope: event.target.value })}
              />
            </div>
            <div>
              <FieldLabel>{t('Persona')}</FieldLabel>
              <Textarea
                rows={8}
                value={form.persona}
                onChange={(event) => patch({ persona: event.target.value })}
              />
            </div>
            <div>
              <FieldLabel>{t('Avatar color')}</FieldLabel>
              <ColorPicker value={form.color} onChange={(color) => patch({ color })} />
            </div>
            <div className="flex gap-2 border-t pt-3">
              <Button size="xs" variant="outline" onClick={() => setConfirm('archive')}>
                <Archive />
                {t('Archive member')}
              </Button>
              <Button size="xs" variant="destructive-outline" onClick={() => setConfirm('delete')}>
                <Trash2 />
                {t('Delete permanently')}
              </Button>
            </div>
          </TabsPanel>

          <TabsPanel value="abilities" className="space-y-4">
            <div>
              <FieldLabel>{t('Model')}</FieldLabel>
              <EngineField engine={form.engine} onChange={(engine) => patch({ engine })} />
            </div>
            <div>
              <FieldLabel>{t('Tools')}</FieldLabel>
              <Segmented
                value={form.tools}
                options={[
                  { value: 'all', label: t('All tools') },
                  { value: 'readonly', label: t('Read-only') },
                ]}
                onChange={(tools) => patch({ tools })}
              />
            </div>
            <div>
              <FieldLabel>{t('Approval mode')}</FieldLabel>
              <ApprovalSelect
                value={form.approvalMode}
                onChange={(approvalMode) => patch({ approvalMode })}
              />
            </div>
            <AssetPickers form={form} patch={patch} />
            <DelegationField
              label={t('Can delegate to')}
              value={form.canDelegateTo}
              bots={bots.filter((item) => item.id !== bot.id && !item.archivedAt)}
              onChange={(canDelegateTo) => patch({ canDelegateTo })}
            />
            <DelegationField
              label={t('Accepts delegation from')}
              value={form.acceptFrom}
              bots={bots.filter((item) => item.id !== bot.id && !item.archivedAt)}
              onChange={(acceptFrom) => patch({ acceptFrom })}
            />
            <label className="flex items-center justify-between gap-2 text-sm">
              <span>{t('Long-term memory')}</span>
              <Switch
                checked={form.memoryEnabled}
                onCheckedChange={(memoryEnabled) => patch({ memoryEnabled })}
              />
            </label>
          </TabsPanel>

          <TabsPanel value="memory">
            <MemorySpaceList spaceId={`bot:${bot.id}`} emptyText={t('No memories yet')} />
          </TabsPanel>

          <TabsPanel value="routines">
            <RoutineList botId={bot.id} />
          </TabsPanel>

          <TabsPanel value="history">
            <SessionList chat={chat} botId={bot.id} onOpen={(id) => onOpenHistory(id, bot.name)} />
          </TabsPanel>
        </div>
      </Tabs>

      {dirty && (
        <div className="flex shrink-0 justify-end gap-2 border-t bg-muted/50 px-4 py-2.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (baseline) setForm(baseline);
              setEdited(false);
            }}
          >
            {t('Discard')}
          </Button>
          <Button size="sm" disabled={saving || Boolean(nameIssue)} onClick={() => void save()}>
            {saving && <Loader2 className="animate-spin" />}
            {t('Save')}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={
          confirm === 'delete'
            ? t('Delete {{name}}?', { name: bot.name })
            : t('Archive {{name}}?', { name: bot.name })
        }
        description={
          confirm === 'delete'
            ? t(
                'The member, their private chats, persona, memories and workspace are deleted. This cannot be undone.'
              )
            : t(
                'Archived members stop replying and are hidden from the list. You can restore them later.'
              )
        }
        confirmLabel={confirm === 'delete' ? t('Delete permanently') : t('Archive member')}
        onConfirm={() => void runDanger()}
      />
    </div>
  );
}

function AssetPickers({
  form,
  patch,
}: {
  form: FormState;
  patch: (next: Partial<FormState>) => void;
}) {
  const { t } = useI18n();
  const skills = useSettingsStore((s) => s.skills);
  const mcpServers = useSettingsStore((s) => s.mcpServers);
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
  return (
    <>
      <PickList
        title={t('Skills')}
        emptyText={t('No skills yet')}
        items={skills}
        getName={(skill) => skill.name}
        getSource={(skill) => skill.source}
        isChecked={(skill) => form.skillIds.includes(skill.id)}
        onToggle={(skill) => patch({ skillIds: toggle(form.skillIds, skill.id) })}
        onSetFiltered={(ids, selected) =>
          patch({ skillIds: setFilteredIds(form.skillIds, ids, selected) })
        }
        placeholder={t('Filter skills...')}
        renderDetail={(skill) => (
          <DetailRows
            rows={[
              [t('Source'), skill.source],
              [t('Path'), skill.path],
              [t('Description'), skill.description],
            ]}
          />
        )}
      />
      <PickList
        title={t('MCP Servers')}
        emptyText={t('No MCP servers yet')}
        items={mcpServers}
        getName={(server) => server.name}
        getSource={(server) => server.source}
        isChecked={(server) => form.mcpServerIds.includes(server.id)}
        onToggle={(server) => patch({ mcpServerIds: toggle(form.mcpServerIds, server.id) })}
        onSetFiltered={(ids, selected) =>
          patch({ mcpServerIds: setFilteredIds(form.mcpServerIds, ids, selected) })
        }
        placeholder={t('Filter MCP servers...')}
        renderDetail={(server) => (
          <DetailRows
            rows={[
              [t('Source'), server.source],
              ['Transport', server.transport],
              ['URL', server.url],
            ]}
          />
        )}
      />
    </>
  );
}

function DelegationField({
  label,
  value,
  bots,
  onChange,
}: {
  label: string;
  value: BotList;
  bots: BotProfile[];
  onChange: (value: BotList) => void;
}) {
  const { t } = useI18n();
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <Segmented
        value={value === 'any' ? 'any' : 'some'}
        options={[
          { value: 'any', label: t('All members') },
          { value: 'some', label: t('Selected members') },
        ]}
        onChange={(mode) => onChange(mode === 'any' ? 'any' : [])}
      />
      {value !== 'any' && (
        <div className="mt-1.5 space-y-1">
          {bots.length === 0 && (
            <p className="text-muted-foreground text-xs">{t('No other members')}</p>
          )}
          {bots.map((bot) => (
            <label key={bot.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={value.includes(bot.id)}
                onCheckedChange={(checked) =>
                  onChange(checked ? [...value, bot.id] : value.filter((id) => id !== bot.id))
                }
              />
              <BotAvatar bot={bot} size="xs" />
              {bot.name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

type RoutinesApi = {
  routines?: (
    botId: string
  ) => Promise<{ ok: true; routines: BotRoutine[] } | { ok: false; error: string }>;
};

/** 例行任务：Main 侧接口就绪前显示「即将推出」 */
function RoutineList({ botId }: { botId: string }) {
  const { t, locale } = useI18n();
  const chats = useBotsStore((s) => s.chats);
  const bots = useBotsStore((s) => s.bots);
  const api = (window.electronAPI.bots as RoutinesApi).routines;
  const [routines, setRoutines] = useState<BotRoutine[] | null>(null);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    void api(botId).then((result) => alive && setRoutines(result.ok ? result.routines : []));
    return () => {
      alive = false;
    };
  }, [api, botId]);

  if (!api)
    return <p className="text-muted-foreground text-xs">{t('Routines are coming soon.')}</p>;
  if (routines === null) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  if (routines.length === 0)
    return <p className="text-muted-foreground text-xs">{t('No routines yet')}</p>;
  return (
    <div className="space-y-1.5">
      {routines.map((routine) => {
        const chat = chats.find((item) => item.id === routine.chatId);
        return (
          <div key={routine.id} className="rounded-lg border bg-card px-2.5 py-2 text-xs">
            <div className="font-medium">
              {describeCron(routine.schedule, locale === 'zh' ? 'zh' : 'en')} · {routine.title}
            </div>
            <div className="text-muted-foreground">
              {chat ? t('Posts to {{chat}}', { chat: chatTitle(chat, bots, t) }) : ''}
              {routine.lastRunAt ? ` · ${new Date(routine.lastRunAt).toLocaleDateString()}` : ''}
              {!routine.enabled ? ` · ${t('Paused')}` : ''}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SessionList({
  chat,
  botId,
  onOpen,
}: {
  chat: BotChat;
  botId: string;
  onOpen: (conversationId: string) => void;
}) {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<BotSessionRecord[] | null>(null);
  useEffect(() => {
    let alive = true;
    void window.electronAPI.bots.chatSessions(chat.id).then((result) => {
      if (alive)
        setSessions(result.ok ? result.sessions.filter((item) => item.botId === botId) : []);
    });
    return () => {
      alive = false;
    };
  }, [chat.id, botId]);
  if (sessions === null) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  if (sessions.length === 0)
    return <p className="text-muted-foreground text-xs">{t('No conversations yet')}</p>;
  return (
    <div className="space-y-1">
      {sessions.map((session, index) => (
        <button
          key={session.conversationId}
          type="button"
          onClick={() => onOpen(session.conversationId)}
          className="flex w-full items-center justify-between rounded-lg border bg-card px-2.5 py-2 text-left text-xs hover:bg-muted"
        >
          <span>{t('Conversation {{n}}', { n: sessions.length - index })}</span>
          <span className="text-muted-foreground">
            {session.current ? t('Current') : t('Read-only')}
          </span>
        </button>
      ))}
    </div>
  );
}
