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
  isAgentWorkerReady: () => false,
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
  it('自动设置能力：入参收窄；worker 未就绪时报 no-model；开关关闭报 disabled', async () => {
    expect(await call(IPC_CHANNELS.BOT_SUGGEST_ABILITIES, { name: 'x', path: '/etc' })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(
      await call(IPC_CHANNELS.BOT_SUGGEST_ABILITIES, { name: 'Rex', scope: 'Reviews PRs' })
    ).toEqual({ ok: false, error: 'no-model' });
    mocks.settings.botModeEnabled = false;
    expect(await call(IPC_CHANNELS.BOT_SUGGEST_ABILITIES, { name: 'Rex' })).toEqual({
      ok: false,
      error: 'disabled',
    });
  });

  it('mode off disposes the host and rebuilding on mode on creates fresh services', async () => {
    const alice = await createBot('Alice');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'direct',
      members: [alice],
      workspace: { kind: 'member-home' },
    });
    const chatId = (created.chat as { id: string }).id;
    const { getBotServices, syncBotModeServices } = await import('./bots');
    const previous = getBotServices()!;
    await previous.host.deliver(chatId, alice, 'first');
    mocks.settings.botModeEnabled = false;
    syncBotModeServices();
    expect(await previous.host.deliver(chatId, alice, 'later')).toEqual({
      ok: false,
      error: 'disabled',
    });
    expect(getBotServices()).toBeNull();
    mocks.settings.botModeEnabled = true;
    syncBotModeServices();
    expect(getBotServices()).not.toBe(previous);
  });
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
    expect(group.chat).toMatchObject({ routing: { mode: 'smart' } });
    const chatId = (group.chat as { id: string }).id;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await call(IPC_CHANNELS.BOT_SEND, { chatId, text: 'hi', deliveryId: 'd' })).toEqual({
      ok: true,
    });
    // 新群缺省智能选人；worker 不在线没有可用模型 → 兜底群主
    await vi.waitFor(async () =>
      expect(await call(IPC_CHANNELS.BOT_CHAT_STATE, { chatId })).toMatchObject({
        ok: true,
        current: alice,
        queue: [],
        pendingHuman: false,
        routing: false,
      })
    );
    warn.mockRestore();
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

describe('群任务看板 IPC', () => {
  async function team() {
    const alice = await createBot('Alice');
    const bob = await createBot('Bob');
    const carol = await createBot('Carol');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'group',
      title: 'team',
      members: [alice, bob, carol],
      bossBotId: alice,
      workspace: { kind: 'chat-home' },
    });
    const chat = created.chat as { id: string; version: number };
    return { alice, bob, carol, chatId: chat.id, version: chat.version };
  }

  it('入参收窄、新建 / 编辑 / 完成 / 删除，删除群时清理任务文件', async () => {
    const { chatId } = await team();
    expect(await call(IPC_CHANNELS.BOT_TASK_SAVE, { chatId, title: 1 })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(await call(IPC_CHANNELS.BOT_TASK_SAVE, { chatId: '../x', title: 'a' })).toEqual({
      ok: false,
      error: 'invalid',
    });
    const saved = await call(IPC_CHANNELS.BOT_TASK_SAVE, { chatId, title: 'Login', detail: 'd' });
    expect(saved).toMatchObject({ ok: true, task: { seq: 1, status: 'todo', createdBy: 'human' } });
    const id = (saved.task as { id: string }).id;
    expect(await call(IPC_CHANNELS.BOT_TASK_SAVE, { chatId, id, title: 'Login v2' })).toMatchObject(
      { ok: true, task: { title: 'Login v2' } }
    );
    expect(await call(IPC_CHANNELS.BOT_TASK_COMPLETE, { chatId, id, result: 'ok' })).toMatchObject({
      ok: true,
      task: { status: 'done', result: 'ok' },
    });
    expect(await call(IPC_CHANNELS.BOT_TASKS_LIST, { chatId })).toMatchObject({
      ok: true,
      enabled: true,
      tasks: [{ id, status: 'done' }],
    });
    expect(await call(IPC_CHANNELS.BOT_TASK_DELETE, { chatId, id })).toEqual({ ok: true });
    await call(IPC_CHANNELS.BOT_TASK_SAVE, { chatId, title: 'Keep' });
    const file = join(mocks.root, 'bot-chats', chatId, 'tasks.jsonl');
    expect(existsSync(file)).toBe(true);
    expect(await call(IPC_CHANNELS.BOT_CHAT_DELETE, { chatId })).toEqual({ ok: true });
    expect(existsSync(file)).toBe(false);
    expect(await call(IPC_CHANNELS.BOT_TASKS_LIST, { chatId })).toEqual({
      ok: false,
      error: 'invalid',
    });
  });

  it('移出成员时其认领中的任务退回 todo；开关关闭时列表为空、写返回 disabled', async () => {
    const { alice, bob, carol, chatId, version } = await team();
    const { getBotServices } = await import('./bots');
    const services = getBotServices()!;
    services.tasks.add(chatId, 'human', { title: 'Login' });
    expect(services.tasks.claim(chatId, bob, '#1')).toMatchObject({ ok: true });
    expect(
      await call(IPC_CHANNELS.BOT_CHAT_UPDATE, {
        chatId,
        expectedVersion: version,
        members: [alice, carol],
      })
    ).toMatchObject({ ok: true });
    expect(services.tasks.list(chatId)[0]).toMatchObject({ status: 'todo' });
    expect(services.tasks.list(chatId)[0]).not.toHaveProperty('assigneeBotId');
    mocks.settings.botModeEnabled = false;
    expect(await call(IPC_CHANNELS.BOT_TASKS_LIST, { chatId })).toEqual({
      ok: true,
      tasks: [],
      enabled: false,
    });
    expect(await call(IPC_CHANNELS.BOT_TASK_SAVE, { chatId, title: 'x' })).toEqual({
      ok: false,
      error: 'disabled',
    });
  });

  it('group_tasks 工具只对群聊当前会话开放', async () => {
    const { alice, chatId } = await team();
    const { getBotServices, groupTasksTool } = await import('./bots');
    const services = getBotServices()!;
    const session = services.host.ensureSession(chatId, alice);
    if (!session.ok) throw new Error(session.error);
    expect(
      groupTasksTool(
        services,
        session.conversationId,
        { botId: alice, chatId },
        {
          action: 'add',
          title: 'Plan',
        }
      )
    ).toMatchObject({ ok: true, task: { id: '#1', createdBy: 'Alice' } });
    expect(
      groupTasksTool(services, 'stale', { botId: alice, chatId }, { action: 'list' })
    ).toMatchObject({ ok: false });
    expect(
      groupTasksTool(
        services,
        session.conversationId,
        { botId: alice, chatId: null },
        {
          action: 'list',
        }
      )
    ).toMatchObject({ ok: false });
  });

  it('group_history 只读本群时间线，chatId 取自会话权威，越权一律拒绝', async () => {
    const { alice, bob, carol, chatId } = await team();
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'group',
      title: 'other',
      members: [bob, carol],
      bossBotId: bob,
      workspace: { kind: 'chat-home' },
    });
    const other = { chatId: (created.chat as { id: string }).id };
    const { getBotServices, groupHistoryTool } = await import('./bots');
    const services = getBotServices()!;
    services.chats.appendEntry(chatId, {
      kind: 'human',
      text: '本群早期约定：周五发布',
      mentions: [],
      id: 'h1',
      at: 1,
    });
    services.chats.appendEntry(other.chatId, {
      kind: 'human',
      text: '别的群秘密',
      mentions: [],
      id: 'h2',
      at: 1,
    });
    const session = services.host.ensureSession(chatId, alice);
    if (!session.ok) throw new Error(session.error);
    const read = groupHistoryTool(
      services,
      session.conversationId,
      { botId: alice, chatId },
      { query: '约定', chatId: other.chatId }
    );
    expect(read).toMatchObject({
      ok: true,
      entries: [{ from: '用户', text: '本群早期约定：周五发布' }],
    });
    expect(JSON.stringify(read)).not.toContain('别的群秘密');
    expect(groupHistoryTool(services, 'stale', { botId: alice, chatId }, {})).toMatchObject({
      ok: false,
    });
    expect(
      groupHistoryTool(services, session.conversationId, { botId: alice, chatId: null }, {})
    ).toMatchObject({ ok: false });
    expect(
      groupHistoryTool(services, session.conversationId, { botId: bob, chatId }, {})
    ).toMatchObject({ ok: false });
    expect(
      groupHistoryTool(services, session.conversationId, { botId: alice, chatId }, { limit: 'x' })
    ).toMatchObject({ ok: false });
    expect(
      groupHistoryTool(null, session.conversationId, { botId: alice, chatId }, {})
    ).toMatchObject({ ok: false });
  });
});
