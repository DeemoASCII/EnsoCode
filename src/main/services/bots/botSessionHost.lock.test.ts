import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentWorkerEvent } from '../../../shared/types/agent';
import type { BotChat } from '../../../shared/types/bot';
import { SourceAuthorityRegistry } from '../sourceAuthorityRegistry';
import {
  type BotRuntimePort,
  BotSessionHost,
  type BotSessionHostDeps,
  type BotSpawnSpec,
} from './botSessionHost';
import { BotStore } from './botStore';
import { BotChatStore } from './chatStore';

let root: string;
let registry: SourceAuthorityRegistry;
let bots: BotStore;
let chats: BotChatStore;
let runtime: FakeRuntime;
let host: BotSessionHost;

class FakeRuntime implements BotRuntimePort {
  prompts: Array<{ id: string; text: string }> = [];
  steers: Array<{ id: string; text: string }> = [];
  async spawn(_spec: BotSpawnSpec) {
    return { ok: true };
  }
  prompt(id: string, text: string) {
    this.prompts.push({ id, text });
    return { ok: true };
  }
  steer(id: string, text: string) {
    this.steers.push({ id, text });
    return { ok: true };
  }
  async release() {}
  abort() {}
  removeSessionFiles() {}
}

function make(extra: Partial<BotSessionHostDeps> = {}) {
  host = new BotSessionHost({
    bots,
    chats,
    authority: registry,
    runtime,
    emit: () => {},
    ...extra,
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'bot-lock-')));
  registry = new SourceAuthorityRegistry({ registryFile: join(root, 'registry.json') });
  bots = new BotStore(join(root, 'bots'));
  chats = new BotChatStore(join(root, 'bot-chats'));
  runtime = new FakeRuntime();
  make();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function bot(name: string, tools: 'all' | 'readonly' = 'all') {
  const result = bots.create({ name, title: 'Dev', scope: name, persona: '', tools }, []);
  if (!result.ok) throw new Error(result.reason);
  return result.bot;
}

function project(dir = 'code') {
  const path = join(root, dir);
  mkdirSync(path, { recursive: true });
  const created = registry.createProject({ requestId: dir, path });
  if (!created.accepted) throw new Error('project');
  return created.value.projectId;
}

function chat(members: string[], projectId: string, kind: BotChat['kind'] = 'direct'): BotChat {
  const created = chats.create({
    kind,
    title: kind === 'group' ? 'Team' : '',
    members,
    bossBotId: kind === 'group' ? members[0] : null,
    workspace: { kind: 'project', projectId },
  });
  if (!created) throw new Error('chat');
  return created;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const ev = (event: Record<string, unknown>, sessionId: string) =>
  ({ seq: 1, identity: { sessionId, generation: 'g' }, ...event }) as AgentWorkerEvent;
const complete = (id: string) => host.observe(ev({ type: 'turn-completed', turnId: 't' }, id));
const prompted = () => runtime.prompts.map((item) => item.text);

async function send(chatId: string, botId: string, text: string) {
  const result = await host.deliver(chatId, botId, text);
  if (!result.ok) throw new Error(result.error);
  return result;
}

function delegate(parentId: string, botId: string, delegationId: string) {
  const parent = registry.conversation(parentId)!;
  const child = registry.createBotConversation(parent.projectId, {
    botId,
    chatId: null,
    delegationId,
  })!;
  expect(
    host.registerDelegation(child.conversationId, bots.get(botId)!, {
      parentConversationId: parentId,
      chatId: parent.bot?.chatId ?? null,
    })
  ).toBe(true);
  return child.conversationId;
}

describe('BotSessionHost 工作区写锁', () => {
  it('同一工作区只有一个写成员在跑轮，锁释放时只唤醒一个等待者', async () => {
    const projectId = project();
    const [a, b, c] = ['A', 'B', 'C'].map((name) => bot(name));
    const first = await send(chat([a.id], projectId).id, a.id, 'a');
    const second = await send(chat([b.id], projectId).id, b.id, 'b');
    const third = await send(chat([c.id], projectId).id, c.id, 'c');
    expect(second.queued).toBe(true);
    expect(third.queued).toBe(true);
    expect(prompted()).toEqual(['a']);
    complete(first.conversationId);
    await flush();
    expect(prompted()).toEqual(['a', 'b']);
    complete(second.conversationId);
    await flush();
    expect(prompted()).toEqual(['a', 'b', 'c']);
  });

  it('不同工作区、只读成员互不阻塞；同一会话多次投递照常 steer', async () => {
    const a = bot('A');
    const reader = bot('R', 'readonly');
    const other = bot('O');
    const projectId = project();
    const first = await send(chat([a.id], projectId).id, a.id, 'a');
    expect((await send(chat([reader.id], projectId).id, reader.id, 'r')).queued).toBeUndefined();
    expect(
      (await send(chat([other.id], project('elsewhere')).id, other.id, 'o')).queued
    ).toBeUndefined();
    await send(
      chats.get(registry.conversation(first.conversationId)!.bot!.chatId!)!.id,
      a.id,
      'more'
    );
    expect(runtime.steers).toEqual([{ id: first.conversationId, text: 'more' }]);
    expect(prompted()).toEqual(['a', 'r', 'o']);
  });

  it('只读成员在跑时不占锁', async () => {
    const projectId = project();
    const reader = bot('R', 'readonly');
    const a = bot('A');
    await send(chat([reader.id], projectId).id, reader.id, 'r');
    expect((await send(chat([a.id], projectId).id, a.id, 'a')).queued).toBeUndefined();
  });

  it('worker 退出清空锁，等待者随即开跑', async () => {
    const projectId = project();
    const a = bot('A');
    const b = bot('B');
    await send(chat([a.id], projectId).id, a.id, 'a');
    await send(chat([b.id], projectId).id, b.id, 'b');
    host.observe({ type: 'worker-exited' });
    await flush();
    expect(prompted()).toEqual(['a', 'b']);
  });

  it('onlyIfIdle 的投递遇到被占的工作区按忙拒绝，不排队', async () => {
    const projectId = project();
    const a = bot('A');
    const b = bot('B');
    await send(chat([a.id], projectId).id, a.id, 'a');
    expect(
      await host.deliver(chat([b.id], projectId).id, b.id, 'result', { onlyIfIdle: true })
    ).toEqual({ ok: false, error: 'session-busy' });
    expect(host.queueState()).toEqual([]);
  });

  it('群聊成员等待时在时间线写一次「等待 X 释放工作目录」', async () => {
    const projectId = project();
    const a = bot('Alice');
    const b = bot('Bob');
    const d = bot('Dave');
    const alice = await send(chat([a.id], projectId).id, a.id, 'a');
    const group = chat([b.id, d.id], projectId, 'group');
    await send(group.id, b.id, 'b');
    const dave = await send(chat([d.id], project('other')).id, d.id, 'd');
    complete(dave.conversationId);
    await flush();
    expect(prompted()).toEqual(['a', 'd']);
    complete(alice.conversationId);
    await flush();
    expect(prompted()).toEqual(['a', 'd', 'b']);
    const notes = chats
      .readAfter(group.id, 0)
      .filter((entry) => entry.kind === 'system')
      .map((entry) => (entry.kind === 'system' ? entry.text : ''));
    expect(notes).toEqual(['等待 Alice 释放工作目录']);
  });

  it('委派子会话借用祖先的锁：父轮仍在跑时子委派照常开跑，不死锁', async () => {
    const projectId = project();
    const a = bot('A');
    const b = bot('B');
    const c = bot('C');
    const parent = await send(chat([a.id], projectId).id, a.id, 'a');
    const child = delegate(parent.conversationId, b.id, 'd1');
    const sent = await host.deliverConversation(child, 'task', { queueIfBusy: true });
    expect(sent).toMatchObject({ ok: true });
    expect(sent.ok && sent.queued).toBeFalsy();
    const grandchild = delegate(child, c.id, 'd2');
    expect((await host.deliverConversation(grandchild, 'sub', { queueIfBusy: true })).ok).toBe(
      true
    );
    expect(prompted()).toEqual(['a', 'task', 'sub']);
  });

  it('兄弟委派之间仍互斥；父轮结束后的新投递等子委派写完', async () => {
    const projectId = project();
    const a = bot('A');
    const b = bot('B');
    const c = bot('C');
    const parentChat = chat([a.id], projectId);
    const parent = await send(parentChat.id, a.id, 'a');
    const first = delegate(parent.conversationId, b.id, 'd1');
    const second = delegate(parent.conversationId, c.id, 'd2');
    await host.deliverConversation(first, 'one', { queueIfBusy: true });
    expect((await host.deliverConversation(second, 'two', { queueIfBusy: true })).ok).toBe(true);
    expect(prompted()).toEqual(['a', 'one']);
    complete(parent.conversationId);
    await flush();
    expect(prompted()).toEqual(['a', 'one']);
    complete(first);
    await flush();
    expect(prompted()).toEqual(['a', 'one', 'two']);
  });

  it('私聊重试在工作区被占时按忙拒绝', async () => {
    const retries: string[] = [];
    runtime = Object.assign(new FakeRuntime(), {
      retry: (id: string) => {
        retries.push(id);
        return { ok: true };
      },
    });
    make();
    const projectId = project();
    const a = bot('A');
    const b = bot('B');
    await send(chat([a.id], projectId).id, a.id, 'a');
    const session = host.ensureSession(chat([b.id], projectId).id, b.id);
    if (!session.ok) throw new Error(session.error);
    expect(await host.retryConversation(session.conversationId)).toEqual({
      ok: false,
      error: 'session-busy',
    });
    expect(retries).toEqual([]);
  });
});
