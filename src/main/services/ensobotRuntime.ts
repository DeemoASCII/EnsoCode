import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { PhoneToHost } from '@enso/pair';
import type { EnsobotModelDecision } from '@shared/defaultModel';
import { resolveEnsobotModel } from '@shared/defaultModel';
import type { EnsobotActionResult } from '@shared/ensobot/snapshot';
import { IPC_CHANNELS, type ModelProvider, type Project, type ProjectGroup } from '@shared/types';
import type { AgentWorkerEvent } from '@shared/types/agent';
import { app } from 'electron';
import { sendToAllWindows } from '../windows/createAppWindow';
import {
  ensureAgentWorkerReady,
  isAgentWorkerReady,
  promptSession,
  readSettingsState,
  spawnSession,
  steerSession,
} from './agentHost';
import { type CardStore, createCharacterCardStore } from './characterCards';
import { createEnsobotHost, type EnsobotHost } from './ensobotHost';
import { readStoredOauthCredentialKeys } from './oauthProviders';

let cards: CardStore | null = null;
let host: EnsobotHost | null = null;
let oauthKeys = new Set<string>();

export function getCharacterCardStore(): CardStore {
  if (!cards) {
    const root = path.join(app.getPath('userData'), 'ensobot-cards');
    mkdirSync(root, { recursive: true });
    cards = createCharacterCardStore(root);
  }
  return cards;
}

export function getEnsobotHost(): EnsobotHost {
  if (!host) {
    const root = path.join(app.getPath('userData'), 'ensobot');
    host = createEnsobotHost(root, {
      workerReady: isAgentWorkerReady,
      prepareWorker: ensureAgentWorkerReady,
      steer: (input) =>
        isAgentWorkerReady()
          ? steerSession(
              { sessionId: input.sessionId, generation: input.generation },
              input.text,
              undefined,
              input.deliveryId,
              { ensobot: true }
            )
          : { ok: false, error: 'worker-offline' },
      prompt: (input) =>
        isAgentWorkerReady()
          ? promptSession(
              { sessionId: input.sessionId, generation: input.generation },
              input.text,
              undefined,
              input.deliveryId,
              { ensobot: true }
            )
          : { ok: false, error: 'worker-offline' },
      spawn: (input) => {
        if (!isAgentWorkerReady()) return { ok: false, error: 'worker-offline', ready: false };
        const sent = spawnSession(
          { sessionId: input.sessionId, generation: input.generation },
          {
            sessionId: input.sessionId,
            cwd: input.cwd,
            providerId: input.providerId,
            modelId: input.modelId,
            approvalMode: input.approvalMode,
            ...(input.resumeFile ? { resumeFile: input.resumeFile } : {}),
          },
          oauthKeys,
          undefined,
          input.projectId,
          {
            rolePrompt: input.rolePrompt,
            extraDisabledTools: input.extraDisabledTools,
            ensobotSpeak: true,
            ensobotCoordinator: input.coordinator,
          }
        );
        return { ok: sent.ok, error: sent.error, ready: false };
      },
      resolveModel: resolveCardModel,
      projectById: (projectId) => {
        const project = findProject(projectId);
        if (!project) return { ok: false, error: 'unknown-project' };
        if (project.kind === 'ssh') return { ok: false, error: 'ssh-project' };
        if (!project.path) return { ok: false, error: 'unknown-project' };
        return { ok: true, name: project.alias?.trim() || project.name, cwd: project.path };
      },
      loadCard: (id) => getCharacterCardStore().get(id),
      listCardIds: () =>
        getCharacterCardStore()
          .list()
          .cards.map((card) => card.id),
      uuid: () => crypto.randomUUID(),
      onChange: (snapshot) => {
        sendToAllWindows(IPC_CHANNELS.ENSOBOT_CHANGED, snapshot);
        void import('./pairHost').then(({ publishEnsobotFrame }) => {
          publishEnsobotFrame({ type: 'ensobot-snapshot', snapshot });
        });
      },
    });
  }
  return host;
}

export function observeEnsobotWorkerEvent(
  event: AgentWorkerEvent | { type: 'worker-exited' }
): void {
  if (
    event.type !== 'worker-exited' &&
    event.type !== 'ensobot-bubble' &&
    event.type !== 'ensobot-interject-deferred' &&
    event.type !== 'parent-ready' &&
    event.type !== 'parent-ended' &&
    event.type !== 'parent-rejected' &&
    event.type !== 'turn-retry' &&
    event.type !== 'turn-completed' &&
    event.type !== 'turn-failed' &&
    event.type !== 'message-upsert' &&
    event.type !== 'status' &&
    event.type !== 'tool-output'
  ) {
    return;
  }
  try {
    getEnsobotHost().observe(event);
  } catch (error) {
    console.warn('[ensobot] observe failed', error);
  }
}

export async function handleEnsobotGuestCommand(
  command: PhoneToHost
): Promise<EnsobotActionResult> {
  const bot = getEnsobotHost();
  switch (command.type) {
    case 'ensobot-send':
      return bot.submitUtterance({
        cardId: command.cardId,
        text: command.text,
        lane: 'human',
        deliveryId: command.deliveryId,
        retarget: command.retarget,
      });
    case 'ensobot-board':
      return bot.postBoard({
        text: command.text,
        mentions: command.mentions,
        deliveryId: command.deliveryId,
      });
    case 'ensobot-room-create':
      return bot.createRoom({ name: command.name, memberIds: command.memberIds });
    case 'ensobot-room-send':
      return bot.postRoom({
        roomId: command.roomId,
        text: command.text,
        deliveryId: command.deliveryId,
      });
    case 'ensobot-claim':
      return bot.claim({ taskId: command.taskId, cardId: command.cardId });
    case 'ensobot-enqueue':
      return bot.enqueueTask({
        cardId: command.cardId,
        title: command.title,
        check: command.check,
      });
    case 'ensobot-workspace':
      return bot.setWorkspace({
        projectId: command.projectId ?? null,
        sessionId: command.sessionId ?? null,
      });
    default:
      return { ok: false, error: 'unsupported' };
  }
}

async function resolveCardModel(card: {
  providerId: string;
  modelId: string;
}): Promise<EnsobotModelDecision> {
  const state = readSettingsState() ?? {};
  const providers = Array.isArray(state.providers)
    ? state.providers.filter(
        (provider): provider is ModelProvider =>
          Boolean(provider) &&
          typeof provider === 'object' &&
          typeof (provider as ModelProvider).id === 'string'
      )
    : [];
  let credentials: Parameters<typeof resolveEnsobotModel>[0]['credentials'];
  try {
    oauthKeys = new Set(await readStoredOauthCredentialKeys());
    credentials = {
      oauthCredentials: { status: 'ready', authenticatedAccountKeys: oauthKeys },
    };
  } catch (error) {
    credentials = {
      oauthCredentials: {
        status: 'error',
        error: error instanceof Error ? error.message : 'oauth',
      },
    };
  }
  const projectId = currentProjectId();
  const project = projectId ? findProject(projectId) : undefined;
  const group = project?.groupId ? findGroup(project.groupId) : undefined;
  return resolveEnsobotModel({
    cardModel: card.providerId && card.modelId ? card : null,
    defaultModel: modelRef(state.defaultModel),
    projectDefaultModel: modelRef(project?.defaultModel),
    groupDefaultModel: modelRef(group?.defaultModel),
    providers,
    credentials,
  });
}

function currentProjectId(): string | null {
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(app.getPath('userData'), 'ensobot', 'workspace.json'), 'utf8')
    ) as { projectId?: unknown };
    return typeof parsed.projectId === 'string' ? parsed.projectId : null;
  } catch {
    return null;
  }
}

function findProject(projectId: string): Project | undefined {
  const projects = readSettingsState()?.projects;
  if (!Array.isArray(projects)) return undefined;
  return projects.find(
    (project): project is Project =>
      Boolean(project) &&
      typeof project === 'object' &&
      (project as Project).id === projectId &&
      typeof (project as Project).path === 'string'
  );
}

function findGroup(groupId: string): ProjectGroup | undefined {
  const groups = readSettingsState()?.projectGroups;
  if (!Array.isArray(groups)) return undefined;
  return groups.find(
    (group): group is ProjectGroup =>
      Boolean(group) && typeof group === 'object' && (group as ProjectGroup).id === groupId
  );
}

function modelRef(value: unknown): { providerId: string; modelId: string } | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { providerId?: unknown; modelId?: unknown };
  if (typeof record.providerId !== 'string' || typeof record.modelId !== 'string') return null;
  if (!record.providerId || !record.modelId) return null;
  return { providerId: record.providerId, modelId: record.modelId };
}
