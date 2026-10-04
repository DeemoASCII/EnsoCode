import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceAuthorityRegistry } from '../services/sourceAuthorityRegistry';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  root: '',
  registry: null as unknown,
  settings: {} as Record<string, unknown>,
  isMain: vi.fn(() => true),
  spawnSession: vi.fn((..._args: unknown[]) => ({ ok: true })),
  promptSession: vi.fn((..._args: unknown[]) => ({ ok: true })),
  steerSession: vi.fn((..._args: unknown[]) => ({ ok: true })),
  identities: new Map<string, { sessionId: string; generation: string }>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
  app: { getPath: () => mocks.root },
  shell: { openPath: async () => '' },
}));
vi.mock('../windows/MainWindow', () => ({ isMainWebContents: mocks.isMain }));
vi.mock('../windows/createAppWindow', () => ({ sendToAllWindows: vi.fn() }));
vi.mock('../services/oauthProviders', () => ({
  readStoredOauthCredentialKeys: async () => new Set<string>(),
}));
vi.mock('../services/instructionStore', () => ({ resolveGlobalInstruction: () => undefined }));
vi.mock('../services/sessionFileCleanup', () => ({ removeConversationSessionFiles: vi.fn() }));
vi.mock('../services/agentHost', () => ({
  agentTypeRegistrySnapshot: () => ({ revision: 0, candidates: [{ displayName: 'Reviewer' }] }),
  readSettingsState: () => mocks.settings,
  resolveModelSelection: () => ({ ok: true }),
  spawnSession: mocks.spawnSession,
  promptSession: mocks.promptSession,
  steerSession: mocks.steerSession,
  abortSession: vi.fn(),
  releaseParentSession: async () => ({ ok: true }),
}));
vi.mock('./agent', () => ({
  getSourceAuthorityRegistry: () => mocks.registry,
  readSessionHistoryFile: vi.fn(),
  setBotWorkerEventObserver: vi.fn(),
}));
vi.mock('./capabilities', () => ({
  agentSessionIndex: {
    currentIdentity: (id: string) => mocks.identities.get(id),
    prepareParent: (identity: { sessionId: string; generation: string }) =>
      mocks.identities.set(identity.sessionId, identity),
    isAlive: (id: string) => mocks.identities.has(id),
  },
}));

const main = { sender: { id: 1 } };
const call = async (channel: string, request?: unknown) => {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`missing ${channel}`);
  return (await handler(main, request)) as Record<string, unknown>;
};

beforeEach(async () => {
  mocks.root = realpathSync(mkdtempSync(join(tmpdir(), 'bots-ipc-')));
  mocks.registry = new SourceAuthorityRegistry({ registryFile: join(mocks.root, 'r.json') });
  mocks.settings = {
    botModeEnabled: true,
    defaultModel: { providerId: 'p', modelId: 'm' },
  };
  mocks.handlers.clear();
  mocks.identities.clear();
  mocks.spawnSession.mockClear();
  mocks.promptSession.mockClear();
  mocks.isMain.mockReturnValue(true);
  vi.resetModules();
  const { registerBotHandlers } = await import('./bots');
  registerBotHandlers();
});
afterEach(() => rmSync(mocks.root, { recursive: true, force: true }));

async function createBot(name: string): Promise<string> {
  const result = await call(IPC_CHANNELS.BOT_CREATE, { name, persona: 'Calm.' });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return (result.bot as { id: string }).id;
}

describe('bots IPC', () => {
  it('validates routine ownership and cron; projects list/save/remove and disabled lists', async () => {
    const alice = await createBot('Alice');
    const bob = await createBot('Bob');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'direct',
      members: [alice],
      workspace: { kind: 'member-home' },
    });
    const chatId = (created.chat as { id: string }).id;
    const draft = {
      botId: alice,
      chatId,
      title: 'Check',
      prompt: 'check status',
      schedule: '0 9 * * *',
    };
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_SAVE, { ...draft, botId: bob })).toMatchObject({
      ok: false,
    });
    expect(
      await call(IPC_CHANNELS.BOT_ROUTINE_SAVE, { ...draft, schedule: 'invalid' })
    ).toMatchObject({ ok: false });
    const saved = await call(IPC_CHANNELS.BOT_ROUTINE_SAVE, draft);
    expect(saved.ok).toBe(true);
    expect(await call(IPC_CHANNELS.BOT_ROUTINES_LIST, { botId: alice })).toMatchObject({
      routines: [saved.routine],
    });
    const id = (saved.routine as { id: string }).id;
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_DELETE, { botId: bob, id })).toMatchObject({
      ok: false,
    });
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_DELETE, { botId: alice, id })).toEqual({ ok: true });
    mocks.settings.botModeEnabled = false;
    expect(await call(IPC_CHANNELS.BOT_ROUTINES_LIST)).toEqual({
      ok: true,
      routines: [],
      enabled: false,
    });
    expect(await call(IPC_CHANNELS.BOT_DELEGATIONS_LIST)).toEqual({
      ok: true,
      delegations: [],
      enabled: false,
    });
    expect(await call(IPC_CHANNELS.BOT_DELEGATION_CANCEL, { id })).toMatchObject({
      ok: false,
      error: 'disabled',
    });
  });
  it('开关关闭：写返回 disabled，列表为空，不落任何 Bot 目录', async () => {
    mocks.settings.botModeEnabled = false;
    expect(await call(IPC_CHANNELS.BOT_CREATE, { name: 'Alice' })).toEqual({
      ok: false,
      error: 'disabled',
    });
    expect(await call(IPC_CHANNELS.BOTS_LIST)).toEqual({ ok: true, bots: [], enabled: false });
    expect(existsSync(join(mocks.root, 'bots'))).toBe(false);
  });

  it('非主窗口写入被拒；名字不能占用 agent 类型名', async () => {
    mocks.isMain.mockReturnValue(false);
    expect(await call(IPC_CHANNELS.BOT_CREATE, { name: 'Alice' })).toMatchObject({ ok: false });
    mocks.isMain.mockReturnValue(true);
    expect(await call(IPC_CHANNELS.BOT_CREATE, { name: 'scout' })).toEqual({
      ok: false,
      error: 'reserved',
    });
    expect(await call(IPC_CHANNELS.BOT_CREATE, { name: 'reviewer' })).toEqual({
      ok: false,
      error: 'reserved',
    });
  });

  it('私聊发送：Main 组装人设并在成员 home 里 spawn，之后 prompt', async () => {
    const alice = await createBot('Alice');
    const draft = { kind: 'direct', members: [alice], workspace: { kind: 'member-home' } };
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, draft);
    const again = await call(IPC_CHANNELS.BOT_CHAT_CREATE, draft);
    const chatId = (created.chat as { id: string }).id;
    expect((again.chat as { id: string }).id).toBe(chatId);

    const sent = await call(IPC_CHANNELS.BOT_SEND, { chatId, text: 'hello', deliveryId: 'd1' });
    expect(sent).toMatchObject({ ok: true });
    const [identity, request, , remote, projectId, options] = mocks.spawnSession.mock.calls[0] as [
      { sessionId: string },
      Record<string, unknown>,
      unknown,
      unknown,
      string,
      { bot: { systemPrompt: string; instruction: { content: string } } },
    ];
    expect(identity.sessionId).toBe(sent.conversationId);
    expect(request).toMatchObject({
      providerId: 'p',
      modelId: 'm',
      cwd: join(mocks.root, 'bots', alice, 'workspace'),
      approvalMode: 'full',
    });
    expect(remote).toBeUndefined();
    expect(projectId).toBeTruthy();
    expect(options.bot.systemPrompt).toContain('You are Alice.');
    expect(options.bot.systemPrompt).toContain('Calm.');
    expect(options.bot.instruction.content).toContain('Bot mode');
    expect(mocks.promptSession).toHaveBeenCalledWith(identity, 'hello', undefined, 'd1');
  });

  it('群聊发送接入；状态和停止可用；改选工作区清空会话；删除群清理目录', async () => {
    const alice = await createBot('Alice');
    const bob = await createBot('Bob');
    const group = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'group',
      title: 'team',
      members: [alice, bob],
      bossBotId: alice,
      workspace: { kind: 'chat-home' },
    });
    expect(group.ok).toBe(true);
    const chatId = (group.chat as { id: string }).id;
    expect(await call(IPC_CHANNELS.BOT_SEND, { chatId, text: 'hi', deliveryId: 'd' })).toEqual({
      ok: true,
    });
    expect(await call(IPC_CHANNELS.BOT_CHAT_STATE, { chatId })).toMatchObject({
      ok: true,
      current: alice,
      queue: [],
      pendingHuman: false,
    });
    expect(await call(IPC_CHANNELS.BOT_CHAT_STOP, { chatId })).toEqual({ ok: true });
    expect(await call(IPC_CHANNELS.BOT_CHAT_STATE, { chatId })).toMatchObject({
      ok: true,
      current: null,
    });

    const { getBotServices } = await import('./bots');
    const session = getBotServices()!.host.ensureSession(chatId, bob);
    if (!session.ok) throw new Error(session.error);
    const code = join(mocks.root, 'code');
    mkdirSync(code);
    const registry = mocks.registry as SourceAuthorityRegistry;
    const project = registry.createProject({ requestId: 'p', path: code });
    if (!project.accepted) throw new Error('project');
    const updated = await call(IPC_CHANNELS.BOT_CHAT_UPDATE, {
      chatId,
      workspace: { kind: 'project', projectId: project.value.projectId },
    });
    expect(updated).toMatchObject({ ok: true, chat: { sessions: {} } });
    expect(registry.conversation(session.conversationId)?.lifecycle).toBe('ended');

    expect(await call(IPC_CHANNELS.BOT_CHAT_DELETE, { chatId })).toEqual({ ok: true });
    expect(existsSync(join(mocks.root, 'bot-chats', chatId))).toBe(false);
  });
});
