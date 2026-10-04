import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentWorkerEvent } from '../../../shared/types/agent';
import type { BotChat } from '../../../shared/types/bot';
import { SourceAuthorityRegistry } from '../sourceAuthorityRegistry';
import {
  type BotRuntimePort,
  BotSessionHost,
  type BotSpawnSpec,
  type BotTurnFinished,
} from './botSessionHost';
import { BotStore } from './botStore';
import { BotChatStore } from './chatStore';

let root: string;
let registry: SourceAuthorityRegistry;
let bots: BotStore;
let chats: BotChatStore;
let runtime: FakeRuntime;
let events: Array<{ kind: string; chatId?: string }>;
let host: BotSessionHost;

class FakeRuntime implements BotRuntimePort {
  spawns: BotSpawnSpec[] = [];
  prompts: Array<{ id: string; text: string }> = [];
  steers: Array<{ id: string; text: string }> = [];
  released: string[] = [];
  aborted: string[] = [];
  removedFiles: string[] = [];
  spawnResult = { ok: true } as { ok: boolean; error?: string };
  async spawn(spec: BotSpawnSpec) {
    this.spawns.push(spec);
    return this.spawnResult;
  }
  prompt(id: string, text: string) {
    this.prompts.push({ id, text });
    return { ok: true };
  }
  steer(id: string, text: string) {
    this.steers.push({ id, text });
    return { ok: true };
  }
  async release(id: string) {
    this.released.push(id);
  }
  abort(id: string) {
    this.aborted.push(id);
  }
  removeSessionFiles(conversation: { conversationId: string }) {
    this.removedFiles.push(conversation.conversationId);
  }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'bot-host-')));
  registry = new SourceAuthorityRegistry({ registryFile: join(root, 'registry.json') });
  bots = new BotStore(join(root, 'bots'));
  chats = new BotChatStore(join(root, 'bot-chats'));
  runtime = new FakeRuntime();
  events = [];
  host = new BotSessionHost({
    bots,
    chats,
    authority: registry,
    runtime,
    emit: (event) => events.push(event),
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function bot(name: string, persona = '') {
  const result = bots.create({ name, title: 'Dev', scope: `${name} scope`, persona }, []);
  if (!result.ok) throw new Error(result.reason);
  return result.bot;
}

function direct(botId: string, workspace: BotChat['workspace'] = { kind: 'member-home' }) {
  const chat = chats.create({
    kind: 'direct',
    title: '',
    members: [botId],
    bossBotId: null,
    workspace,
  });
  if (!chat) throw new Error('chat');
  return chat;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function ev(event: Record<string, unknown>, sessionId: string): AgentWorkerEvent {
  return { seq: 1, identity: { sessionId, generation: 'g' }, ...event } as AgentWorkerEvent;
}

describe('BotSessionHost.ensureSession', () => {
  it('deduplicates queued delivery IDs and recognizes delegation results persisted in user messages', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const sent = await host.deliver(chat.id, alice.id, 'first', { deliveryId: 'first' });
    if (!sent.ok) throw new Error(sent.error);
    await host.deliver(chat.id, alice.id, 'later', { deliveryId: 'later', queueIfBusy: true });
    await host.deliver(chat.id, alice.id, 'later', { deliveryId: 'later', queueIfBusy: true });
    expect(host.queueState()).toHaveLength(1);
    const file = join(root, 'session.jsonl');
    writeFileSync(
      file,
      JSON.stringify({
        type: 'message',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<delegation-result id="persisted" from="Bob">done</delegation-result>',
            },
          ],
        },
      })
    );
    const conversation = registry.conversation(sent.conversationId)!;
    const original = registry.conversation.bind(registry);
    registry.conversation = (id) =>
      id === sent.conversationId ? { ...conversation, sessionFile: file } : original(id);
    expect(host.hasStartedDelivery(sent.conversationId, 'persisted')).toBe(true);
    expect(host.hasStartedDelivery(sent.conversationId, 'absent')).toBe(false);
    await host.deliver(chat.id, alice.id, 'do not replay', { deliveryId: 'persisted' });
    expect(runtime.steers).toHaveLength(0);
  });
  it('idle does not start queued routines or misattribute the completed result', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const results: BotTurnFinished[] = [];
    host.onTurnFinished((event) => results.push(event));
    const first = await host.deliver(chat.id, alice.id, 'first', { deliveryId: 'first' });
    if (!first.ok) throw new Error(first.error);
    await host.deliver(chat.id, alice.id, 'routine', { queueIfBusy: true, deliveryId: 'routine' });
    host.observe(ev({ type: 'status', status: 'running' }, first.conversationId));
    host.observe(
      ev(
        {
          type: 'message-upsert',
          index: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
        },
        first.conversationId
      )
    );
    host.observe(ev({ type: 'status', status: 'idle' }, first.conversationId));
    await flush();
    expect(runtime.prompts).toHaveLength(1);
    expect(host.runningCount()).toBe(1);
    host.observe(ev({ type: 'turn-completed', turnId: 'first-turn' }, first.conversationId));
    await flush();
    expect(results).toMatchObject([{ deliveryId: 'first', text: 'first answer' }]);
    expect(runtime.prompts).toHaveLength(2);
  });

  it('retiring a session settles queued deliveries exactly once as canceled', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const results: BotTurnFinished[] = [];
    host.onTurnFinished((event) => results.push(event));
    const first = await host.deliver(chat.id, alice.id, 'first');
    if (!first.ok) throw new Error(first.error);
    await host.deliver(chat.id, alice.id, 'routine', { queueIfBusy: true, deliveryId: 'routine' });
    host.retireSession(first.conversationId);
    host.retireSession(first.conversationId);
    expect(results.filter((event) => event.deliveryId === 'routine')).toMatchObject([
      { ok: false, error: 'canceled' },
    ]);
    expect(host.runningCount()).toBe(0);
  });

  it('disabling the host rejects new delivery and cancels queued work', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const results: BotTurnFinished[] = [];
    host.onTurnFinished((event) => results.push(event));
    await host.deliver(chat.id, alice.id, 'first');
    await host.deliver(chat.id, alice.id, 'routine', { queueIfBusy: true, deliveryId: 'routine' });
    host.dispose();
    expect(await host.deliver(chat.id, alice.id, 'later')).toEqual({
      ok: false,
      error: 'disabled',
    });
    expect(results.filter((event) => event.deliveryId === 'routine')).toMatchObject([
      { ok: false, error: 'canceled' },
    ]);
    expect(host.runningCount()).toBe(0);
  });
  it('queues autonomous deliveries behind an active turn rather than steering', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const first = await host.deliver(chat.id, alice.id, 'first');
    if (!first.ok) throw new Error(first.error);
    await host.deliver(chat.id, alice.id, 'routine', {
      queueIfBusy: true,
      deliveryId: 'routine-1',
    });
    expect(runtime.steers).toHaveLength(0);
    expect(runtime.prompts).toHaveLength(1);
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, first.conversationId));
    await flush();
    expect(runtime.prompts.map((item) => item.text)).toEqual(['first', 'routine']);
  });
  it('成员 home：登记隐藏项目、写入 Main 绑定并记录 cursor；幂等；fresh 开新会话并结束旧会话', () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const first = host.ensureSession(chat.id, alice.id);
    if (!first.ok) throw new Error(first.error);
    const conversation = registry.conversation(first.conversationId);
    expect(conversation?.bot).toEqual({ botId: alice.id, chatId: chat.id });
    const project = registry.project(conversation!.projectId);
    expect(project).toMatchObject({ kind: 'bot-home', canonicalPath: bots.homeDir(alice.id) });
    expect(existsSync(bots.homeDir(alice.id))).toBe(true);
    expect(chats.get(chat.id)?.sessions[alice.id]).toEqual({
      conversationId: first.conversationId,
      cursor: 0,
    });

    expect(host.ensureSession(chat.id, alice.id)).toEqual(first);
    const fresh = host.ensureSession(chat.id, alice.id, { fresh: true });
    expect(fresh.ok && fresh.conversationId).not.toBe(first.conversationId);
    expect(registry.conversation(first.conversationId)?.lifecycle).toBe('ended');
    expect(host.sessionsOf(chat.id).map((s) => s.current)).toEqual([false, true]);
  });

  it('Code 项目工作区：cwd 取项目路径；项目移除或 ssh 时报错', () => {
    const alice = bot('Alice');
    const code = join(root, 'code');
    mkdirSync(code);
    const project = registry.createProject({ requestId: 'p', path: code });
    if (!project.accepted) throw new Error('project');
    const chat = direct(alice.id, { kind: 'project', projectId: project.value.projectId });
    const session = host.ensureSession(chat.id, alice.id);
    expect(session.ok && registry.conversation(session.conversationId)?.projectId).toBe(
      project.value.projectId
    );
    expect(host.workspacePath(chat.id)).toBe(code);

    registry.removeProject({ requestId: 'r', projectId: project.value.projectId, version: 1 });
    expect(host.ensureSession(chat.id, alice.id)).toEqual({
      ok: false,
      error: 'workspace-unavailable',
    });
  });

  it('群独立工作区：建目录并登记为 bot-home；归档成员与非成员被拒绝', () => {
    const alice = bot('Alice');
    const bob = bot('Bob');
    const chatId = '55555555-5555-4555-8555-555555555555';
    const home = registry.ensureBotHomeProject(chats.workspaceDir(chatId));
    const chat = chats.create(
      {
        kind: 'group',
        title: 'g',
        members: [alice.id, bob.id],
        bossBotId: alice.id,
        workspace: { kind: 'chat-home', projectId: home!.projectId },
      },
      chatId
    );
    const session = host.ensureSession(chat!.id, bob.id);
    expect(session.ok && registry.conversation(session.conversationId)?.projectId).toBe(
      home!.projectId
    );
    bots.setArchived(alice.id, true);
    expect(host.ensureSession(chat!.id, alice.id)).toEqual({ ok: false, error: 'bot-archived' });
    const carol = bot('Carol');
    expect(host.ensureSession(chat!.id, carol.id)).toEqual({ ok: false, error: 'not-member' });
  });
});

describe('BotSessionHost.deliver', () => {
  it('未运行 → spawn（带人设）后 prompt；运行中 → steer；释放后带 sessionFile 恢复', async () => {
    const alice = bot('Alice', 'Be kind.');
    const chat = direct(alice.id);
    const result = await host.deliver(chat.id, alice.id, 'hi');
    if (!result.ok) throw new Error(result.error);
    expect(runtime.spawns).toHaveLength(1);
    expect(runtime.spawns[0]).toMatchObject({
      conversationId: result.conversationId,
      cwd: bots.homeDir(alice.id),
    });
    expect(runtime.spawns[0].resumeFile).toBeUndefined();
    expect(runtime.spawns[0].systemPrompt).toContain('Be kind.');
    expect(runtime.spawns[0].instructionText).toContain('Bot mode');
    expect(runtime.prompts).toEqual([{ id: result.conversationId, text: 'hi' }]);

    await host.deliver(chat.id, alice.id, 'more');
    expect(runtime.steers).toEqual([{ id: result.conversationId, text: 'more' }]);

    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, result.conversationId));
    registry.markReady(result.conversationId, join(root, 's.jsonl'), {
      providerId: 'p',
      modelId: 'm',
    });
    host.observe(ev({ type: 'parent-ended', reason: 'idle' }, result.conversationId));
    await host.deliver(chat.id, alice.id, 'again');
    expect(runtime.spawns).toHaveLength(2);
    expect(runtime.spawns[1].resumeFile).toBe(join(root, 's.jsonl'));
  });

  it('spawn 失败返回错误且不 prompt、不占并发位', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    runtime.spawnResult = { ok: false, error: 'no model' };
    expect(await host.deliver(chat.id, alice.id, 'hi')).toEqual({ ok: false, error: 'no model' });
    expect(runtime.prompts).toHaveLength(0);
    expect(host.runningCount()).toBe(0);
  });

  it('全局最多 4 轮并发，超出 FIFO 排队并推送 queue 事件；一轮结束后补位', async () => {
    const chatIds: string[] = [];
    const conversationIds: string[] = [];
    for (const name of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']) {
      const member = bot(name);
      const chat = direct(member.id);
      chatIds.push(chat.id);
      const result = await host.deliver(chat.id, member.id, name);
      if (!result.ok) throw new Error(result.error);
      conversationIds.push(result.conversationId);
      expect(result.queued === true).toBe(chatIds.length > 4);
    }
    expect(runtime.prompts.map((p) => p.text)).toEqual(['A1', 'A2', 'A3', 'A4']);
    expect(events).toContainEqual({ kind: 'queue', chatId: chatIds[4] });
    expect(host.queueState().map((q) => q.chatId)).toEqual([chatIds[4], chatIds[5]]);

    host.observe(ev({ type: 'turn-failed', turnId: 't', error: 'x' }, conversationIds[1]));
    await flush();
    expect(runtime.prompts.map((p) => p.text)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
    expect(host.queueState().map((q) => q.position)).toEqual([0]);
  });

  it('worker 退出后清空运行态，下一次投递重新 spawn', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    await host.deliver(chat.id, alice.id, 'hi');
    host.observe({ type: 'worker-exited' });
    expect(host.runningCount()).toBe(0);
    await host.deliver(chat.id, alice.id, 'again');
    expect(runtime.spawns).toHaveLength(2);
    expect(runtime.steers).toHaveLength(0);
  });

  it('stop aborts the active turn, drops queued work and preserves the resumable conversation', async () => {
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: () => {},
      maxRunningTurns: 1,
    });
    const alice = bot('Alice');
    const bob = bot('Bob');
    const aliceChat = direct(alice.id);
    const bobChat = direct(bob.id);
    const first = await host.deliver(aliceChat.id, alice.id, 'active');
    const second = await host.deliver(bobChat.id, bob.id, 'queued');
    if (!first.ok || !second.ok) throw new Error('fixture');
    await host.stopTurn(bobChat.id, bob.id);
    expect(host.queueState()).toEqual([]);
    await host.stopTurn(aliceChat.id, alice.id);
    expect(runtime.aborted).toContain(first.conversationId);
    expect(host.runningCount()).toBe(0);
    expect(registry.conversation(first.conversationId)?.lifecycle).not.toBe('ended');
    expect(runtime.prompts.map((p) => p.text)).toEqual(['active']);
    await host.deliver(aliceChat.id, alice.id, 'next');
    expect(runtime.spawns).toHaveLength(2);
    expect(runtime.prompts.at(-1)?.text).toBe('next');
  });

  it('同会话排队的后续消息在它 spawn + prompt 之后才 steer', async () => {
    const order: string[] = [];
    const slow = new FakeRuntime();
    slow.spawn = async (spec) => {
      order.push('spawn');
      await flush();
      return FakeRuntime.prototype.spawn.call(slow, spec);
    };
    slow.prompt = (_id, text) => {
      order.push(`prompt:${text}`);
      return { ok: true };
    };
    slow.steer = (_id, text) => {
      order.push(`steer:${text}`);
      return { ok: true };
    };
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime: slow,
      emit: () => {},
      maxRunningTurns: 1,
    });
    const alice = bot('Alice');
    const bob = bot('Bob');
    const first = await host.deliver(direct(alice.id).id, alice.id, 'a');
    const bobChat = direct(bob.id);
    expect(await host.deliver(bobChat.id, bob.id, 'b1')).toMatchObject({ queued: true });
    expect(await host.deliver(bobChat.id, bob.id, 'b2')).toMatchObject({ queued: true });
    if (!first.ok) throw new Error(first.error);
    host.observe(ev({ type: 'turn-completed', turnId: 't' }, first.conversationId));
    await flush();
    await flush();
    expect(order.slice(2)).toEqual(['spawn', 'prompt:b1', 'steer:b2']);
  });
});

describe('BotSessionHost turn results', () => {
  it('turn-completed 回调这一轮最后一条 assistant 文本；中断记为失败；Code 会话不回调', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    const result = await host.deliver(chat.id, alice.id, 'hi');
    if (!result.ok) throw new Error(result.error);
    const id = result.conversationId;
    host.observe(ev({ type: 'status', status: 'running' }, id));
    const assistant = (index: number, text: string, extra = {}) =>
      ev(
        {
          type: 'message-upsert',
          index,
          message: { role: 'assistant', content: [{ type: 'text', text }], ...extra },
        },
        id
      );
    host.observe(assistant(1, 'thinking about it'));
    host.observe(assistant(3, 'Done: '));
    host.observe(assistant(3, 'Done: shipped.'));
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, id));
    expect(finished).toEqual([
      {
        chatId: chat.id,
        botId: alice.id,
        conversationId: id,
        turnId: 't1',
        text: 'Done: shipped.',
        ok: true,
      },
    ]);

    host.observe(ev({ type: 'status', status: 'running' }, id));
    host.observe(assistant(5, 'partial', { stopReason: 'aborted' }));
    host.observe(ev({ type: 'turn-completed', turnId: 't2' }, id));
    expect(finished[1]).toMatchObject({ turnId: 't2', ok: false, text: 'partial' });

    host.observe(ev({ type: 'turn-completed', turnId: 'x' }, crypto.randomUUID()));
    expect(finished).toHaveLength(2);
  });
});

describe('BotSessionHost cleanup', () => {
  it('resetSessions 结束旧会话并清空 sessions；discardChat 删除会话、文件与聊天目录', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const result = await host.deliver(chat.id, alice.id, 'hi');
    if (!result.ok) throw new Error(result.error);
    host.resetSessions(chat.id);
    expect(chats.get(chat.id)?.sessions).toEqual({});
    expect(registry.conversation(result.conversationId)?.lifecycle).toBe('ended');
    expect(runtime.released).toContain(result.conversationId);

    const next = host.ensureSession(chat.id, alice.id);
    host.discardChat(chat.id);
    expect(chats.get(chat.id)).toBeUndefined();
    expect(registry.conversation(result.conversationId)).toBeUndefined();
    expect(next.ok && registry.conversation(next.conversationId)).toBeUndefined();
    expect(runtime.removedFiles).toHaveLength(2);
  });

  it('discardBot 级联删除私聊与成员 home，群主被拒绝', () => {
    const alice = bot('Alice');
    const bob = bot('Bob');
    const chat = direct(alice.id);
    host.ensureSession(chat.id, alice.id);
    const code = join(root, 'code');
    mkdirSync(code);
    const project = registry.createProject({ requestId: 'p', path: code });
    if (!project.accepted) throw new Error('project');
    const group = chats.create({
      kind: 'group',
      title: 'g',
      members: [alice.id, bob.id],
      bossBotId: bob.id,
      workspace: { kind: 'project', projectId: project.value.projectId },
    });
    expect(host.discardBot(bob.id)).toEqual({ ok: false, reason: 'boss', chatIds: [group!.id] });
    expect(host.discardBot(alice.id)).toEqual({ ok: true });
    expect(chats.get(chat.id)).toBeUndefined();
    expect(bots.get(alice.id)).toBeUndefined();
    expect(existsSync(bots.homeDir(alice.id))).toBe(false);
    expect(chats.get(group!.id)?.members).toEqual([alice.id, bob.id]);
  });
});
