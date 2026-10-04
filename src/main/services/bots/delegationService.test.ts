import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
function fixture(autoStart = true, over = new Set<string>()) {
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
    budget: { exceeded: async (botId) => (over.has(botId) ? 'tokens' : null) },
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
    minuteMs: 1,
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
    bob: b.bot.id,
    deps: { bots, chats, authority, host, store, emit: () => {}, minuteMs: 1 },
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
  const carol = f.deps.bots.create(
    { name: 'Carol', tools: 'all', approvalMode: 'full', skillIds: ['carol'], mcpServerIds: [] },
    []
  );
  if (!carol.ok) throw new Error('carol');
  const nested = f.service.delegate(record.childConversationId, { to: 'Carol', task: 'nested' });
  if (!nested.ok) throw new Error(nested.error);
  const child = f.store.get(nested.delegationId)!;
  expect(child.effectivePermissions).toEqual({
    tools: 'all',
    approvalMode: 'supervised',
    skillIds: ['carol'],
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
  expect(f.store.get(sent.delegationId)?.timeoutMinutes).toBe(240);
  await vi.advanceTimersByTimeAsync(239);
  expect(f.store.get(sent.delegationId)?.state).toBe('running');
  await vi.advanceTimersByTimeAsync(1);
  expect(f.store.get(sent.delegationId)).toMatchObject({ state: 'failed', failure: 'timeout' });
  expect(f.abort).toHaveBeenCalled();
  f.service.dispose();
});
it("caps the delegation timeout by the target's limit and lets the caller ask for less", async () => {
  const f = fixture();
  f.deps.bots.update(f.bob, { delegationTimeoutMinutes: 30 }, []);
  const capped = f.service.delegate(f.parent, { to: 'Bob', task: 'a', deadlineMinutes: 90 });
  if (!capped.ok) throw new Error(capped.error);
  expect(capped.warning).toContain('30');
  const short = f.service.delegate(f.parent, { to: 'Bob', task: 'b', deadlineMinutes: 10 });
  if (!short.ok) throw new Error(short.error);
  expect(short).not.toHaveProperty('warning');
  const plain = f.service.delegate(f.parent, { to: 'Bob', task: 'c' });
  if (!plain.ok) throw new Error(plain.error);
  expect(f.store.get(capped.delegationId)?.timeoutMinutes).toBe(30);
  expect(f.store.get(short.delegationId)?.timeoutMinutes).toBe(10);
  expect(f.store.get(plain.delegationId)?.timeoutMinutes).toBe(30);
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY])
    expect(f.service.delegate(f.parent, { to: 'Bob', task: 'x', deadlineMinutes: bad })).toEqual({
      ok: false,
      error: 'deadlineMinutes must be a positive number.',
    });
  await vi.advanceTimersByTimeAsync(10);
  expect(f.store.get(short.delegationId)?.failure).toBe('timeout');
  expect(f.store.get(capped.delegationId)?.state).toBe('running');
  await vi.advanceTimersByTimeAsync(20);
  expect(f.store.get(capped.delegationId)?.failure).toBe('timeout');
  expect(f.store.get(plain.delegationId)?.failure).toBe('timeout');
  // 重试沿用原时限，并按目标当前上限再收紧
  f.deps.bots.update(f.bob, { delegationTimeoutMinutes: 5 }, []);
  const retried = f.service.retry(short.delegationId);
  if (!retried.ok) throw new Error(retried.error);
  expect(f.store.get(retried.delegationId)?.timeoutMinutes).toBe(5);
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
const results = (f: ReturnType<typeof fixture>) =>
  f.prompts.filter((prompt) => prompt.text.includes('<delegation-result'));
async function sameTurn(f: ReturnType<typeof fixture>, tasks: string[]) {
  await f.host.deliverConversation(f.parent, 'busy');
  const records = tasks.map((task) => {
    const sent = f.service.delegate(f.parent, { to: 'Bob', task });
    if (!sent.ok) throw new Error(sent.error);
    return f.store.get(sent.delegationId)!;
  });
  await vi.advanceTimersByTimeAsync(0);
  f.finish(f.parent);
  await vi.advanceTimersByTimeAsync(0);
  return records;
}
it('merges same-turn delegations into one delivery once all reach a final state', async () => {
  const f = fixture();
  const [a, b, c] = await sameTurn(f, ['one', 'two', 'three']);
  expect(a.batchId).toBeTruthy();
  expect([b.batchId, c.batchId]).toEqual([a.batchId, a.batchId]);
  f.finish(a.childConversationId);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.get(a.id)?.state).toBe('completed');
  expect(results(f)).toHaveLength(0);
  f.service.cancel(c.id);
  await vi.advanceTimersByTimeAsync(0);
  expect(results(f)).toHaveLength(0);
  f.finish(b.childConversationId);
  await vi.advanceTimersByTimeAsync(0);
  expect(results(f)).toMatchObject([{ id: f.parent, deliveryId: a.batchId }]);
  const text = results(f)[0].text;
  expect(text.startsWith(`<delegation-results id="${a.batchId}">`)).toBe(true);
  for (const record of [a, b, c]) expect(text).toContain(`<delegation-result id="${record.id}"`);
  expect(text).toContain('status="canceled"');
  expect([a, b, c].every((record) => f.store.get(record.id)?.deliveredAt !== undefined)).toBe(true);
  await f.service.deliverPending();
  expect(results(f)).toHaveLength(1);
  f.service.dispose();
});
it('recovers a batch after restart: finished-but-undelivered batches are delivered once', async () => {
  const f = fixture();
  const [a, b] = await sameTurn(f, ['one', 'two']);
  f.finish(a.childConversationId);
  await vi.advanceTimersByTimeAsync(0);
  expect(results(f)).toHaveLength(0);
  f.service.dispose();
  const restarted = new DelegationService(f.deps);
  expect(f.store.get(b.id)).toMatchObject({ state: 'failed', failure: 'interrupted' });
  await vi.advanceTimersByTimeAsync(0);
  expect(results(f)).toMatchObject([{ deliveryId: a.batchId }]);
  expect(f.store.get(a.id)?.deliveredAt).toBeDefined();
  expect(f.store.get(b.id)?.deliveredAt).toBeDefined();
  restarted.dispose();
  const again = new DelegationService(f.deps);
  await vi.advanceTimersByTimeAsync(0);
  expect(results(f)).toHaveLength(1);
  again.dispose();
});
it('keeps a retried delegation out of the original batch', async () => {
  const f = fixture();
  await f.host.deliverConversation(f.parent, 'busy');
  const first = f.service.delegate(f.parent, { to: 'Bob', task: 'one' });
  if (!first.ok) throw new Error(first.error);
  f.service.cancel(first.delegationId);
  const retried = f.service.retry(first.delegationId);
  if (!retried.ok) throw new Error(retried.error);
  const batchId = f.store.get(first.delegationId)?.batchId;
  expect(batchId).toBeTruthy();
  expect(f.store.get(retried.delegationId)?.batchId).not.toBe(batchId);
  await vi.advanceTimersByTimeAsync(0);
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
it('links a board task: gate rejects before any record, sync sees every save, retry keeps the link only while the task is free', async () => {
  const f = fixture();
  f.service.dispose();
  const TASK = '55555555-5555-4555-8555-555555555555';
  let free = true;
  const tasks = {
    gate: vi.fn((_chatId: string | null, ref: string) =>
      (ref === '#1' || ref === TASK) && free
        ? ({ ok: true, taskId: TASK } as const)
        : ({ ok: false, error: 'Task #1 is already done.' } as const)
    ),
    sync: vi.fn(),
  };
  const service = new DelegationService({ ...f.deps, tasks });
  expect(service.delegate(f.parent, { to: 'Bob', task: 'x', taskId: '#2' })).toEqual({
    ok: false,
    error: 'Task #1 is already done.',
  });
  expect(f.store.list()).toEqual([]);
  const sent = service.delegate(f.parent, { to: 'Bob', task: 'x', taskId: '#1' });
  if (!sent.ok) throw new Error(sent.error);
  expect(f.store.get(sent.delegationId)?.taskId).toBe(TASK);
  expect(tasks.sync).toHaveBeenCalledWith(
    expect.objectContaining({ id: sent.delegationId, taskId: TASK })
  );
  service.cancel(sent.delegationId);
  expect(tasks.sync).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: sent.delegationId, state: 'canceled' })
  );
  free = true;
  const retried = service.retry(sent.delegationId);
  if (!retried.ok) throw new Error(retried.error);
  expect(f.store.get(retried.delegationId)?.taskId).toBe(TASK);
  service.cancel(retried.delegationId);
  free = false;
  const again = service.retry(retried.delegationId);
  if (!again.ok) throw new Error(again.error);
  expect(f.store.get(again.delegationId)).not.toHaveProperty('taskId');
  service.dispose();
});
it('rejects delegating back up the chain to a member who delegated to you', async () => {
  const f = fixture();
  const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'write file' });
  if (!sent.ok) throw new Error(sent.error);
  await vi.advanceTimersByTimeAsync(0);
  const child = f.store.get(sent.delegationId)!.childConversationId;
  const back = f.service.delegate(child, { to: 'Alice', task: 'report done' });
  expect(back).toEqual({ ok: false, error: expect.stringContaining('delegated this work to you') });
  expect(f.store.list()).toHaveLength(1);
  f.service.dispose();
});

it('fails the delegation with the budget reason when the target is over its daily cap', async () => {
  const over = new Set<string>();
  const f = fixture(true, over);
  over.add(f.bob);
  const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'do work' });
  if (!sent.ok) throw new Error(sent.error);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.get(sent.delegationId)).toMatchObject({
    state: 'failed',
    failure: 'error',
    error: 'budget-exceeded',
  });
  expect(f.prompts.filter((p) => p.text.includes('<delegation-task'))).toHaveLength(0);
  f.service.dispose();
});

it('retries only failed / canceled / interrupted records, links retryOf, and refuses superseded ones', async () => {
  const f = fixture();
  const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'one' });
  if (!sent.ok) throw new Error(sent.error);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.service.retry(sent.delegationId)).toMatchObject({ ok: false });
  f.finish(f.store.get(sent.delegationId)!.childConversationId);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.get(sent.delegationId)?.state).toBe('completed');
  expect(f.service.retry(sent.delegationId)).toMatchObject({ ok: false });
  expect(f.service.retry('missing')).toMatchObject({ ok: false });

  const failed = f.service.delegate(f.parent, { to: 'Bob', task: 'two' });
  if (!failed.ok) throw new Error(failed.error);
  f.service.cancel(failed.delegationId);
  const retried = f.service.retry(failed.delegationId);
  if (!retried.ok) throw new Error(retried.error);
  expect(f.store.get(retried.delegationId)).toMatchObject({ retryOf: failed.delegationId });
  expect(f.store.get(retried.delegationId)).not.toHaveProperty('batchId');
  expect(f.service.retry(failed.delegationId)).toEqual({
    ok: false,
    error: 'This delegation has already been retried.',
  });
  f.service.cancel(retried.delegationId);
  const chained = f.service.retry(retried.delegationId);
  if (!chained.ok) throw new Error(chained.error);
  expect(f.store.get(chained.delegationId)?.retryOf).toBe(retried.delegationId);
  f.service.dispose();

  const restarted = new DelegationService(f.deps);
  expect(f.store.get(chained.delegationId)).toMatchObject({
    state: 'failed',
    failure: 'interrupted',
  });
  const resumed = restarted.retry(chained.delegationId);
  expect(resumed.ok && f.store.get(resumed.delegationId)?.retryOf).toBe(chained.delegationId);
  restarted.dispose();
});

it('retry is bound by the per-parent concurrency cap', async () => {
  const f = fixture();
  const first = f.service.delegate(f.parent, { to: 'Bob', task: 'one' });
  if (!first.ok) throw new Error(first.error);
  f.service.cancel(first.delegationId);
  for (const task of ['two', 'three', 'four'])
    expect(f.service.delegate(f.parent, { to: 'Bob', task }).ok).toBe(true);
  expect(f.service.retry(first.delegationId)).toMatchObject({ ok: false });
  expect(f.store.list().some((item) => item.retryOf === first.delegationId)).toBe(false);
  f.service.dispose();
});

describe('stopping the parent turn', () => {
  const results = (f: ReturnType<typeof fixture>) =>
    f.prompts.filter((p) => p.id === f.parent && p.text.includes('<delegation-result'));
  async function started(f: ReturnType<typeof fixture>) {
    await f.host.deliverConversation(f.parent, 'go');
    await vi.advanceTimersByTimeAsync(0);
    const drop = f.service.delegate(f.parent, { to: 'Bob', task: 'drop' });
    const kept = f.service.delegate(f.parent, { to: 'Bob', task: 'kept', keep: true });
    if (!drop.ok || !kept.ok) throw new Error('delegate');
    await vi.advanceTimersByTimeAsync(0);
    return { drop: drop.delegationId, kept: kept.delegationId };
  }

  it.each([
    [
      'stopTurn',
      (f: ReturnType<typeof fixture>, chatId: string, botId: string) =>
        f.host.stopTurn(chatId, botId),
    ],
    ['abortConversation', (f: ReturnType<typeof fixture>) => f.host.abortConversation(f.parent)],
  ] as const)('%s cancels the turn’s delegations except keep', async (_name, stop) => {
    const f = fixture();
    const ids = await started(f);
    const drop = f.store.get(ids.drop)!;
    expect(drop.batchId).toBeDefined();
    expect(f.store.get(ids.kept)).toMatchObject({ keep: true, batchId: drop.batchId });
    await stop(f, drop.chatId!, drop.parentBotId);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(ids.drop)?.state).toBe('canceled');
    expect(f.abort).toHaveBeenCalledWith(drop.childConversationId);
    expect(f.store.get(ids.kept)?.state).toBe('running');
    expect(results(f)).toHaveLength(0);
    // keep 的结果回来后整批（含被取消的）照常合并回传
    f.finish(f.store.get(ids.kept)!.childConversationId);
    await vi.advanceTimersByTimeAsync(0);
    expect(results(f)).toHaveLength(1);
    expect(results(f)[0].text).toContain(ids.drop);
    f.service.dispose();
  });

  it('a user abort reported by the worker (stopReason aborted) cascades too', async () => {
    const f = fixture();
    const ids = await started(f);
    f.host.observe({
      type: 'message-upsert',
      identity: { sessionId: f.parent, generation: 'g' },
      seq: 2,
      index: 1,
      message: { role: 'assistant', content: [], stopReason: 'aborted' },
    });
    f.finish(f.parent);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(ids.drop)?.state).toBe('canceled');
    expect(f.store.get(ids.kept)?.state).toBe('running');
    f.service.dispose();
  });

  it('a stopped turn whose batch has nothing left running is closed without waking the parent', async () => {
    const f = fixture();
    await f.host.deliverConversation(f.parent, 'go');
    await vi.advanceTimersByTimeAsync(0);
    const done = f.service.delegate(f.parent, { to: 'Bob', task: 'quick' });
    const drop = f.service.delegate(f.parent, { to: 'Bob', task: 'slow' });
    if (!done.ok || !drop.ok) throw new Error('delegate');
    await vi.advanceTimersByTimeAsync(0);
    f.finish(f.store.get(done.delegationId)!.childConversationId);
    await vi.advanceTimersByTimeAsync(0);
    await f.host.abortConversation(f.parent);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(drop.delegationId)?.state).toBe('canceled');
    expect(f.store.get(done.delegationId)?.deliveredAt).toBeDefined();
    expect(f.store.get(drop.delegationId)?.deliveredAt).toBeDefined();
    expect(results(f)).toHaveLength(0);
    f.service.dispose();
  });

  it('normal completion, errors and other turns leave delegations running', async () => {
    const f = fixture();
    const ids = await started(f);
    f.host.observe({
      type: 'message-upsert',
      identity: { sessionId: f.parent, generation: 'g' },
      seq: 2,
      index: 1,
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'boom' },
    });
    f.finish(f.parent);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(ids.drop)?.state).toBe('running');
    // 下一轮被停止只影响下一轮自己发起的委派
    await f.host.deliverConversation(f.parent, 'again');
    await vi.advanceTimersByTimeAsync(0);
    await f.host.abortConversation(f.parent);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(ids.drop)?.state).toBe('running');
    f.service.dispose();
  });

  it('cascades down: a canceled child stops its own delegations', async () => {
    const f = fixture();
    const carol = f.deps.bots.create({ name: 'Carol' }, []);
    if (!carol.ok) throw new Error('carol');
    await f.host.deliverConversation(f.parent, 'go');
    await vi.advanceTimersByTimeAsync(0);
    const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'lead' });
    if (!sent.ok) throw new Error(sent.error);
    await vi.advanceTimersByTimeAsync(0);
    const child = f.store.get(sent.delegationId)!.childConversationId;
    const nested = f.service.delegate(child, { to: 'Carol', task: 'sub' });
    if (!nested.ok) throw new Error(nested.error);
    await vi.advanceTimersByTimeAsync(0);
    await f.host.abortConversation(f.parent);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(sent.delegationId)?.state).toBe('canceled');
    expect(f.store.get(nested.delegationId)?.state).toBe('canceled');
    f.service.dispose();
  });

  it('returns cascaded board tasks to todo while kept ones stay assigned', async () => {
    const f = fixture();
    f.service.dispose();
    const tasks = { gate: vi.fn(), sync: vi.fn() };
    const service = new DelegationService({ ...f.deps, tasks });
    await f.host.deliverConversation(f.parent, 'go');
    await vi.advanceTimersByTimeAsync(0);
    const drop = service.delegate(f.parent, { to: 'Bob', task: 'drop' });
    const kept = service.delegate(f.parent, { to: 'Bob', task: 'kept', keep: true });
    if (!drop.ok || !kept.ok) throw new Error('delegate');
    await vi.advanceTimersByTimeAsync(0);
    tasks.sync.mockClear();
    await f.host.abortConversation(f.parent);
    expect(tasks.sync).toHaveBeenCalledWith(
      expect.objectContaining({ id: drop.delegationId, state: 'canceled' })
    );
    expect(tasks.sync).not.toHaveBeenCalledWith(expect.objectContaining({ id: kept.delegationId }));
    service.dispose();
  });
});
