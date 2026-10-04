import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { PhoneToHost } from '@enso/pair';
import type { SessionIdentity } from '@shared/builtinAgents';
import type { EnsobotModelDecision } from '@shared/defaultModel';
import { resolveEnsobotModel } from '@shared/defaultModel';
import type { EnsobotWorkReadResult } from '@shared/ensobot/evidence';
import { parseEnsobotResponse } from '@shared/ensobot/interaction';
import type { EnsobotActionResult } from '@shared/ensobot/snapshot';
import { IPC_CHANNELS, type ModelProvider, type Project, type ProjectGroup } from '@shared/types';
import type { AgentWorkerEvent } from '@shared/types/agent';
import { app } from 'electron';
import { sendToAllWindows } from '../windows/createAppWindow';
import {
  ensureAgentWorkerReady,
  isAgentWorkerReady,
  onAgentWorkerSpawn,
  promptSession,
  readSettingsState,
  respondApproval,
  respondAsk,
  spawnSession,
  steerSession,
} from './agentHost';
import { type CardStore, createCharacterCardStore } from './characterCards';
import { createEnsobotHost, type EnsobotHost } from './ensobotHost';
import { createEnsobotInteractions } from './ensobotInteractions';
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
      interactions: () => getInteractions().snapshot(),
    });
    // 重启前排着的消息：worker 已在就接着送，否则等它起来（首次或退出后重启）再送。
    const created = host;
    onAgentWorkerSpawn(() => {
      void created.resume();
    });
    if (isAgentWorkerReady()) void created.resume();
  }
  return host;
}

// Main 提供索引权威关系；不按 sessionId 字符串前缀猜子会话的所属人物卡。
let sessionRoot: (identity: SessionIdentity) => SessionIdentity | undefined = () => undefined;
export function setEnsobotSessionRootResolver(resolve: typeof sessionRoot): void {
  sessionRoot = resolve;
}
let interactions: ReturnType<typeof createEnsobotInteractions> | undefined;
function getInteractions() {
  interactions ??= createEnsobotInteractions({
    ownerOf: (identity) => {
      const bot = getEnsobotHost();
      const direct = bot.ownerOfSession(identity);
      if (direct) return direct;
      const root = sessionRoot(identity);
      return root ? bot.ownerOfSession(root) : undefined;
    },
    workerReady: isAgentWorkerReady,
    approve: respondApproval,
    answer: respondAsk,
    uuid: () => crypto.randomUUID(),
    changed: () => getEnsobotHost().touch(),
  });
  return interactions;
}
export function respondEnsobotInteraction(raw: unknown): EnsobotActionResult {
  const input = parseEnsobotResponse(raw);
  return input ? getInteractions().respond(input) : { ok: false, error: 'bad-params' };
}

export function observeEnsobotWorkerEvent(
  event: AgentWorkerEvent | { type: 'worker-exited' }
): void {
  switch (event.type) {
    case 'approval-request':
    case 'approval-resolved':
    case 'ask-request':
    case 'ask-resolved':
    case 'snapshot':
    case 'worker-exited':
    case 'parent-ended':
    case 'parent-rejected':
    case 'child-ended':
    case 'child-rejected':
    case 'coworker-update':
    case 'turn-completed':
    case 'turn-failed':
      getInteractions().observe(event);
  }
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

export function handleEnsobotGuestCommand(
  command: Extract<PhoneToHost, { type: 'ensobot-work-read' }>
): Promise<EnsobotWorkReadResult>;
export function handleEnsobotGuestCommand(
  command: Exclude<PhoneToHost, { type: 'ensobot-work-read' }>
): Promise<EnsobotActionResult>;
export async function handleEnsobotGuestCommand(
  command: PhoneToHost
): Promise<EnsobotActionResult | EnsobotWorkReadResult> {
  const bot = getEnsobotHost();
  switch (command.type) {
    case 'ensobot-work-read':
      return bot.readWork(command.request);
    case 'ensobot-respond':
      return respondEnsobotInteraction(command.response);
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
      return bot.createRoom({
        name: command.name,
        memberIds: command.memberIds,
        ...(command.hostId ? { hostId: command.hostId } : {}),
      });
    case 'ensobot-room-update':
      return bot.updateRoom({
        roomId: command.roomId,
        ...(command.hostId !== undefined ? { hostId: command.hostId } : {}),
        ...(command.relayLimit !== undefined ? { relayLimit: command.relayLimit } : {}),
      });
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
