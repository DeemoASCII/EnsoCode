import type { EnsobotSnapshot } from '@shared/ensobot/snapshot';
import { projectDisplayName } from '@shared/projectName';
import { CheckCheck, FolderOpen, Layers3, ListTodo, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
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
import { useRemoteNodesStore } from '@/stores/remoteNodes';
import { useSettingsStore } from '@/stores/settings';
import { BotSelect, CirclePhoto, EmptyState, SurfaceHeader, TaskStatus } from './EnsobotPrimitives';
import { parseWorkspaceSessions } from './ensobotView';
import { runCommand } from './useEnsobot';

export function EnsobotWorkspace({ snapshot }: { snapshot: EnsobotSnapshot }) {
  const { t } = useI18n();
  const [taskOpen, setTaskOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const columns = [
    { name: 'Waiting', icon: ListTodo, statuses: ['queued', 'waiting-directory'] },
    { name: 'In progress', icon: Layers3, statuses: ['doing', 'claimed'] },
    { name: 'Finished', icon: CheckCheck, statuses: ['done', 'failed', 'cancelled'] },
  ];
  return (
    <section data-slot="ensobot-workspace" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SurfaceHeader
        eyebrow="WORKSPACE"
        title={t('Shared workspace')}
        description={t('Talk freely. Keep the work moving.')}
      >
        <Button
          onClick={() => setTaskOpen(true)}
          disabled={!snapshot.cards.some((card) => !card.bare)}
        >
          <Plus className="size-4" />
          {t('New task')}
        </Button>
      </SurfaceHeader>
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-4">
          <span className="flex size-10 items-center justify-center rounded-lg bg-muted">
            <FolderOpen className="size-5 text-muted-foreground" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium">
              {snapshot.workspace.projectName || t('No project selected')}
            </h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t('One writer per folder. Other tasks wait without interrupting it.')}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setWorkspaceOpen(true)}>
            {t('Choose workspace')}
          </Button>
        </div>
        <div className="grid grid-cols-3 items-start gap-4 max-[1050px]:grid-cols-1">
          {columns.map(({ name, icon: Icon, statuses }) => {
            const tasks = snapshot.tasks.filter((task) => statuses.includes(task.status));
            return (
              <section key={name} className="min-w-0 rounded-xl bg-muted/30 p-3">
                <h3 className="mb-3 flex items-center gap-2 px-1 text-xs font-medium">
                  <Icon className="size-3.5 text-muted-foreground" />
                  {t(name)}
                  <span className="ml-auto font-mono text-muted-foreground">{tasks.length}</span>
                </h3>
                <div className="space-y-3">
                  {tasks.map((task) => {
                    const card = snapshot.cards.find(
                      (item) => item.id === (task.claimerId ?? task.cardId)
                    );
                    return (
                      <article key={task.id} className="rounded-lg border bg-card p-3.5">
                        <TaskStatus status={task.status} />
                        <p className="mt-3 whitespace-pre-wrap break-words text-sm font-medium leading-6">
                          {task.title}
                        </p>
                        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                          {card ? (
                            <CirclePhoto
                              src={card.previewUrl}
                              crop={card.crop}
                              width={card.width}
                              height={card.height}
                              size={22}
                              alt={card.name}
                            />
                          ) : null}
                          {card?.name ?? t('Character')}
                        </div>
                        <p className="mt-3 break-words border-t pt-2 text-[11px] leading-5 text-muted-foreground">
                          {t('Completion check')}: <span className="font-mono">{task.check}</span>
                        </p>
                        {task.note ? (
                          <p className="mt-2 break-words text-xs text-muted-foreground">
                            {task.note}
                          </p>
                        ) : null}
                        {task.fellBack ? (
                          <p className="mt-2 text-xs text-warning">
                            {t('Using the default model')}
                          </p>
                        ) : null}
                        {task.status === 'queued' || task.status === 'waiting-directory' ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="mt-3 w-full"
                            disabled={busy !== null}
                            onClick={async () => {
                              setBusy(task.id);
                              setError('');
                              const input = { taskId: task.id, cardId: task.cardId };
                              const result = await runCommand(
                                { type: 'ensobot-claim', ...input },
                                () => window.electronAPI.ensobot.claim(input)
                              );
                              if (!result.ok) setError(result.error ?? t('Failed'));
                              setBusy(null);
                            }}
                          >
                            {t('Claim')}
                          </Button>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
                {!tasks.length ? (
                  <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
                    {t('No tasks here')}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
        {snapshot.cards.length === 0 ? (
          <div className="mt-6">
            <EmptyState
              icon={ListTodo}
              title={t('Build your team first')}
              description={t('Add a bot in Members, then assign work here.')}
            />
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      {taskOpen ? <TaskDialog snapshot={snapshot} onClose={() => setTaskOpen(false)} /> : null}
      {workspaceOpen ? (
        <WorkspaceDialog snapshot={snapshot} onClose={() => setWorkspaceOpen(false)} />
      ) : null}
    </section>
  );
}

function TaskDialog({ snapshot, onClose }: { snapshot: EnsobotSnapshot; onClose: () => void }) {
  const { t } = useI18n();
  const cards = snapshot.cards.filter((card) => !card.bare);
  const [cardId, setCardId] = useState(cards[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [check, setCheck] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('New task')}</DialogTitle>
          <DialogDescription>{t('Background tasks continue while you chat.')}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <BotSelect
            label={t('Assigned bot')}
            value={cardId}
            items={cards.map((card) => ({ value: card.id, label: card.name }))}
            onChange={setCardId}
          />
          <label className="flex flex-col gap-2 text-xs font-medium">
            {t('Task')}
            <textarea
              className="ensobot-input"
              rows={4}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-2 text-xs font-medium">
            {t('Completion check')}
            <input
              className="ensobot-input"
              value={check}
              onChange={(event) => setCheck(event.target.value)}
            />
            <span className="font-normal leading-5 text-muted-foreground">
              {t('Check text that must show up in tool output')}
            </span>
          </label>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            disabled={busy || !title.trim() || !check.trim() || !cardId}
            onClick={async () => {
              setBusy(true);
              setError('');
              const input = { cardId, title: title.trim(), check: check.trim() };
              const result = await runCommand({ type: 'ensobot-enqueue', ...input }, () =>
                window.electronAPI.ensobot.enqueue(input)
              );
              setBusy(false);
              if (!result.ok) setError(result.error ?? t('Failed'));
              else onClose();
            }}
          >
            {t('Queue task')}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function WorkspaceDialog({
  snapshot,
  onClose,
}: {
  snapshot: EnsobotSnapshot;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const nodeId = useRemoteNodesStore((state) => state.activeNodeId);
  const node = useRemoteNodesStore((state) => state.byNode[nodeId]);
  const localProjects = useSettingsStore((state) => state.projects);
  const [localSessions, setLocalSessions] = useState<ReturnType<typeof parseWorkspaceSessions>>([]);
  useEffect(() => {
    if (nodeId !== 'local') return;
    let disposed = false;
    let revision = 0;
    const read = () => {
      const request = ++revision;
      void window.electronAPI.settings
        .read()
        .then((value) => {
          if (!disposed && request === revision) setLocalSessions(parseWorkspaceSessions(value));
        })
        .catch((reason: unknown) => {
          if (!disposed) setError(String(reason));
        });
    };
    const off = window.electronAPI.settings.onChanged(read);
    read();
    return () => {
      disposed = true;
      off();
    };
  }, [nodeId]);
  const projects =
    nodeId === 'local'
      ? localProjects
          .filter((project) => project.kind !== 'ssh')
          .map((project) => ({ id: project.id, name: projectDisplayName(project) }))
      : (node?.projects ?? []);
  const sessions =
    nodeId === 'local'
      ? localSessions
      : (node?.catalog ?? []).filter((session) => !session.parentId && !session.archived);
  const [projectId, setProjectId] = useState(snapshot.workspace.projectId ?? '');
  const [sessionId, setSessionId] = useState(snapshot.workspace.sessionId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Choose workspace')}</DialogTitle>
          <DialogDescription>
            {t(
              'Pick a project or an existing session. Tasks wait their turn, and the same folder has one writer.'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <BotSelect
            label={t('Project')}
            value={projectId}
            items={[
              { value: '', label: t('No shared project') },
              ...projects.map((project) => ({ value: project.id, label: project.name })),
            ]}
            onChange={(id) => {
              setProjectId(id);
              setSessionId('');
            }}
          />
          <BotSelect
            label={t('Session')}
            value={sessionId}
            items={[
              { value: '', label: t('No session') },
              ...sessions
                .filter((session) => session.projectId === projectId)
                .map((session) => ({ value: session.id, label: session.title || session.id })),
            ]}
            onChange={setSessionId}
          />
          {!projects.length ? (
            <p className="text-xs text-muted-foreground">
              {t('Add a project from the main window first.')}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              const input = { projectId: projectId || null, sessionId: sessionId || null };
              const result = await runCommand({ type: 'ensobot-workspace', ...input }, () =>
                window.electronAPI.ensobot.setWorkspace(input)
              );
              setBusy(false);
              if (!result.ok) setError(result.error ?? t('Failed'));
              else onClose();
            }}
          >
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
