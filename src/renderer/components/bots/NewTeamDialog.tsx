import {
  selectTeamMembers,
  type TeamFileError,
  type TeamRename,
  type TeamSpec,
} from '@shared/bots/team';
import { ArrowLeft, Crown, FileJson, Info, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { APPROVAL_MODE_META } from '@/components/chat/ApprovalModePicker';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { type TFunction, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';
import { useBotsStore } from '@/stores/bots';
import { TEAM_TEMPLATES, teamTemplateSpec } from '@/stores/bots/teamTemplates';
import { useSettingsStore } from '@/stores/settings';
import { BotAvatar } from './BotAvatar';
import { FieldLabel, nameError } from './BotFields';
import { botErrorText, chatErrorText, localProjects } from './botText';

interface Preview {
  team: TeamSpec;
  renamed: TeamRename[];
  picked: string[];
}

function teamFileErrorText(error: TeamFileError | string, t: TFunction): string {
  switch (error) {
    case 'too-large':
      return t('This team file is too large.');
    case 'invalid-json':
      return t('This file is not valid JSON.');
    case 'unsupported-version':
      return t('This team file comes from an unsupported version.');
    case 'invalid':
      return t('This file is not a valid EnsoCode team file.');
    default:
      return error;
  }
}

/** 从内置模板或团队文件创建：预览成员（可取消、改名）→ Main 原子创建成员与群 */
export function NewTeamDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const bots = useBotsStore((s) => s.bots);
  const projects = localProjects(useSettingsStore((s) => s.projects));
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [workspace, setWorkspace] = useState<'project' | 'chat-home'>('chat-home');
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 每次打开重置
  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setProjectId(projects[0]?.id ?? '');
    setBusy(false);
    setError(null);
  }, [open]);

  const load = async (request: { team: TeamSpec } | { text: string }) => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.bots.previewTeam(request);
      if (!result.ok) {
        setError(teamFileErrorText(result.error, t));
        return;
      }
      setPreview({
        team: result.team,
        renamed: result.renamed,
        picked: result.team.members.map((member) => member.key),
      });
      setWorkspace(
        result.team.workspace === 'project' && projects.length > 0 ? 'project' : 'chat-home'
      );
    } finally {
      setBusy(false);
    }
  };

  const patchTeam = (patch: (team: TeamSpec) => TeamSpec) =>
    setPreview((current) => (current ? { ...current, team: patch(current.team) } : current));

  const picked = useMemo(
    () => (preview ? selectTeamMembers(preview.team, preview.picked) : null),
    [preview]
  );
  const nameIssues = useMemo(() => {
    const issues = new Map<string, string>();
    if (!picked) return issues;
    const others = [
      ...bots,
      ...picked.members.map((member) => ({ id: `team:${member.key}`, name: member.name })),
    ];
    for (const member of picked.members) {
      const issue = nameError(member.name, others, t, `team:${member.key}`);
      if (issue) issues.set(member.key, issue);
    }
    return issues;
  }, [picked, bots, t]);

  const canCreate =
    picked !== null &&
    nameIssues.size === 0 &&
    (workspace === 'chat-home' || Boolean(projectId)) &&
    !busy;

  const create = async () => {
    if (!picked || !canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.bots.createTeam({
        team: { ...picked, title: picked.title.trim() },
        workspace: workspace === 'project' ? { kind: 'project', projectId } : { kind: 'chat-home' },
      });
      if (!result.ok) {
        setError(botErrorText(result.error, chatErrorText(result.error, t), t));
        return;
      }
      const store = useBotsStore.getState();
      for (const bot of result.bots) store.upsertBot(bot);
      store.upsertChat(result.chat);
      store.setView({ kind: 'chat', chatId: result.chat.id });
      void store.loadLatest(result.chat.id);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  const lang = locale === 'zh' ? 'zh' : 'en';
  const nameOf = (key: string) => preview?.team.members.find((m) => m.key === key)?.name ?? key;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('Create team from template')}</DialogTitle>
          <DialogDescription>
            {t(
              'Creates the members and their group chat in one go. Members follow the default model; skills and MCP are not preset.'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {!preview ? (
            <>
              <div className="grid grid-cols-3 gap-2.5">
                {TEAM_TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    disabled={busy}
                    onClick={() => void load({ team: teamTemplateSpec(template, lang) })}
                    className="flex flex-col items-start gap-1.5 rounded-xl border bg-card p-3 text-left transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    <div className="-space-x-1.5 flex">
                      {template.members.map((member) => (
                        <BotAvatar
                          key={member.key}
                          size="sm"
                          bot={{ name: member[lang].name, avatar: { color: member.color } }}
                        />
                      ))}
                    </div>
                    <span className="font-medium text-sm">{template[lang].title}</span>
                    <span className="text-muted-foreground text-xs">{template[lang].summary}</span>
                  </button>
                ))}
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
                <FileJson />
                {t('Import team (JSON)')}
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void file.text().then((text) => load({ text }));
                }}
              />
            </>
          ) : (
            <>
              <div>
                <FieldLabel>{t('Group name')}</FieldLabel>
                <Input
                  value={preview.team.title}
                  onChange={(event) => {
                    const title = event.target.value;
                    patchTeam((team) => ({ ...team, title }));
                  }}
                />
              </div>

              <div>
                <FieldLabel hint={t('Uncheck members you do not need; the owner stays')}>
                  {t('Members')}
                </FieldLabel>
                <div className="space-y-1">
                  {preview.team.members.map((member) => {
                    const checked = preview.picked.includes(member.key);
                    const boss = member.key === preview.team.bossKey;
                    const renamed = preview.renamed.find((item) => item.key === member.key);
                    const issue = checked ? nameIssues.get(member.key) : undefined;
                    const targets = member.delegation.canDelegateTo;
                    const shown =
                      targets === 'any'
                        ? []
                        : targets.filter((key) => preview.picked.includes(key));
                    return (
                      <div
                        key={member.key}
                        className={cn(
                          'flex items-start gap-2.5 rounded-lg border px-2.5 py-2',
                          !checked && 'opacity-60'
                        )}
                      >
                        <Checkbox
                          className="mt-1.5"
                          checked={checked}
                          disabled={boss}
                          onCheckedChange={(value) =>
                            setPreview({
                              ...preview,
                              picked:
                                value === true
                                  ? [...preview.picked, member.key]
                                  : preview.picked.filter((key) => key !== member.key),
                            })
                          }
                        />
                        <BotAvatar bot={member} size="sm" />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center gap-2">
                            <Input
                              className="h-7 w-36"
                              value={member.name}
                              disabled={!checked}
                              onChange={(event) => {
                                const name = event.target.value;
                                patchTeam((team) => ({
                                  ...team,
                                  members: team.members.map((m) =>
                                    m.key === member.key ? { ...m, name } : m
                                  ),
                                }));
                              }}
                            />
                            <span className="truncate text-muted-foreground text-xs">
                              {member.title}
                            </span>
                            {boss && (
                              <span className="flex shrink-0 items-center gap-0.5 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
                                <Crown className="h-3 w-3" />
                                {t('Owner')}
                              </span>
                            )}
                          </div>
                          <p className="text-muted-foreground text-xs">{member.scope}</p>
                          <p className="text-[11px] text-muted-foreground/80">
                            {member.tools === 'readonly' ? t('Read-only') : t('All tools')} ·{' '}
                            {t(APPROVAL_MODE_META[member.approvalMode].labelKey)}
                            {shown.length > 0 && (
                              <>
                                {' · '}
                                {t('Delegates to {{names}}', {
                                  names: shown.map(nameOf).join(lang === 'zh' ? '、' : ', '),
                                })}
                              </>
                            )}
                          </p>
                          {renamed && renamed.to === member.name && (
                            <p className="text-warning text-xs">
                              {t('"{{from}}" is taken, renamed to "{{to}}"', renamed)}
                            </p>
                          )}
                          {issue && <p className="text-destructive text-xs">{issue}</p>}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {!picked && (
                  <p className="mt-1 text-destructive text-xs">
                    {t('Keep the owner and at least one other member.')}
                  </p>
                )}
              </div>

              <div>
                <FieldLabel>{t('Shared workspace')}</FieldLabel>
                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => setWorkspace('chat-home')}
                    className={cn(
                      'rounded-xl border bg-card p-3 text-left',
                      workspace === 'chat-home' && 'ring-2 ring-info'
                    )}
                  >
                    <div className="font-medium text-sm">{t('Standalone workspace')}</div>
                    <div className="mt-0.5 text-muted-foreground text-xs">
                      {t('A new empty folder for this group, removed with the group')}
                    </div>
                  </button>
                  <button
                    type="button"
                    disabled={projects.length === 0}
                    onClick={() => setWorkspace('project')}
                    className={cn(
                      'rounded-xl border bg-card p-3 text-left disabled:opacity-50',
                      workspace === 'project' && 'ring-2 ring-info'
                    )}
                  >
                    <div className="font-medium text-sm">{t('Based on a Code project')}</div>
                    <div className="mt-0.5 text-muted-foreground text-xs">
                      {t('Members read and write directly in the project folder')}
                    </div>
                  </button>
                </div>
                {workspace === 'project' && projects.length > 0 && (
                  <Select
                    items={projects.map((project) => ({
                      value: project.id,
                      label: project.alias || project.name,
                    }))}
                    value={projectId}
                    onValueChange={(value) => setProjectId(value as string)}
                  >
                    <SelectTrigger className="mt-2 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          <div>
                            <div>{project.alias || project.name}</div>
                            <div className="text-muted-foreground text-xs">{project.path}</div>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                )}
                <div className="mt-2 flex gap-2 rounded-lg border border-info/40 bg-info/8 px-3 py-2 text-xs">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
                  <span>
                    {t(
                      preview.team.routing.mode === 'smart'
                        ? 'Without @, the best-fit member replies; @ relay limit {{n}}.'
                        : 'Without @, the owner replies; @ relay limit {{n}}.',
                      { n: preview.team.routing.maxHops }
                    )}
                  </span>
                </div>
              </div>
            </>
          )}
          {error && <p className="text-destructive text-sm">{error}</p>}
        </DialogPanel>
        <DialogFooter>
          {preview && (
            <Button
              variant="ghost"
              size="sm"
              className="mr-auto"
              onClick={() => {
                setPreview(null);
                setError(null);
              }}
            >
              <ArrowLeft />
              {t('Back')}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          {preview && (
            <Button size="sm" disabled={!canCreate} onClick={() => void create()}>
              {busy && <Loader2 className="animate-spin" />}
              {t('Create team')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
