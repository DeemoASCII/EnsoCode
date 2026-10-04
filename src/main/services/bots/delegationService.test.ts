import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SourceAuthorityRegistry } from '../sourceAuthorityRegistry';
import { BotSessionHost } from './botSessionHost';
import { BotStore } from './botStore';
import { BotChatStore } from './chatStore';
import { DelegationService } from './delegationService';
import { DelegationStore } from './delegationStore';

let root: string;
beforeEach(() => {
  vi.useFakeTimers();
  root = mkdtempSync(join(tmpdir(), 'delegate-service-'));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});
function fixture(autoStart = true) {
  const bots = new BotStore(join(root, 'bots'));
  const a = bots.create({ name: 'Alice' }, []),
    b = bots.create({ name: 'Bob' }, []);
  if (!a.ok || !b.ok) throw new Error('bots');
  const chats = new BotChatStore(join(root, 'chats'));
  const chat = chats.create({
    kind: 'direct',
    title: '',
    members: [a.bot.id],
    bossBotId: null,
    workspace: { kind: 'member-home' },
  })!;
  const authority = new SourceAuthorityRegistry({ registryFile: join(root, 'authority.json') });
  const prompts: Array<{ id: string; text: string; deliveryId?: string }> = [];
  const abort = vi.fn();
  const host = new BotSessionHost({
    bots,
    chats,
    authority,
    emit: () => {},
    runtime: {
      spawn: async () => ({ ok: true }),
      prompt: (id, text, _images, deliveryId) => {
        prompts.push({ id, text, deliveryId });
        if (autoStart)
          queueMicrotask(() =>
            host.observe({
              type: 'status',
              status: 'running',
              identity: { sessionId: id, generation: 'g' },
              seq: 1,
            })
          );
        return { ok: true };
      },
      steer: () => ({ ok: true }),
      release: async () => {},
      abort,
      removeSessionFiles: () => {},
    },
  });
  const parent = host.ensureSession(chat.id, a.bot.id);
  if (!parent.ok) throw new Error(parent.error);
  const store = new DelegationStore(join(root, 'delegations.jsonl'));
  const service = new DelegationService({
    bots,
    chats,
    authority,
    host,
    store,
    emit: () => {},
    timeoutMs: 1000,
  });
  const finish = (id: string) =>
    host.observe({
      type: 'turn-completed',
      identity: { sessionId: id, generation: 'g' },
      seq: 1,
      turnId: 'turn',
    });
  return {
    service,
    host,
    store,
    parent: parent.conversationId,
    prompts,
    finish,
    abort,
    deps: { bots, chats, authority, host, store, emit: () => {}, timeoutMs: 1000 },
  };
}
it('truncates context, finishes once, and waits for the busy parent', async () => {
  const f = fixture();
  await f.host.deliverConversation(f.parent, 'busy');
  const sent = f.service.delegate(f.parent, {
    to: 'Bob',
    task: 'do work',
    context: 'a'.repeat(9000),
  });
  expect(sent.ok).toBe(true);
  if (!sent.ok) return;
  expect(sent.warning).toContain('8000');
  await vi.advanceTimersByTimeAsync(0);
  const record = f.store.get(sent.delegationId)!;
  expect(record.context).toHaveLength(8000);
  f.finish(record.childConversationId);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.get(record.id)?.deliveredAt).toBeUndefined();
  f.finish(f.parent);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.get(record.id)?.deliveredAt).toBeDefined();
  f.finish(record.childConversationId);
  f.finish(f.parent);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.prompts.filter((p) => p.text.includes('<delegation-result'))).toHaveLength(1);
  f.service.dispose();
});
it("runs delegations with the target's own capabilities and keeps the stricter approval after restore", async () => {
  const f = fixture();
  const alice = f.deps.bots.list().find((bot) => bot.name === 'Alice')!;
  const bob = f.deps.bots.list().find((bot) => bot.name === 'Bob')!;
  f.deps.bots.update(
    alice.id,
    {
      tools: 'readonly',
      approvalMode: 'supervised',
      skillIds: ['shared'],
      mcpServerIds: ['common'],
    },
    []
  );
  f.deps.bots.update(bob.id, { skillIds: ['shared', 'bob'], mcpServerIds: ['common', 'bob'] }, []);
  const first = f.service.delegate(f.parent, { to: 'Bob', task: 'one' });
  if (!first.ok) throw new Error(first.error);
  const record = f.store.get(first.delegationId)!;
  expect(record.effectivePermissions).toEqual({
    tools: 'all',
    approvalMode: 'supervised',
    skillIds: ['shared', 'bob'],
    mcpServerIds: ['common', 'bob'],
  });
  await vi.advanceTimersByTimeAsync(0);
  f.deps.bots.update(
    alice.id,
    { tools: 'all', approvalMode: 'full', skillIds: ['alice'], mcpServerIds: [] },
    []
  );
  const nested = f.service.delegate(record.childConversationId, { to: 'Alice', task: 'nested' });
  if (!nested.ok) throw new Error(nested.error);
  const child = f.store.get(nested.delegationId)!;
  expect(child.effectivePermissions).toEqual({
    tools: 'all',
    approvalMode: 'supervised',
    skillIds: ['alice'],
    mcpServerIds: [],
  });
  await vi.advanceTimersByTimeAsync(0);
  f.finish(record.childConversationId);
  f.finish(child.childConversationId);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.host.effectiveBot(record.childConversationId)).toMatchObject(
    record.effectivePermissions!
  );
  f.service.dispose();
});
it('times out and aborts; cancellation is final', async () => {
  const f = fixture();
  const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'work' });
  if (!sent.ok) throw new Error(sent.error);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.store.get(sent.delegationId)).toMatchObject({ state: 'failed', failure: 'timeout' });
  expect(f.abort).toHaveBeenCalled();
  f.service.dispose();
});
it('disabling cancels running delegation timers and rejects subsequent delegate calls', async () => {
  const f = fixture();
  const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'work' });
  if (!sent.ok) throw new Error(sent.error);
  await vi.advanceTimersByTimeAsync(0);
  f.service.disable();
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.store.get(sent.delegationId)?.state).toBe('canceled');
  expect(f.abort).toHaveBeenCalled();
  expect(f.service.delegate(f.parent, { to: 'Bob', task: 'more' })).toEqual({
    ok: false,
    error: 'disabled',
  });
});
it.each(['chat', 'initiator', 'target'] as const)(
  'deleting %s cancels associated delegations and aborts their child sessions',
  async (kind) => {
    const f = fixture();
    const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'work' });
    if (!sent.ok) throw new Error(sent.error);
    await vi.advanceTimersByTimeAsync(0);
    const record = f.store.get(sent.delegationId)!;
    if (kind === 'chat') f.host.discardChat(record.chatId!);
    else f.host.discardBot(kind === 'initiator' ? record.parentBotId : record.targetBotId);
    expect(f.store.get(record.id)?.state).toBe('canceled');
    expect(f.abort).toHaveBeenCalledWith(record.childConversationId);
    f.service.dispose();
  }
);
it('marks unfinished work interrupted on restart without replaying it', async () => {
  const f = fixture();
  const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'work' });
  if (!sent.ok) throw new Error(sent.error);
  await vi.advanceTimersByTimeAsync(0);
  f.service.dispose();
  const restarted = new DelegationService(f.deps);
  expect(f.store.get(sent.delegationId)).toMatchObject({ state: 'failed', failure: 'interrupted' });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.prompts.filter((p) => p.text.includes('<delegation-result'))).toHaveLength(1);
  restarted.dispose();
});

it('rejects a fourth concurrent delegation, retries with a new id, and prevents cross-parent cancellation', async () => {
  const f = fixture();
  const first = f.service.delegate(f.parent, { to: 'Bob', task: 'one' });
  if (!first.ok) throw new Error(first.error);
  expect(f.service.delegate(f.parent, { to: 'Bob', task: 'two' }).ok).toBe(true);
  expect(f.service.delegate(f.parent, { to: 'Bob', task: 'three' }).ok).toBe(true);
  expect(f.service.delegate(f.parent, { to: 'Bob', task: 'four' }).ok).toBe(false);
  expect(f.service.check('other-parent', { id: first.delegationId, cancel: true })).toMatchObject({
    ok: false,
  });
  expect(f.store.get(first.delegationId)?.state).toBe('queued');
  f.service.cancel(first.delegationId);
  expect(f.store.get(first.delegationId)?.state).toBe('canceled');
  const retried = f.service.retry(first.delegationId);
  expect(retried.ok && retried.delegationId).not.toBe(first.delegationId);
  await vi.advanceTimersByTimeAsync(0);
  f.service.dispose();
});

it('does not mark a result delivered while global slots are exhausted', async () => {
  const f = fixture();
  const first = f.service.delegate(f.parent, { to: 'Bob', task: 'one' });
  if (!first.ok) throw new Error(first.error);
  await vi.advanceTimersByTimeAsync(0);
  const record = f.store.get(first.delegationId)!;
  const count = vi.spyOn(f.host, 'runningCount').mockReturnValue(4);
  f.finish(record.childConversationId);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.get(record.id)?.deliveredAt).toBeUndefined();
  count.mockRestore();
  await f.service.deliverPending();
  expect(f.store.get(record.id)?.deliveredAt).toBeDefined();
  f.service.dispose();
});
it('uses delegationId and only marks delivered after the parent turn actually starts', async () => {
  const f = fixture(false);
  const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'work' });
  if (!sent.ok) throw new Error(sent.error);
  await vi.advanceTimersByTimeAsync(0);
  f.finish(f.store.get(sent.delegationId)!.childConversationId);
  await vi.advanceTimersByTimeAsync(0);
  const results = () => f.prompts.filter((prompt) => prompt.text.includes('<delegation-result'));
  expect(results()).toMatchObject([{ deliveryId: sent.delegationId }]);
  expect(f.store.get(sent.delegationId)?.deliveredAt).toBeUndefined();
  await f.service.deliverPending();
  expect(results()).toHaveLength(1);
  f.host.observe({
    type: 'status',
    status: 'running',
    identity: { sessionId: f.parent, generation: 'g' },
    seq: 2,
  });
  expect(f.store.get(sent.delegationId)?.deliveredAt).toBeDefined();
  f.service.dispose();
});
it('publishes only a delegation summary in groups without duplicating a bot message', async () => {
  const f = fixture();
  const members = f.deps.bots.list().map((bot) => bot.id);
  const alice = f.deps.bots.list().find((bot) => bot.name === 'Alice')!;
  const chat = f.deps.chats.create({
    kind: 'group',
    title: 'team',
    members,
    bossBotId: alice.id,
    workspace: { kind: 'chat-home', projectId: 'home' },
  })!;
  const parent = f.host.ensureSession(chat.id, alice.id);
  if (!parent.ok) throw new Error(parent.error);
  const sent = f.service.delegate(parent.conversationId, { to: 'Bob', task: 'work' });
  if (!sent.ok) throw new Error(sent.error);
  await vi.advanceTimersByTimeAsync(0);
  const record = f.store.get(sent.delegationId)!;
  f.host.observe({
    type: 'turn-completed',
    identity: { sessionId: record.childConversationId, generation: 'g' },
    seq: 2,
    turnId: 'turn',
    digest: { assistantText: 'result summary' },
  } as Parameters<BotSessionHost['observe']>[0]);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.deps.chats.readEntries(chat.id)).toEqual([
    expect.objectContaining({ kind: 'delegation', summary: 'result summary' }),
  ]);
  f.service.dispose();
  const completed = f.store.get(record.id)!;
  f.store.save({ ...completed, deliveredAt: undefined });
  vi.spyOn(f.host, 'isBusy').mockReturnValue(false);
  const deliverGroupResult = vi.fn(async () => ({ ok: true as const }));
  const restarted = new DelegationService({ ...f.deps, deliverGroupResult });
  await vi.advanceTimersByTimeAsync(0);
  expect(deliverGroupResult).not.toHaveBeenCalled();
  expect(f.store.get(record.id)?.deliveredAt).toBeDefined();
  expect(f.deps.chats.readEntries(chat.id)).toHaveLength(1);
  restarted.dispose();
});
