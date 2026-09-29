import {
  type CharacterCardData,
  type CharacterRole,
  EMPTY_PERSONA,
  EMPTY_ROLE,
} from '@shared/characterCard';
import { resolveEnsobotModel } from '@shared/defaultModel';
import { BUILTIN_TOOLS } from '@shared/types';
import { Check, Download, ImagePlus, Save, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useOauthCredentialStore } from '@/stores/oauthCredentials';
import { useSettingsStore } from '@/stores/settings';
import { BotSelect, CirclePhoto } from './EnsobotPrimitives';
import { normalizeRole, placeCrop } from './ensobotView';
import type { CardDetails } from './useEnsobot';

export function CharacterCardDialog({
  summary,
  onClose,
  onChanged,
  onRemoved,
}: {
  summary: CardDetails['cards'][number];
  onClose: () => void;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const { t } = useI18n();
  const providers = useSettingsStore((state) => state.providers);
  const defaultModel = useSettingsStore((state) => state.defaultModel);
  const oauth = useOauthCredentialStore((state) => state.snapshot.availability);
  const [persona, setPersona] = useState(summary.card?.persona ?? { ...EMPTY_PERSONA });
  const [role, setRole] = useState(summary.card?.role ?? { ...EMPTY_ROLE });
  const [crop, setCrop] = useState(summary.card?.crop ?? null);
  const [tab, setTab] = useState<'persona' | 'role'>('persona');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { width, height } = summary;
  const provider = providers.find((item) => item.id === role.providerId);
  const decision = resolveEnsobotModel({
    cardModel:
      role.providerId && role.modelId
        ? { providerId: role.providerId, modelId: role.modelId }
        : null,
    defaultModel,
    providers,
    credentials: { oauthCredentials: oauth },
  });
  const draft = (): CharacterCardData => ({
    id: summary.id,
    ...(summary.card?.originId ? { originId: summary.card.originId } : {}),
    persona,
    role: normalizeRole(role),
    crop: width > 0 && height > 0 ? placeCrop(crop, width, height, {}) : crop,
  });
  const save = async (exportAfter = false) => {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const result = await window.electronAPI.ensobot.updateCard(summary.id, draft());
      if (!result.ok) {
        setError(result.error ?? t('Failed'));
        return;
      }
      onChanged();
      setSaved(true);
      if (exportAfter) {
        const exported = await window.electronAPI.ensobot.exportCard(summary.id);
        if (!exported.ok && exported.error !== 'cancelled') setError(exported.error ?? t('Failed'));
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup
        className="w-[min(880px,calc(100vw-40px))] max-w-none"
        data-slot="ensobot-profile"
      >
        <DialogHeader>
          <DialogTitle>{t('Character card')}</DialogTitle>
          <DialogDescription>
            {t('A personality to talk to. A role to work with.')}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[67vh]">
          <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-7 max-[700px]:grid-cols-1">
            <div className="min-w-0">
              <div className="mb-4 flex items-center gap-3">
                <CirclePhoto
                  src={summary.previewUrl}
                  crop={crop}
                  width={width}
                  height={height}
                  size={52}
                  alt={persona.name || t('Bot')}
                />
                <div className="min-w-0">
                  <p className="truncate font-medium">{persona.name || t('New bot')}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t('Avatar preview')}</p>
                </div>
              </div>
              <div className="overflow-hidden rounded-xl border bg-muted">
                <button
                  type="button"
                  aria-label={t('Choose avatar crop')}
                  className="relative block w-full overflow-hidden focus-visible:outline-2 focus-visible:outline-ring"
                  style={{ aspectRatio: `${Math.max(width, 1)} / ${Math.max(height, 1)}` }}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setCrop(
                      placeCrop(crop, width, height, {
                        cx: ((event.clientX - rect.left) / rect.width) * width,
                        cy: ((event.clientY - rect.top) / rect.height) * height,
                      })
                    );
                    setSaved(false);
                  }}
                >
                  <img
                    alt={t('Character picture')}
                    src={summary.previewUrl}
                    className="absolute inset-0 h-full w-full object-contain"
                  />
                  {crop ? (
                    <span
                      className="pointer-events-none absolute rounded-full border-2 border-primary outline outline-1 outline-background"
                      style={{
                        left: `${((crop.cx - crop.r) / width) * 100}%`,
                        top: `${((crop.cy - crop.r) / height) * 100}%`,
                        width: `${((crop.r * 2) / width) * 100}%`,
                        height: `${((crop.r * 2) / height) * 100}%`,
                      }}
                    />
                  ) : null}
                </button>
              </div>
              <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                <ImagePlus className="size-3.5" />
                {t('Click the picture to position the avatar.')}
              </p>
              {(['cx', 'cy', 'r'] as const).map((axis) => {
                const current = placeCrop(crop, width, height, {});
                return (
                  <label
                    key={axis}
                    className="mt-3 flex items-center gap-3 text-xs text-muted-foreground"
                  >
                    <span className="w-12">
                      {t(axis === 'cx' ? 'Horizontal' : axis === 'cy' ? 'Vertical' : 'Radius')}
                    </span>
                    <input
                      type="range"
                      className="min-w-0 flex-1 accent-primary"
                      min={axis === 'r' ? 1 : current.r}
                      max={
                        axis === 'r'
                          ? Math.min(width, height) / 2
                          : (axis === 'cx' ? width : height) - current.r
                      }
                      value={current[axis]}
                      onChange={(event) => {
                        setCrop(
                          placeCrop(crop, width, height, { [axis]: Number(event.target.value) })
                        );
                        setSaved(false);
                      }}
                    />
                  </label>
                );
              })}
              <p className="mt-4 text-[11px] leading-5 text-muted-foreground">
                {t('Circle crop uses source pixels. The file keeps the whole picture.')}
              </p>
            </div>
            <div className="min-w-0" onChangeCapture={() => setSaved(false)}>
              <div
                role="group"
                className="mb-5 flex gap-1 rounded-lg bg-muted p-1"
                aria-label={t('Card sections')}
              >
                {(
                  [
                    { id: 'persona', label: 'Persona', icon: UserRound },
                    { id: 'role', label: 'Duties & permissions', icon: ShieldCheck },
                  ] as const
                ).map(({ id, label, icon: Icon }) => (
                  <Button
                    key={id}
                    variant="ghost"
                    className={cn('flex-1', tab === id && 'bg-background shadow-xs')}
                    aria-pressed={tab === id}
                    onClick={() => setTab(id)}
                  >
                    <Icon className="size-4" />
                    {t(label)}
                  </Button>
                ))}
              </div>
              {tab === 'persona' ? (
                <section data-slot="ensobot-persona" className="space-y-4">
                  <FormField label={t('Name')}>
                    <input
                      className="ensobot-input"
                      value={persona.name}
                      maxLength={8000}
                      placeholder={t('Give your bot a name')}
                      onChange={(event) => setPersona({ ...persona, name: event.target.value })}
                    />
                  </FormField>
                  <FormField
                    label={t('Personality')}
                    hint={t('How they think, speak and collaborate.')}
                  >
                    <textarea
                      className="ensobot-input"
                      rows={4}
                      maxLength={8000}
                      value={persona.personality}
                      placeholder={t('Calm and precise, asks questions before making assumptions…')}
                      onChange={(event) =>
                        setPersona({ ...persona, personality: event.target.value })
                      }
                    />
                  </FormField>
                  <FormField
                    label={t('Character setting')}
                    hint={t('Their background, perspective and relationship with the team.')}
                  >
                    <textarea
                      className="ensobot-input"
                      rows={5}
                      maxLength={8000}
                      value={persona.setting}
                      onChange={(event) => setPersona({ ...persona, setting: event.target.value })}
                    />
                  </FormField>
                </section>
              ) : (
                <section data-slot="ensobot-role" className="space-y-4">
                  <FormField
                    label={t('Duty')}
                    hint={t(
                      'Developer, designer, architect or team lead — define their responsibility.'
                    )}
                  >
                    <textarea
                      className="ensobot-input"
                      rows={3}
                      maxLength={8000}
                      value={role.duty}
                      onChange={(event) => setRole({ ...role, duty: event.target.value })}
                    />
                  </FormField>
                  <div className="grid grid-cols-2 gap-3">
                    <BotSelect
                      label={t('Provider')}
                      value={role.providerId}
                      items={[
                        { value: '', label: t('Use the default model') },
                        ...providers.map((item) => ({
                          value: item.id,
                          label: item.name || item.id,
                        })),
                        ...(!provider && role.providerId
                          ? [{ value: role.providerId, label: role.providerId }]
                          : []),
                      ]}
                      onChange={(value) => {
                        setRole({ ...role, providerId: value, modelId: '' });
                        setSaved(false);
                      }}
                    />
                    <BotSelect
                      label={t('Model')}
                      value={role.modelId}
                      items={[
                        { value: '', label: t('Use the default model') },
                        ...(provider?.models ?? []).map((model) => ({
                          value: model.id,
                          label: model.label || model.id,
                        })),
                        ...(role.modelId &&
                        !provider?.models.some((model) => model.id === role.modelId)
                          ? [{ value: role.modelId, label: role.modelId }]
                          : []),
                      ]}
                      onChange={(value) => {
                        setRole({ ...role, modelId: value });
                        setSaved(false);
                      }}
                    />
                  </div>
                  <p
                    data-slot="ensobot-model"
                    className="rounded-lg bg-muted p-2.5 text-xs leading-5 text-muted-foreground"
                  >
                    {decision.kind === 'card'
                      ? t('Using the card model')
                      : decision.kind === 'default'
                        ? t('Card model is missing, so this falls back to the default')
                        : decision.kind === 'oauth-blocked'
                          ? decision.reason
                          : t('No usable model')}
                  </p>
                  <div className="grid grid-cols-[1fr_110px] gap-3">
                    <BotSelect
                      label={t('Permissions')}
                      value={role.approvalScope}
                      items={(['supervised', 'auto-edits', 'full', 'assistant'] as const).map(
                        (id, i) => ({
                          value: id,
                          label: t(
                            ['Supervised', 'Auto-accept edits', 'Full access', 'Assistant'][i]
                          ),
                        })
                      )}
                      onChange={(value) => {
                        setRole({
                          ...role,
                          approvalScope: value as CharacterRole['approvalScope'],
                        });
                        setSaved(false);
                      }}
                    />
                    <FormField label={t('Concurrency')}>
                      <input
                        className="ensobot-input"
                        type="number"
                        min={1}
                        max={32}
                        value={role.concurrency}
                        onChange={(event) =>
                          setRole({ ...role, concurrency: Number(event.target.value) || 1 })
                        }
                      />
                    </FormField>
                  </div>
                  <label className="flex items-start gap-2 rounded-lg border p-3 text-xs leading-5">
                    <input
                      className="mt-1 accent-primary"
                      type="checkbox"
                      checked={role.coordinator}
                      onChange={(event) => setRole({ ...role, coordinator: event.target.checked })}
                    />
                    {t('Coordinator: assign work, do not edit the shared workspace')}
                  </label>
                  <fieldset className="rounded-lg border p-3">
                    <legend className="px-1 text-xs font-medium">{t('Available tools')}</legend>
                    <p className="mb-2 text-[11px] text-muted-foreground">
                      {t('No selection follows EnsoCode tool settings.')}
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      {BUILTIN_TOOLS.map((tool) => (
                        <label key={tool.id} className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            className="accent-primary"
                            checked={role.toolIds.includes(tool.id)}
                            onChange={(event) =>
                              setRole({
                                ...role,
                                toolIds: event.target.checked
                                  ? [...role.toolIds, tool.id]
                                  : role.toolIds.filter((id) => id !== tool.id),
                              })
                            }
                          />
                          {t(tool.name)}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </section>
              )}
            </div>
          </div>
          {error ? (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {confirmDelete ? (
            <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <p className="mb-3 text-sm text-destructive">
                {t(
                  'Delete this character card from this node? Export a copy first if you want to keep it.'
                )}
              </p>
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const result = await window.electronAPI.ensobot.deleteCard(summary.id);
                    if (!result.ok) setError(result.error ?? t('Failed'));
                    else onRemoved();
                  } catch (reason) {
                    setError(String(reason));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t('Delete card')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                {t('Cancel')}
              </Button>
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
          >
            <Trash2 className="size-3.5" />
            {t('Delete card')}
          </Button>
          <div className="flex items-center gap-2">
            {saved ? (
              <span role="status" className="mr-2 flex items-center gap-1 text-xs text-success">
                <Check className="size-3.5" />
                {t('Saved')}
              </span>
            ) : null}
            <Button variant="outline" disabled={busy} onClick={() => void save(true)}>
              <Download className="size-4" />
              {t('Export PNG')}
            </Button>
            <Button disabled={busy} onClick={() => void save()}>
              <Save className="size-4" />
              {t('Save card')}
            </Button>
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function FormField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium">
      <span>{label}</span>
      {hint ? <span className="font-normal leading-5 text-muted-foreground">{hint}</span> : null}
      {children}
    </label>
  );
}
