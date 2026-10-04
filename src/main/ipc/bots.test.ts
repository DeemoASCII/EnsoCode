import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
vi.mock('../services/notifications', () => ({ notifyBotChat: vi.fn(async () => {}) }));
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

  it('输入框引用：越权与不存在的标识在发给 worker 之前拒绝；技能与聊天摘录由 Main 展开', async () => {
    const alice = await createBot('Alice');
    const bob = await createBot('Bob');
    const direct = async (members: string[]) =>
      (
        (
          await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
            kind: 'direct',
            members,
            workspace: { kind: 'member-home' },
          })
        ).chat as { id: string }
      ).id;
    const chatId = await direct([alice]);
    const otherId = await direct([bob]);
    const home = join(mocks.root, 'bots', alice, 'workspace');
    mkdirSync(join(home, 'src'), { recursive: true });
    writeFileSync(join(home, 'src', 'a.ts'), 'x');
    writeFileSync(join(mocks.root, 'outside.txt'), 'x');
    const skillDir = join(mocks.root, 'skills', 'review');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: review\n---\nReview carefully.');
    mocks.settings.skills = [
      { id: 's-review', name: 'review', description: '', path: skillDir, source: 'x' },
    ];

    const send = (extra: Record<string, unknown>) =>
      call(IPC_CHANNELS.BOT_SEND, {
        chatId,
        text: 'hi',
        deliveryId: crypto.randomUUID(),
        ...extra,
      });
    expect(await send({ chats: ['99999999-9999-4999-8999-999999999999'] })).toEqual({
      ok: false,
      error: 'chat-ref-not-found',
    });
    expect(await send({ files: ['../../outside.txt'] })).toEqual({
      ok: false,
      error: 'file-outside-workspace',
    });
    expect(await send({ skill: 's-review' })).toEqual({ ok: false, error: 'skill-unavailable' });
    expect(mocks.spawnSession).not.toHaveBeenCalled();
    expect(mocks.promptSession).not.toHaveBeenCalled();

    expect(
      await call(IPC_CHANNELS.BOT_FILE_SEARCH, {
        chatId: '99999999-9999-4999-8999-999999999999',
        query: '',
      })
    ).toEqual({ ok: false, error: 'invalid' });
    expect(await call(IPC_CHANNELS.BOT_FILE_SEARCH, { chatId, query: 'a', root: '/' })).toEqual({
      ok: false,
      error: 'invalid',
    });
    const found = await call(IPC_CHANNELS.BOT_FILE_SEARCH, { chatId, query: 'a.ts' });
    expect(found).toMatchObject({ ok: true, files: [{ relativePath: 'src/a.ts' }] });

    const sent = await send({ files: ['src/a.ts'], chats: [otherId], text: '看 @src/a.ts' });
    expect(sent).toMatchObject({ ok: true });
    const text = mocks.promptSession.mock.calls[0][1] as string;
    expect(text.startsWith('看 @src/a.ts\n\n<chat-reference id="')).toBe(true);
    expect(text).toContain('title="Bob" kind="direct"');
  });

  it('私聊回退：校验目标、取消越过的委派、退回记忆水位；群聊与忙碌会话拒绝', async () => {
    const alice = await createBot('Alice');
    const bob = await createBot('Bob');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'direct',
      members: [alice],
      workspace: { kind: 'member-home' },
    });
    const chatId = (created.chat as { id: string }).id;
    const { getBotServices, rewindBotChat, retryBotChat } = await import('./bots');
    const services = getBotServices()!;
    const session = services.host.ensureSession(chatId, alice);
    if (!session.ok) throw new Error(session.error);
    const conv = session.conversationId;
    const rewind = vi.fn((..._args: unknown[]) => ({ ok: true }));
    (
      services.host as unknown as { deps: { runtime: Record<string, unknown> } }
    ).deps.runtime.rewind = rewind;
    const branch = [
      { id: 'h' },
      { id: 'u1', userAt: 100 },
      { id: 'a1' },
      { id: 'u2', userAt: 200 },
      { id: 'a2' },
    ];
    const readBranch = async () => branch;
    const save = (patch: Record<string, unknown>) =>
      (
        services.delegations as unknown as { deps: { store: { save(r: unknown): void } } }
      ).deps.store.save({
        id: crypto.randomUUID(),
        parentConversationId: conv,
        parentBotId: alice,
        targetBotId: bob,
        chatId,
        task: 't',
        context: '',
        childConversationId: crypto.randomUUID(),
        depth: 1,
        ...patch,
      });
    const ids = { old: crypto.randomUUID(), late: crypto.randomUUID(), live: crypto.randomUUID() };
    save({ id: ids.old, state: 'completed', createdAt: 150 });
    save({ id: ids.late, state: 'completed', createdAt: 250 });
    save({ id: ids.live, state: 'running', createdAt: 260 });
    services.chats.update(chatId, (draft) => {
      draft.sessions[alice].distilledTo = 'a2';
      return draft;
    });

    expect(await rewindBotChat(services, { chatId, entryId: 'a1' }, readBranch)).toEqual({
      ok: false,
      error: 'rewind-target-not-found',
    });
    expect(
      await rewindBotChat(services, { chatId, entryId: 'u2', path: '/x' }, readBranch)
    ).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(rewind).not.toHaveBeenCalled();

    expect(
      await rewindBotChat(services, { chatId, entryId: 'u2', restoreFiles: true }, readBranch)
    ).toEqual({ ok: true });
    expect(rewind).toHaveBeenCalledWith(conv, 'u2', true);
    const state = (key: keyof typeof ids) =>
      services.delegations.list().find((item) => item.id === ids[key]);
    expect(state('old')?.deliveredAt).toBeUndefined();
    expect(state('late')?.deliveredAt).toBeDefined();
    expect(state('live')).toMatchObject({ state: 'canceled' });
    expect(state('live')?.deliveredAt).toBeDefined();
    expect(services.chats.get(chatId)?.sessions[alice].distilledTo).toBe('a1');

    await services.host.deliver(chatId, alice, 'busy now');
    expect(await rewindBotChat(services, { chatId, entryId: 'u1' }, readBranch)).toEqual({
      ok: false,
      error: 'session-busy',
    });
    expect(await retryBotChat(services, { chatId })).toEqual({ ok: false, error: 'session-busy' });

    const group = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'group',
      title: 'team',
      members: [alice, bob],
      bossBotId: alice,
      workspace: { kind: 'chat-home' },
    });
    const groupId = (group.chat as { id: string }).id;
    expect(await rewindBotChat(services, { chatId: groupId, entryId: 'u1' }, readBranch)).toEqual({
      ok: false,
      error: 'direct-only',
    });
    expect(await retryBotChat(services, { chatId: groupId })).toEqual({
      ok: false,
      error: 'direct-only',
    });
  });

  it('核心笔记：入参收窄、version 防覆盖、只支持群笔记，保存后注入新会话系统提示词', async () => {
    const alice = await createBot('Alice');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'direct',
      members: [alice],
      workspace: { kind: 'member-home' },
    });
    const chatId = (created.chat as { id: string }).id;
    for (const bad of [undefined, { botId: 'x' }, { botId: alice, path: '/etc' }, { chatId }])
      expect(await call(IPC_CHANNELS.BOT_NOTES_GET, bad)).toEqual({ ok: false, error: 'invalid' });
    const empty = await call(IPC_CHANNELS.BOT_NOTES_GET, { botId: alice });
    expect(empty).toMatchObject({ ok: true, notes: { content: '', maxChars: 3000 } });
    const version = (empty.notes as { version: string }).version;
    mocks.isMain.mockReturnValue(false);
    expect(
      await call(IPC_CHANNELS.BOT_NOTES_SAVE, { botId: alice, content: '- tea', version })
    ).toMatchObject({ ok: false });
    mocks.isMain.mockReturnValue(true);
    const saved = await call(IPC_CHANNELS.BOT_NOTES_SAVE, {
      botId: alice,
      content: '- likes tea',
      version,
    });
    expect(saved).toMatchObject({ ok: true, notes: { content: '- likes tea' } });
    expect(
      await call(IPC_CHANNELS.BOT_NOTES_SAVE, { botId: alice, content: '- coffee', version })
    ).toEqual({ ok: false, error: 'conflict' });
    expect(
      await call(IPC_CHANNELS.BOT_NOTES_SAVE, { chatId, content: '- x', version: '' })
    ).toEqual({ ok: false, error: 'invalid' });

    await call(IPC_CHANNELS.BOT_SEND, { chatId, text: 'hello', deliveryId: 'd1' });
    const options = mocks.spawnSession.mock.calls[0][5] as { bot: { systemPrompt: string } };
    expect(options.bot.systemPrompt).toContain('<member-notes>\n- likes tea\n</member-notes>');
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

describe('例行任务生命周期', () => {
  async function group(options: { bobAcceptsNobody?: boolean } = {}) {
    const alice = await createBot('Alice');
    const created = await call(IPC_CHANNELS.BOT_CREATE, {
      name: 'Bob',
      persona: 'Calm.',
      ...(options.bobAcceptsNobody ? { delegation: { canDelegateTo: 'any', acceptFrom: [] } } : {}),
    });
    const bob = (created.bot as { id: string }).id;
    const carol = await createBot('Carol');
    const chat = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'group',
      title: 'team',
      members: [alice, bob],
      bossBotId: alice,
      workspace: { kind: 'chat-home' },
    });
    const chatId = (chat.chat as { id: string }).id;
    const { getBotServices, routineProposeTool } = await import('./bots');
    const services = getBotServices()!;
    const session = services.host.ensureSession(chatId, alice);
    if (!session.ok) throw new Error(session.error);
    return { alice, bob, carol, chatId, services, routineProposeTool, session };
  }

  it('routine_propose：只对成员当前会话开放，解析简单调度，越权与坏参数拒绝', async () => {
    const { alice, bob, chatId, services, routineProposeTool, session } = await group();
    const binding = { botId: alice, chatId };
    const params = { title: '日报', prompt: '汇总今天的进展', schedule: '工作日 18:30' };
    for (const [conversationId, bad] of [
      ['stale', binding],
      [session.conversationId, { botId: alice, chatId: null }],
      [session.conversationId, { ...binding, delegationId: 'd' }],
      [session.conversationId, { botId: bob, chatId }],
    ] as const)
      expect(routineProposeTool(services, conversationId, bad, params)).toMatchObject({
        ok: false,
      });
    expect(routineProposeTool(null, session.conversationId, binding, params)).toMatchObject({
      ok: false,
    });
    expect(
      routineProposeTool(services, session.conversationId, binding, {
        ...params,
        schedule: 'sometimes',
      })
    ).toMatchObject({ ok: false, error: expect.stringContaining('cron') });
    expect(
      routineProposeTool(services, session.conversationId, binding, { ...params, prompt: '' })
    ).toMatchObject({ ok: false });
    expect(
      routineProposeTool(services, session.conversationId, binding, {
        ...params,
        doneBy: 'Nobody',
      })
    ).toMatchObject({ ok: false });
    expect(
      routineProposeTool(services, session.conversationId, binding, { ...params, doneBy: 'carol' })
    ).toMatchObject({ ok: false });

    const proposed = routineProposeTool(services, session.conversationId, binding, {
      ...params,
      doneBy: 'bob',
    });
    expect(proposed).toMatchObject({ ok: true, status: 'draft', doneBy: 'Bob' });
    const listed = await call(IPC_CHANNELS.BOT_ROUTINES_LIST, { botId: alice });
    expect(listed.routines).toEqual([
      expect.objectContaining({
        status: 'draft',
        schedule: '30 18 * * 1-5',
        doneBy: bob,
        proposedBy: alice,
      }),
    ]);
    const id = (proposed as { id: string }).id;
    expect(services.chats.readEntries(chatId).at(-1)).toMatchObject({
      kind: 'system',
      routine: { botId: alice, id },
      text: expect.stringContaining('等待批准'),
    });
  });

  it('routine_propose 遵守委派 ACL：执行成员不接受委派时拒绝', async () => {
    const { alice, chatId, services, routineProposeTool, session } = await group({
      bobAcceptsNobody: true,
    });
    expect(
      routineProposeTool(
        services,
        session.conversationId,
        { botId: alice, chatId },
        { title: 't', prompt: 'p', schedule: 'hourly', doneBy: 'Bob' }
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining('does not accept') });
    expect(
      await call(IPC_CHANNELS.BOT_ROUTINE_SAVE, {
        botId: alice,
        chatId,
        title: 't',
        prompt: 'p',
        schedule: '0 9 * * *',
        doneBy: (services.bots.list().find((bot) => bot.name === 'Bob') as { id: string }).id,
      })
    ).toEqual({ ok: false, error: 'acl' });
  });

  it('审批、试运行、手动运行与运行历史经 IPC 收窄', async () => {
    const { alice, chatId, services, routineProposeTool, session } = await group();
    const proposed = routineProposeTool(
      services,
      session.conversationId,
      { botId: alice, chatId },
      { title: '日报', prompt: '写日报', schedule: 'daily 09:00' }
    ) as { id: string };
    const target = { botId: alice, id: proposed.id };
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_REVIEW, { ...target, approve: 'yes' })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_RUNS, { botId: '../x', id: proposed.id })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_RUN_NOW, target)).toEqual({
      ok: false,
      error: 'not-approved',
    });
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_RUN_NOW, { ...target, dryRun: 1 })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_RUN_NOW, { ...target, dryRun: true })).toEqual({
      ok: true,
    });
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_RUNS, target)).toMatchObject({
      ok: true,
      runs: [{ trigger: 'dry-run', executorId: alice, chatId }],
    });
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_RUN_NOW, { ...target, dryRun: true })).toEqual({
      ok: false,
      error: 'busy',
    });
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_REVIEW, { ...target, approve: true })).toMatchObject(
      { ok: true, routine: { status: 'enabled', approvedVersion: 1 } }
    );
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_REVIEW, { ...target, approve: true })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_DELETE, target)).toEqual({ ok: true });
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_RUNS, target)).toEqual({ ok: true, runs: [] });
  });

  it('保存时执行成员不在目标聊天里拒绝；成员离群后依赖检查自动阻塞', async () => {
    const { alice, bob, carol, chatId, services } = await group();
    const draft = { botId: alice, chatId, title: 't', prompt: 'p', schedule: '0 9 * * *' };
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_SAVE, { ...draft, doneBy: carol })).toEqual({
      ok: false,
      error: 'invalid',
    });
    const saved = await call(IPC_CHANNELS.BOT_ROUTINE_SAVE, { ...draft, doneBy: bob });
    expect(saved).toMatchObject({ ok: true, routine: { status: 'enabled', doneBy: bob } });
    const id = (saved.routine as { id: string }).id;
    expect(
      services.chats.update(chatId, (chat) => ({ ...chat, members: [alice, carol] }))
    ).toBeTruthy();
    expect(services.scheduler.verify(alice, id)).toMatchObject({
      status: 'blocked',
      blockedReason: 'not-in-chat',
    });
  });
});

describe('聊天管理', () => {
  it('搁置会取消置顶，稍后提醒隐含搁置，置顶顺序只在置顶时保留；人类发言取消搁置', async () => {
    const alice = await createBot('Alice');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'direct',
      members: [alice],
      workspace: { kind: 'member-home' },
    });
    const chatId = (created.chat as { id: string }).id;
    const update = async (patch: Record<string, unknown>) =>
      (await call(IPC_CHANNELS.BOT_CHAT_UPDATE, { chatId, ...patch })).chat as Record<
        string,
        unknown
      >;
    expect(await update({ pinned: true, pinOrder: 2 })).toMatchObject({
      pinned: true,
      pinOrder: 2,
    });
    const settled = await update({ settled: true });
    expect(settled).toMatchObject({ pinned: false });
    expect(settled.settledAt).toEqual(expect.any(Number));
    expect(settled.pinOrder).toBeUndefined();
    const until = Date.now() + 3_600_000;
    expect(await update({ settled: false, snoozedUntil: until })).toMatchObject({
      snoozedUntil: until,
      settledAt: expect.any(Number),
    });
    expect(await call(IPC_CHANNELS.BOT_CHAT_UPDATE, { chatId, snoozedUntil: -5 })).toEqual({
      ok: false,
      error: 'invalid',
    });
    await call(IPC_CHANNELS.BOT_SEND, { chatId, text: 'back', deliveryId: 'w1' });
    const list = await call(IPC_CHANNELS.BOT_CHATS_LIST);
    const chat = (list.chats as Record<string, unknown>[]).find((item) => item.id === chatId);
    expect(chat?.settledAt).toBeUndefined();
    expect(chat?.snoozedUntil).toBeUndefined();
  });
});
