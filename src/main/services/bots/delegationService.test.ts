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
function fixture() {
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
  const prompts: Array<{ id: string; text: string }> = [];
  const abort = vi.fn();
  const host = new BotSessionHost({
    bots,
    chats,
    authority,
    emit: () => {},
    runtime: {
      spawn: async () => ({ ok: true }),
      prompt: (id, text) => {
        prompts.push({ id, text });
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
it('times out and aborts; cancellation is final', async () => {
  const f = fixture();
  const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'work' });
  if (!sent.ok) throw new Error(sent.error);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.store.get(sent.delegationId)).toMatchObject({ state: 'failed', failure: 'timeout' });
  expect(f.abort).toHaveBeenCalled();
  f.service.dispose();
});
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
