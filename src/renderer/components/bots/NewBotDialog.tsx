import type { BotEngine } from '@shared/types/bot';
import { ChevronRight, FileJson, Loader2, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';
import { useBotsStore } from '@/stores/bots';
import { budgetDraft, limitsDraft } from '@/stores/bots/budget';
import { parseCharacterCard } from '@/stores/bots/characterCard';
import { BOT_TEMPLATES, type BotTemplate, templateDraft } from '@/stores/bots/templates';
import { type AbilityForm, BotAbilityFields, DEFAULT_ABILITIES } from './BotAbilities';
import { BotAvatar } from './BotAvatar';
import { AVATAR_PALETTE, ColorPicker, EngineField, FieldLabel, nameError } from './BotFields';
import { botErrorText } from './botText';
import { PersonaSuggestButton } from './PersonaSuggest';

interface Draft extends AbilityForm {
  name: string;
  title: string;
  scope: string;
  persona: string;
  color: string;
  engine: BotEngine | null;
}

type Source = { kind: 'template'; id: BotTemplate['id'] } | { kind: 'blank' } | { kind: 'import' };

const blankDraft = (color: string): Draft => ({
  ...DEFAULT_ABILITIES,
  name: '',
  title: '',
  scope: '',
  persona: '',
  color,
  engine: null,
});

export function NewBotDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const bots = useBotsStore((s) => s.bots);
  const fileRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<Source>({ kind: 'template', id: 'pm' });
  const [draft, setDraft] = useState<Draft>(() => blankDraft(AVATAR_PALETTE[0]));
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [abilitiesOpen, setAbilitiesOpen] = useState(false);

  const applyTemplate = (template: BotTemplate) => {
    const input = templateDraft(template, locale === 'zh' ? 'zh' : 'en');
    setSource({ kind: 'template', id: template.id });
    setDraft({
      ...DEFAULT_ABILITIES,
      name: input.name ?? '',
      title: input.title ?? '',
      scope: input.scope ?? '',
      persona: input.persona ?? '',
      color: input.avatar?.color ?? AVATAR_PALETTE[0],
      engine: null,
      approvalMode: input.approvalMode ?? 'auto-edits',
      tools: input.tools ?? 'all',
    });
    setError(null);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: 每次打开重置
  useEffect(() => {
    if (!open) return;
    applyTemplate(BOT_TEMPLATES[0]);
    setTouched(false);
    setBusy(false);
    setAbilitiesOpen(false);
  }, [open]);

  const patch = (next: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setError(null);
  };

  const importCard = async (file: File) => {
    const result = parseCharacterCard(await file.text());
    if (!result.ok) {
      setError(
        result.error === 'invalid-json'
          ? t('This file is not valid JSON.')
          : t('This file is not a SillyTavern character card.')
      );
      return;
    }
    setSource({ kind: 'import' });
    setDraft({ ...blankDraft(draft.color), ...result.draft });
    setTouched(true);
    setError(null);
  };

  const nameIssue = nameError(draft.name, bots, t);

  const create = async () => {
    setTouched(true);
    if (nameIssue) return;
    const budget = budgetDraft(draft);
    if (!budget.ok) {
      setError(t('Budget must be a positive number'));
      return;
    }
    const limits = limitsDraft(draft);
    if (!limits.ok) {
      setError(t('Delegation time limit must be 1–1440 whole minutes'));
      return;
    }
    setBusy(true);
    try {
      const result = await window.electronAPI.bots.create({
        name: draft.name.trim(),
        title: draft.title.trim(),
        scope: draft.scope.trim(),
        ...(limits.delegationTimeoutMinutes
          ? { delegationTimeoutMinutes: limits.delegationTimeoutMinutes }
          : {}),
        persona: draft.persona,
        avatar: { color: draft.color },
        engine: draft.engine,
        approvalMode: draft.approvalMode,
        tools: draft.tools,
        skillIds: draft.skillIds,
        mcpServerIds: draft.mcpServerIds,
        delegation: { canDelegateTo: draft.canDelegateTo, acceptFrom: draft.acceptFrom },
        memory: { enabled: draft.memoryEnabled },
        ...(budget.budget ? { budget: budget.budget } : {}),
      });
      if (!result.ok) {
        setError(botErrorText(result.reason, result.error, t));
        return;
      }
      useBotsStore.getState().upsertBot(result.bot);
      onOpenChange(false);
      await useBotsStore.getState().openDirect(result.bot.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('New member')}</DialogTitle>
          <DialogDescription>
            {t(
              'Members have their own persona, model, tools and memory. Their name is how you @ them in groups.'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={source.kind === 'template' ? 'default' : 'outline'}
              onClick={() => applyTemplate(BOT_TEMPLATES[0])}
            >
              {t('From template')}
            </Button>
            <Button
              size="sm"
              variant={source.kind === 'blank' ? 'default' : 'outline'}
              onClick={() => {
                setSource({ kind: 'blank' });
                setDraft(blankDraft(AVATAR_PALETTE[bots.length % AVATAR_PALETTE.length]));
                setError(null);
              }}
            >
              {t('Blank')}
            </Button>
            <Button
              size="sm"
              variant={source.kind === 'import' ? 'default' : 'outline'}
              onClick={() => fileRef.current?.click()}
            >
              <FileJson />
              {t('Import character card (JSON)')}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void importCard(file);
              }}
            />
          </div>

          {source.kind === 'template' && (
            <div className="grid grid-cols-3 gap-2.5">
              {BOT_TEMPLATES.map((template) => {
                const text = template[locale === 'zh' ? 'zh' : 'en'];
                return (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => applyTemplate(template)}
                    className={cn(
                      'flex flex-col items-start gap-1 rounded-xl border bg-card p-3 text-left transition-colors hover:bg-muted',
                      source.id === template.id && 'ring-2 ring-info'
                    )}
                  >
                    <BotAvatar bot={{ name: text.title, avatar: { color: template.color } }} />
                    <span className="font-medium text-sm">{text.title}</span>
                    <span className="text-muted-foreground text-xs">{text.summary}</span>
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => {
                  setSource({ kind: 'blank' });
                  setDraft(blankDraft(AVATAR_PALETTE[bots.length % AVATAR_PALETTE.length]));
                }}
                className="flex items-center justify-center gap-1 rounded-xl border border-dashed p-3 text-muted-foreground text-sm hover:bg-muted"
              >
                <Plus className="h-4 w-4" />
                {t('Blank member')}
              </button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel hint={t('Used for @ in groups; must be unique')}>{t('Name')}</FieldLabel>
              <Input
                value={draft.name}
                onChange={(event) => patch({ name: event.target.value })}
                onBlur={() => setTouched(true)}
              />
              {touched && nameIssue && <p className="mt-1 text-destructive text-xs">{nameIssue}</p>}
            </div>
            <div>
              <FieldLabel>{t('Title')}</FieldLabel>
              <Input
                value={draft.title}
                onChange={(event) => patch({ title: event.target.value })}
              />
            </div>
            <div>
              <FieldLabel>{t('Model')}</FieldLabel>
              <EngineField
                engine={draft.engine}
                onChange={(engine) => patch({ engine })}
                zIndex={Z_INDEX.DROPDOWN_IN_MODAL}
              />
            </div>
            <div>
              <FieldLabel>{t('Avatar color')}</FieldLabel>
              <ColorPicker value={draft.color} onChange={(color) => patch({ color })} />
            </div>
            <div className="col-span-2">
              <FieldLabel hint={t('Used for routing and the delegation directory')}>
                {t('Responsibilities')}
              </FieldLabel>
              <Input
                value={draft.scope}
                onChange={(event) => patch({ scope: event.target.value })}
              />
            </div>
            <div className="col-span-2">
              <FieldLabel action={<PersonaSuggestButton value={draft} onApply={patch} />}>
                {t('Persona')}
              </FieldLabel>
              <Textarea
                rows={4}
                value={draft.persona}
                onChange={(event) => patch({ persona: event.target.value })}
              />
            </div>
            <div className="col-span-2 rounded-lg border">
              <button
                type="button"
                className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm"
                aria-expanded={abilitiesOpen}
                onClick={() => setAbilitiesOpen((value) => !value)}
              >
                <ChevronRight
                  className={cn('h-4 w-4 transition-transform', abilitiesOpen && 'rotate-90')}
                />
                <span className="font-medium">{t('Abilities')}</span>
                <span className="truncate text-muted-foreground text-xs">
                  {t('Tools, approval, skills, MCP, delegation and memory')}
                </span>
              </button>
              {abilitiesOpen && (
                <div className="border-t px-3 py-3">
                  <BotAbilityFields
                    value={draft}
                    onChange={patch}
                    profile={draft}
                    zIndex={Z_INDEX.DROPDOWN_IN_MODAL}
                  />
                </div>
              )}
            </div>
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          <Button
            size="sm"
            disabled={busy || (touched && Boolean(nameIssue))}
            onClick={() => void create()}
          >
            {busy && <Loader2 className="animate-spin" />}
            {t('Create and start chatting')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
