import type { PhoneToHost } from '@enso/pair';
import type { CharacterCardData, CharacterRole } from '@shared/characterCard';
import { EMPTY_PERSONA, EMPTY_ROLE } from '@shared/characterCard';
import { resolveEnsobotModel } from '@shared/defaultModel';
import type { EnsobotActionResult } from '@shared/ensobot/snapshot';
import { applyEnsobotSnapshot, type EnsobotSnapshot } from '@shared/ensobot/snapshot';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/i18n';
import { useOauthCredentialStore } from '@/stores/oauthCredentials';
import { useRemoteNodesStore } from '@/stores/remoteNodes';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

type FaceId = 'chat' | 'board' | 'workspace';

export function useEnsobotSnapshot(): EnsobotSnapshot | null {
  const [snapshot, setSnapshot] = useState<EnsobotSnapshot | null>(null);
  const currentRef = useRef<EnsobotSnapshot | null>(null);
  useEffect(() => {
    const apply = (next: EnsobotSnapshot) => {
      currentRef.current = applyEnsobotSnapshot(currentRef.current, next);
      setSnapshot(currentRef.current);
    };
    const applyLocal = (next: EnsobotSnapshot) => {
      if (useRemoteNodesStore.getState().activeNodeId !== 'local') return;
      apply(next);
    };
    const offLocal = window.electronAPI.ensobot.onChanged(applyLocal);
    void window.electronAPI.ensobot.getState().then(applyLocal);
    const offRemote = window.electronAPI.nodes.onMessage((message) => {
      const active = useRemoteNodesStore.getState().activeNodeId;
      if (active === 'local' || message.nodeId !== active) return;
      const payload = message.payload;
      if (!payload || typeof payload !== 'object') return;
      const frame = payload as { type?: string; snapshot?: EnsobotSnapshot };
      if (frame.type !== 'ensobot-snapshot' || !frame.snapshot) return;
      apply(frame.snapshot);
    });
    return () => {
      offLocal();
      offRemote();
    };
  }, []);
  return snapshot;
}

async function runCommand(
  command: PhoneToHost,
  local: () => Promise<EnsobotActionResult>,
  deliveryId?: string
): Promise<EnsobotActionResult> {
  const nodeId = useRemoteNodesStore.getState().activeNodeId;
  if (nodeId === 'local') return local();
  const transport = await window.electronAPI.nodes.send(nodeId, command);
  if (!transport.ok) return transport;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      off();
      resolve({ ok: false, error: 'timeout' });
    }, 10_000);
    const off = window.electronAPI.nodes.onMessage((message) => {
      const payload = message.payload;
      if (!payload || typeof payload !== 'object') return;
      const frame = payload as {
        type?: string;
        ok?: boolean;
        error?: string;
        disposition?: string;
        deliveryId?: string;
      };
      if (frame.type !== 'ensobot-result') return;
      if (deliveryId && frame.deliveryId && frame.deliveryId !== deliveryId) return;
      window.clearTimeout(timer);
      off();
      resolve({
        ok: frame.ok === true,
        ...(frame.error ? { error: frame.error } : {}),
        ...(frame.disposition ? { disposition: frame.disposition } : {}),
      });
    });
  });
}

export function EnsobotFace({ face }: { face: FaceId }) {
  const snapshot = useEnsobotSnapshot();
  if (face === 'chat') return <ChatFace snapshot={snapshot} />;
  if (face === 'board') return <BoardFace snapshot={snapshot} />;
  return <WorkspaceFace snapshot={snapshot} />;
}

function ChatFace({ snapshot }: { snapshot: EnsobotSnapshot | null }) {
  const { t } = useI18n();
  const [cardId, setCardId] = useState('');
  const [text, setText] = useState('');
  const [retarget, setRetarget] = useState(false);
  const [error, setError] = useState('');
  const cards = snapshot?.cards ?? [];
  const selected = cardId || cards[0]?.id || '';
  const bubbles = (snapshot?.bubbles ?? []).filter((bubble) => bubble.cardId === selected);
  const local = useRemoteNodesStore((state) => state.activeNodeId) === 'local';

  if (cards.length === 0 && bubbles.length === 0) {
    return (
      <Empty
        title={t('Private chat')}
        body={t('Pick a character, or import a picture, to start a private chat.')}
      />
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-muted-foreground" htmlFor="ensobot-chat-card">
          {t('Character')}
        </label>
        <select
          id="ensobot-chat-card"
          className="rounded-md border bg-background px-2 py-1 text-sm"
          value={selected}
          onChange={(event) => setCardId(event.target.value)}
        >
          {cards.map((card) => (
            <option key={card.id} value={card.id}>
              {card.name}
              {card.coordinator ? ` · ${t('Coordinator')}` : ''}
            </option>
          ))}
        </select>
      </div>
      {local ? <CardEditor cardId={selected} onPick={setCardId} /> : null}
      <ul className="flex flex-col gap-2" data-slot="ensobot-bubbles">
        {bubbles.length === 0 ? (
          <li className="text-sm text-muted-foreground">{t('No messages yet.')}</li>
        ) : (
          bubbles.map((bubble) => (
            <li
              key={bubble.deliveryId}
              data-lane={bubble.lane}
              className="max-w-xl rounded-2xl bg-background/80 px-3 py-2 text-sm"
            >
              <span className="mr-2 text-xs text-muted-foreground">
                {bubble.authorKind === 'human' ? t('You') : t('Bot')}
              </span>
              {bubble.text}
            </li>
          ))
        )}
      </ul>
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const deliveryId = crypto.randomUUID();
          const body = text;
          setError('');
          void runCommand(
            {
              type: 'ensobot-send',
              cardId: selected,
              text: body,
              deliveryId,
              ...(retarget ? { retarget: true } : {}),
            },
            () =>
              window.electronAPI.ensobot.send({
                cardId: selected,
                text: body,
                deliveryId,
                retarget,
              }),
            deliveryId
          ).then((result) => {
            if (!result.ok) setError(result.error ?? 'failed');
            else setText('');
          });
        }}
      >
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={3}
          className="rounded-md border bg-background px-2 py-1 text-sm"
          placeholder={t('Say something to this character')}
        />
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={retarget}
            onChange={(event) => setRetarget(event.target.checked)}
          />
          {t('Replace the goal')}
        </label>
        <button
          type="submit"
          disabled={!selected || text.trim().length === 0}
          className="self-start rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          {t('Send')}
        </button>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </form>
    </div>
  );
}

function BoardFace({ snapshot }: { snapshot: EnsobotSnapshot | null }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [error, setError] = useState('');
  const cards = snapshot?.cards ?? [];
  const notes = snapshot?.board ?? [];
  if (notes.length === 0 && cards.length === 0) {
    return (
      <Empty
        title={t('Message board')}
        body={t('The board is empty. A note only wakes the people you name.')}
      />
    );
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <ul className="flex flex-col gap-2" data-slot="ensobot-board">
        {notes.length === 0 ? (
          <li className="text-sm text-muted-foreground">{t('No notes yet.')}</li>
        ) : (
          notes.map((note) => (
            <li
              key={`${note.seq}-${note.authorId}`}
              className="rounded-lg border bg-background/70 px-3 py-2 text-sm"
            >
              <span className="mr-2 text-xs text-muted-foreground">
                {note.authorKind === 'human' ? t('You') : note.authorId.slice(0, 8)}
              </span>
              {note.text}
            </li>
          ))
        )}
      </ul>
      {(snapshot?.notices ?? []).map((notice) => (
        <p key={notice.cardId} className="text-xs text-muted-foreground">
          {notice.text}
        </p>
      ))}
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const deliveryId = crypto.randomUUID();
          const body = text;
          const named = mentions;
          setError('');
          void runCommand(
            { type: 'ensobot-board', text: body, mentions: named, deliveryId },
            () => window.electronAPI.ensobot.postBoard({ text: body, mentions: named, deliveryId }),
            deliveryId
          ).then((result) => {
            if (!result.ok) setError(result.error ?? 'failed');
            else setText('');
          });
        }}
      >
        <div className="flex flex-wrap gap-2">
          {cards.map((card) => (
            <label key={card.id} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={mentions.includes(card.id)}
                onChange={(event) => {
                  setMentions((current) =>
                    event.target.checked
                      ? [...current, card.id]
                      : current.filter((id) => id !== card.id)
                  );
                }}
              />
              {card.name}
            </label>
          ))}
        </div>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={3}
          className="rounded-md border bg-background px-2 py-1 text-sm"
          placeholder={t('Write on the board')}
        />
        <button
          type="submit"
          disabled={text.trim().length === 0}
          className="self-start rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          {t('Post')}
        </button>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </form>
    </div>
  );
}

function WorkspaceFace({ snapshot }: { snapshot: EnsobotSnapshot | null }) {
  const { t } = useI18n();
  const projects = useSettingsStore((state) => state.projects);
  const conversations = useSessionsStore((state) => state.conversations);
  const [cardId, setCardId] = useState('');
  const [title, setTitle] = useState('');
  const [check, setCheck] = useState('');
  const [error, setError] = useState('');
  const cards = snapshot?.cards ?? [];
  const selected = cardId || cards[0]?.id || '';
  const tasks = snapshot?.tasks ?? [];
  const sessionId = snapshot?.workspace.sessionId;
  const session = sessionId ? conversations[sessionId] : undefined;
  if (!snapshot?.workspace.projectId && !sessionId && tasks.length === 0) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <Empty
          title={t('Shared workspace')}
          body={t(
            'Pick a project or an existing session. Tasks wait their turn, and the same folder has one writer.'
          )}
        />
        <WorkspacePicker snapshot={snapshot} />
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <WorkspacePicker snapshot={snapshot} />
      <p className="text-sm text-muted-foreground">
        {snapshot?.workspace.projectName || t('No project selected')}
      </p>
      <ul className="flex flex-col gap-2" data-slot="ensobot-tasks">
        {tasks.length === 0 ? (
          <li className="text-sm text-muted-foreground">{t('No tasks yet.')}</li>
        ) : (
          tasks.map((task) => (
            <li key={task.id} className="rounded-lg border bg-background/70 px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span>{task.title}</span>
                <span className="text-xs text-muted-foreground">{task.status}</span>
              </div>
              {task.fellBack ? (
                <p className="text-xs text-muted-foreground">{t('Using the default model')}</p>
              ) : null}
              {task.status === 'queued' || task.status === 'waiting-directory' ? (
                <button
                  type="button"
                  className="mt-1 text-xs underline"
                  onClick={() => {
                    void runCommand(
                      { type: 'ensobot-claim', taskId: task.id, cardId: task.cardId },
                      () =>
                        window.electronAPI.ensobot.claim({ taskId: task.id, cardId: task.cardId })
                    ).then((result) => {
                      if (!result.ok) setError(result.error ?? 'failed');
                    });
                  }}
                >
                  {t('Claim')}
                </button>
              ) : null}
            </li>
          ))
        )}
      </ul>
      {session ? (
        <ul
          className="flex max-h-64 flex-col gap-1 overflow-auto text-sm"
          data-slot="ensobot-timeline"
        >
          {session.messages.slice(-12).map((message) => (
            <li
              key={`${session.id}-${message.timestamp ?? 0}-${message.role}-${message.toolCallId ?? ''}-${textOf(message).slice(0, 24)}`}
              className="text-muted-foreground"
            >
              <span className="mr-2 text-xs">{message.role}</span>
              {textOf(message)}
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const picked = selected;
          const taskTitle = title;
          const taskCheck = check;
          setError('');
          void runCommand(
            { type: 'ensobot-enqueue', cardId: picked, title: taskTitle, check: taskCheck },
            () =>
              window.electronAPI.ensobot.enqueue({
                cardId: picked,
                title: taskTitle,
                check: taskCheck,
              })
          ).then((result) => {
            if (!result.ok) setError(result.error ?? result.disposition ?? 'failed');
            else {
              setTitle('');
              setCheck('');
            }
          });
        }}
      >
        <select
          className="rounded-md border bg-background px-2 py-1 text-sm"
          value={selected}
          onChange={(event) => setCardId(event.target.value)}
        >
          {cards.map((card) => (
            <option key={card.id} value={card.id}>
              {card.name}
            </option>
          ))}
        </select>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t('Task')}
          className="rounded-md border bg-background px-2 py-1 text-sm"
        />
        <input
          value={check}
          onChange={(event) => setCheck(event.target.value)}
          placeholder={t('Check text that must show up in tool output')}
          className="rounded-md border bg-background px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={!selected || !title.trim() || !check.trim()}
          className="self-start rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          {t('Queue task')}
        </button>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </form>
      <p className="text-xs text-muted-foreground">
        {projects.length === 0 ? t('Add a project from the main window first.') : null}
      </p>
    </div>
  );
}

function WorkspacePicker({ snapshot }: { snapshot: EnsobotSnapshot | null }) {
  const { t } = useI18n();
  const projects = useSettingsStore((state) => state.projects);
  const conversations = useSessionsStore((state) => state.conversations);
  const sessions = Object.values(conversations).filter((conversation) => !conversation.parentId);
  return (
    <div className="flex flex-wrap gap-2">
      <select
        aria-label={t('Project')}
        className="rounded-md border bg-background px-2 py-1 text-sm"
        value={snapshot?.workspace.projectId ?? ''}
        onChange={(event) => {
          const projectId = event.target.value || null;
          void runCommand(
            {
              type: 'ensobot-workspace',
              projectId,
              sessionId: snapshot?.workspace.sessionId ?? null,
            },
            () =>
              window.electronAPI.ensobot.setWorkspace({
                projectId,
                sessionId: snapshot?.workspace.sessionId ?? null,
              })
          );
        }}
      >
        <option value="">{t('No shared project')}</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.alias?.trim() || project.name}
          </option>
        ))}
      </select>
      <select
        aria-label={t('Session')}
        className="rounded-md border bg-background px-2 py-1 text-sm"
        value={snapshot?.workspace.sessionId ?? ''}
        onChange={(event) => {
          const sessionId = event.target.value || null;
          void runCommand(
            {
              type: 'ensobot-workspace',
              projectId: snapshot?.workspace.projectId ?? null,
              sessionId,
            },
            () =>
              window.electronAPI.ensobot.setWorkspace({
                projectId: snapshot?.workspace.projectId ?? null,
                sessionId,
              })
          );
        }}
      >
        <option value="">{t('No session')}</option>
        {sessions.slice(0, 40).map((conversation) => (
          <option key={conversation.id} value={conversation.id}>
            {conversation.title || conversation.id.slice(0, 8)}
          </option>
        ))}
      </select>
    </div>
  );
}

function CardEditor({ cardId, onPick }: { cardId: string; onPick: (id: string) => void }) {
  const { t } = useI18n();
  const providers = useSettingsStore((state) => state.providers);
  const defaultModel = useSettingsStore((state) => state.defaultModel);
  const oauth = useOauthCredentialStore((state) => state.snapshot.availability);
  const [listed, setListed] = useState<Awaited<
    ReturnType<typeof window.electronAPI.ensobot.listCards>
  > | null>(null);
  const [error, setError] = useState('');
  const reload = () => {
    void window.electronAPI.ensobot.listCards().then(setListed);
  };
  useEffect(() => {
    void window.electronAPI.ensobot.listCards().then(setListed);
  }, []);
  const summary = listed?.cards.find((card) => card.id === cardId) ?? null;
  const draft = useMemo(() => summary?.card ?? blank(cardId), [summary, cardId]);
  const [persona, setPersona] = useState(draft.persona);
  const [role, setRole] = useState(draft.role);
  const [crop, setCrop] = useState(draft.crop);
  useEffect(() => {
    setPersona(draft.persona);
    setRole(draft.role);
    setCrop(draft.crop);
  }, [draft]);
  const decision = resolveEnsobotModel({
    cardModel:
      role.providerId && role.modelId
        ? { providerId: role.providerId, modelId: role.modelId }
        : null,
    defaultModel,
    providers,
    credentials: { oauthCredentials: oauth },
  });
  const provider = providers.find((item) => item.id === role.providerId);
  return (
    <section
      className="flex flex-col gap-3 rounded-xl border bg-background/70 p-3"
      data-slot="ensobot-card"
    >
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-md border px-2 py-1 text-sm"
          onClick={() => {
            void window.electronAPI.ensobot.importCard().then((result) => {
              if (!result.ok || !result.cardId) setError(result.error ?? 'failed');
              else {
                onPick(result.cardId);
                reload();
              }
            });
          }}
        >
          {t('Import picture')}
        </button>
        {summary ? (
          <>
            <button
              type="button"
              className="rounded-md border px-2 py-1 text-sm"
              onClick={() => {
                void window.electronAPI.ensobot.exportCard(summary.id).then((result) => {
                  if (!result.ok) setError(result.error ?? 'failed');
                });
              }}
            >
              {t('Export PNG')}
            </button>
            <button
              type="button"
              className="rounded-md border px-2 py-1 text-sm"
              onClick={() => {
                void window.electronAPI.ensobot.deleteCard(summary.id).then((result) => {
                  if (!result.ok) setError(result.error ?? 'failed');
                  else {
                    onPick('');
                    reload();
                  }
                });
              }}
            >
              {t('Delete card')}
            </button>
          </>
        ) : null}
      </div>
      {listed?.errors.length ? (
        <p className="text-xs text-muted-foreground">
          {t('Some card files could not be read. The rest of the list is still here.')}
        </p>
      ) : null}
      {summary ? (
        <>
          <button
            type="button"
            className="relative h-40 w-40 overflow-hidden rounded-md border"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const width = summary.width || 1;
              const height = summary.height || 1;
              const cx = ((event.clientX - rect.left) / rect.width) * width;
              const cy = ((event.clientY - rect.top) / rect.height) * height;
              const radius = crop?.r && crop.r > 0 ? crop.r : Math.min(width, height) / 4;
              setCrop({ cx, cy, r: radius });
            }}
          >
            <img alt="" src={summary.previewUrl} className="h-full w-full object-contain" />
            {crop ? (
              <span
                className="pointer-events-none absolute rounded-full border-2 border-primary"
                style={{
                  left: `${((crop.cx - crop.r) / (summary.width || 1)) * 100}%`,
                  top: `${((crop.cy - crop.r) / (summary.height || 1)) * 100}%`,
                  width: `${((crop.r * 2) / (summary.width || 1)) * 100}%`,
                  height: `${((crop.r * 2) / (summary.height || 1)) * 100}%`,
                }}
              />
            ) : null}
          </button>
          <div className="grid grid-cols-3 gap-2 text-sm">
            <Field
              label="cx"
              value={crop?.cx ?? 0}
              onChange={(cx) => setCrop({ cx, cy: crop?.cy ?? 0, r: crop?.r ?? 1 })}
            />
            <Field
              label="cy"
              value={crop?.cy ?? 0}
              onChange={(cy) => setCrop({ cx: crop?.cx ?? 0, cy, r: crop?.r ?? 1 })}
            />
            <Field
              label="r"
              value={crop?.r ?? 0}
              onChange={(r) => setCrop({ cx: crop?.cx ?? 0, cy: crop?.cy ?? 0, r })}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {t('Circle crop uses source pixels. The file keeps the whole picture.')}
          </p>
          <input
            value={persona.name}
            onChange={(event) => setPersona({ ...persona, name: event.target.value })}
            placeholder={t('Name')}
            className="rounded-md border bg-background px-2 py-1 text-sm"
          />
          <textarea
            value={persona.personality}
            onChange={(event) => setPersona({ ...persona, personality: event.target.value })}
            placeholder={t('Personality')}
            rows={2}
            className="rounded-md border bg-background px-2 py-1 text-sm"
          />
          <textarea
            value={persona.setting}
            onChange={(event) => setPersona({ ...persona, setting: event.target.value })}
            placeholder={t('Character setting')}
            rows={2}
            className="rounded-md border bg-background px-2 py-1 text-sm"
          />
          <textarea
            value={role.duty}
            onChange={(event) => setRole({ ...role, duty: event.target.value })}
            placeholder={t('Duty')}
            rows={2}
            className="rounded-md border bg-background px-2 py-1 text-sm"
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={role.coordinator}
              onChange={(event) => setRole({ ...role, coordinator: event.target.checked })}
            />
            {t('Coordinator: assign work, do not edit the shared workspace')}
          </label>
          <div className="flex flex-wrap gap-2">
            <select
              className="rounded-md border bg-background px-2 py-1 text-sm"
              value={role.providerId}
              onChange={(event) =>
                setRole({ ...role, providerId: event.target.value, modelId: '' })
              }
            >
              <option value="">{t('Provider')}</option>
              {providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name || item.id}
                </option>
              ))}
            </select>
            <select
              className="rounded-md border bg-background px-2 py-1 text-sm"
              value={role.modelId}
              onChange={(event) => setRole({ ...role, modelId: event.target.value })}
            >
              <option value="">{t('Model')}</option>
              {(provider?.models ?? []).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label || model.id}
                </option>
              ))}
            </select>
            <input
              type="number"
              min={1}
              max={32}
              value={role.concurrency}
              onChange={(event) =>
                setRole({ ...role, concurrency: Number(event.target.value) || 1 })
              }
              className="w-20 rounded-md border bg-background px-2 py-1 text-sm"
              aria-label={t('Concurrency')}
            />
          </div>
          <p className="text-xs text-muted-foreground" data-slot="ensobot-model">
            {decision.kind === 'card'
              ? t('Using the card model')
              : decision.kind === 'default'
                ? t('Card model is missing, so this falls back to the default')
                : decision.kind === 'oauth-blocked'
                  ? decision.reason
                  : t('No usable model')}
          </p>
          <button
            type="button"
            className="self-start rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
            onClick={() => {
              const next: CharacterCardData = {
                id: summary.id,
                ...(summary.card?.originId ? { originId: summary.card.originId } : {}),
                persona,
                role: normalizeRole(role),
                crop,
              };
              void window.electronAPI.ensobot.updateCard(summary.id, next).then((result) => {
                if (!result.ok) setError(result.error ?? 'failed');
                else reload();
              });
            }}
          >
            {t('Save card')}
          </button>
        </>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        onChange={(event) => onChange(Number(event.target.value))}
        className="rounded-md border bg-background px-2 py-1 text-sm text-foreground"
      />
    </label>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto flex max-w-lg flex-col gap-3 pt-10" data-slot="ensobot-empty">
      <h1 className="text-lg font-medium text-foreground">{title}</h1>
      <p className="text-sm leading-6 text-muted-foreground">{body}</p>
    </div>
  );
}

function blank(id: string): CharacterCardData {
  return { id, persona: { ...EMPTY_PERSONA }, role: { ...EMPTY_ROLE }, crop: null };
}

function normalizeRole(role: CharacterRole): CharacterRole {
  const concurrency = Math.max(1, Math.min(32, Math.round(role.concurrency) || 1));
  return { ...role, concurrency };
}

function textOf(message: { content?: { type?: string; text?: string }[] }): string {
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .slice(0, 400);
}
