import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotTurnFinished } from './botSessionHost';
import { BotStore } from './botStore';
import { BotChatStore } from './chatStore';
import { GroupChatService } from './groupChat';

let root: string;
let bots: BotStore;
let chats: BotChatStore;
let group: GroupChatService;
let a: string;
let b: string;
let id: string;
let finish: (event: BotTurnFinished) => void;
const deliver = vi.fn();
const stopTurn = vi.fn(async () => {});
const emit = vi.fn();
const host = {
  deliver,
  stopTurn,
  onTurnFinished: (listener: typeof finish) => {
    finish = listener;
    return () => {};
  },
};
const entries = () => chats.readEntries(id);
const done = async (botId: string, text: string, ok = true) => {
  finish({
    chatId: id,
    botId,
    conversationId: botId,
    turnId: String(entries().length),
    text,
    ok,
    error: ok ? undefined : 'broken',
  });
  await group.settled(id);
};

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'group-chat-'));
  bots = new BotStore(join(root, 'bots'));
  chats = new BotChatStore(join(root, 'chats'));
  const alice = bots.create({ name: 'Alice' }, []);
  const bob = bots.create({ name: 'Bob' }, []);
  if (!alice.ok || !bob.ok) throw new Error('fixture');
  a = alice.bot.id;
  b = bob.bot.id;
  id = chats.create({
    kind: 'group',
    title: 'Team',
    members: [a, b],
    bossBotId: a,
    workspace: { kind: 'chat-home', projectId: 'home' },
  })!.id;
  deliver.mockImplementation(async (_chatId: string, botId: string) => {
    if (!chats.get(id)!.sessions[botId])
      chats.update(id, (draft) => {
        draft.sessions[botId] = { conversationId: botId, cursor: chats.lastSeq(id) };
        return draft;
      });
    return { ok: true, conversationId: botId };
  });
  group = new GroupChatService({ bots, chats, host, emit });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('routes mentions in order, then uses the boss without mentions', async () => {
  await group.send(id, '@Bob @Alice hello');
  expect(deliver.mock.calls.map((c) => c[1])).toEqual([b]);
  expect(group.state(id)).toMatchObject({ current: b, queue: [a] });
  await done(b, 'hello');
  expect(deliver.mock.calls.map((c) => c[1])).toEqual([b, a]);
  await done(a, 'hello');
  await group.send(id, 'question');
  expect(group.state(id)).toMatchObject({ current: a });
  expect(emit).toHaveBeenCalledWith({ kind: 'timeline', chatId: id, seq: 1 });
});

it('queues routine replies behind the group round and selects the requested member', async () => {
  await group.send(id, 'hello');
  const routine = group.runAs(id, b, '<routine title="check">check it</routine>', 'check', {
    deliveryId: 'r1',
  });
  await group.settled(id);
  expect(deliver).toHaveBeenCalledTimes(1);
  await done(a, 'done');
  expect(await routine).toMatchObject({ ok: true });
  expect(deliver.mock.calls[1]).toEqual([
    id,
    b,
    '<routine title="check">check it</routine>',
    { deliveryId: 'r1', queueIfBusy: true },
  ]);
  expect(
    entries().some((entry) => entry.kind === 'system' && entry.text === '例行任务：check')
  ).toBe(true);
  await done(b, 'routine reply');
  expect(
    entries().some(
      (entry) => entry.kind === 'bot' && entry.botId === b && entry.text === 'routine reply'
    )
  ).toBe(true);
});

it('limits relay and does not publish skip replies', async () => {
  chats.update(id, (c) => ({ ...c, routing: { maxHops: 1, maxTurnsPerBot: 2 } }));
  await group.send(id, 'go');
  await done(a, '@Bob go');
  await done(b, '@Alice again');
  expect(group.state(id)).toMatchObject({ current: null, hops: 1 });
  expect(entries().some((e) => e.kind === 'system' && e.text.includes('上限'))).toBe(true);
  await group.send(id, '@所有人');
  await done(a, ' [skip] ');
  expect(group.state(id)).toMatchObject({ current: b });
  expect(entries().filter((e) => e.kind === 'bot')).toHaveLength(2);
});

it('continues after failed turns and delivery without advancing failed cursor', async () => {
  chats.update(id, (c) => ({ ...c, sessions: { [a]: { conversationId: a, cursor: 0 } } }));
  deliver.mockResolvedValueOnce({ ok: false, error: 'offline' });
  await group.send(id, '@Alice @Bob');
  expect(chats.get(id)!.sessions[a].cursor).toBe(0);
  expect(chats.get(id)!.sessions[b].cursor).toBeGreaterThan(0);
  expect(group.state(id)).toMatchObject({ current: b });
  await done(b, '@Alice ignored', false);
  expect(group.state(id)).toMatchObject({ current: null });
  expect(entries().filter((e) => e.kind === 'system')).toHaveLength(2);
});

it('steers only current mentions and restarts with merged pending humans', async () => {
  await group.send(id, '@所有人');
  await group.send(id, '@Alice detail');
  expect(deliver.mock.calls[1][2]).toContain('detail');
  expect(group.state(id)).toMatchObject({ pendingHuman: false });
  await group.send(id, '@Bob next');
  await group.send(id, 'another');
  expect(deliver).toHaveBeenCalledTimes(2);
  expect(group.state(id)).toMatchObject({ pendingHuman: true });
  await done(a, '@Alice ignored');
  expect(group.state(id)).toMatchObject({
    current: b,
    queue: [],
    hops: 0,
    turnsByBot: { [b]: 1 },
    pendingHuman: false,
  });
});

it('recovers interrupted routing without resuming and stop ignores late results', async () => {
  await group.send(id, '@所有人');
  group = new GroupChatService({ bots, chats: new BotChatStore(join(root, 'chats')), host, emit });
  expect(group.state(id)).toMatchObject({ current: null, queue: [] });
  expect(new BotChatStore(join(root, 'chats')).readEntries(id).at(-1)).toMatchObject({
    kind: 'system',
    text: '回复被中断',
  });
  await group.send(id, '@所有人');
  await group.stop(id);
  expect(stopTurn).toHaveBeenCalledWith(id, a);
  await done(a, 'late');
  expect(group.state(id)).toMatchObject({ current: null, queue: [] });
});

it('skips removed members and reports unavailable boss', async () => {
  await group.send(id, '@所有人');
  bots.remove(b);
  await done(a, 'done');
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(entries().at(-1)).toMatchObject({ kind: 'system', text: '请先指定群主' });
  bots.remove(a);
  await group.send(id, 'anyone');
  expect(entries().at(-1)).toMatchObject({ kind: 'system', text: '请先指定群主' });
});

it('enforces per-member turn limits and skips archived queued members', async () => {
  chats.update(id, (c) => ({ ...c, routing: { maxHops: 4, maxTurnsPerBot: 1 } }));
  await group.send(id, 'start');
  await done(a, '@Bob next');
  await done(b, '@Alice again');
  expect(group.state(id)).toMatchObject({ current: null });
  expect(entries().at(-1)).toMatchObject({
    kind: 'system',
    text: expect.stringContaining('本轮已回复 1 次'),
  });
  await group.send(id, '@所有人');
  bots.setArchived(b, true);
  await done(a, '[skip]');
  expect(group.state(id)).toMatchObject({ current: null });
  expect(deliver).toHaveBeenCalledTimes(3);
});

it('rolls back a newly created session cursor when delivery fails', async () => {
  deliver.mockImplementationOnce(async (_chatId, botId) => {
    chats.update(id, (c) => ({
      ...c,
      sessions: { [botId]: { conversationId: botId, cursor: chats.lastSeq(id) } },
    }));
    throw new Error('offline');
  });
  await group.send(id, '@Alice @Bob');
  expect(chats.get(id)!.sessions[a].cursor).toBe(0);
  expect(group.state(id)).toMatchObject({ current: b });
});

it('serializes simultaneous human messages without starting two members', async () => {
  await Promise.all([group.send(id, '@Alice first'), group.send(id, '@Bob second')]);
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(group.state(id)).toMatchObject({ current: a, pendingHuman: true });
  await done(a, 'done');
  expect(group.state(id)).toMatchObject({ current: b });
  expect(entries().map((e) => e.seq)).toEqual([1, 2, 3]);
});

it('refuses a new round until a failed stop is successfully retried', async () => {
  await group.send(id, '@所有人');
  stopTurn.mockRejectedValueOnce(new Error('release timed out'));
  expect(await group.stop(id)).toMatchObject({ ok: false });
  expect(await group.send(id, 'too soon')).toMatchObject({ ok: false });
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(await group.stop(id)).toEqual({ ok: true });
  await group.send(id, 'next');
  expect(deliver).toHaveBeenCalledTimes(2);
});
