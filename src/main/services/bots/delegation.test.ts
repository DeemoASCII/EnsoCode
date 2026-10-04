import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Delegation, parseBotProfile, parseDelegation } from '../../../shared/types/bot';
import { delegationPolicy, intersectBotPermissions } from './delegationPolicy';
import { DelegationStore } from './delegationStore';

const a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const b = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const profile = (id: string) =>
  parseBotProfile({ id, name: id === a ? 'Alice' : 'Bob', createdAt: 1, updatedAt: 1 })!;
const record: Delegation = {
  id: a,
  parentConversationId: 'parent',
  parentBotId: a,
  targetBotId: b,
  chatId: null,
  task: 'work',
  context: '',
  childConversationId: 'child',
  state: 'queued',
  depth: 1,
  createdAt: 1,
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('delegation policy', () => {
  it('rejects corrupt delivery timestamps instead of turning a delivered record into a pending one', () => {
    expect(parseDelegation({ ...record, deliveredAt: 'broken' })).toBeUndefined();
    expect(parseDelegation({ ...record, finishedAt: -1 })).toBeUndefined();
  });
  it('rejects self, archived, denied, out-of-group, depth and concurrency', () => {
    const parent = profile(a),
      target = profile(b);
    expect(delegationPolicy(parent, parent, 1, 0)).toBeDefined();
    expect(delegationPolicy(parent, { ...target, archivedAt: 1 }, 1, 0)).toBeDefined();
    expect(
      delegationPolicy(
        { ...parent, delegation: { canDelegateTo: [], acceptFrom: 'any' } },
        target,
        1,
        0
      )
    ).toBeDefined();
    expect(
      delegationPolicy(
        parent,
        { ...target, delegation: { canDelegateTo: 'any', acceptFrom: [] } },
        1,
        0
      )
    ).toBeDefined();
    expect(delegationPolicy(parent, target, 1, 0, [a])).toBeDefined();
    expect(delegationPolicy(parent, target, 3, 0)).toBeDefined();
    expect(delegationPolicy(parent, target, 2, 3)).toBeDefined();
    expect(delegationPolicy(parent, target, 2, 2, [a, b])).toBeUndefined();
  });
  it('never widens parent permissions and retains target assets', () => {
    expect(
      intersectBotPermissions(
        { ...profile(a), tools: 'readonly', approvalMode: 'supervised' },
        { ...profile(b), skillIds: ['target'], mcpServerIds: ['mcp'] }
      )
    ).toMatchObject({
      tools: 'readonly',
      approvalMode: 'supervised',
      skillIds: ['target'],
      mcpServerIds: ['mcp'],
    });
    expect(
      intersectBotPermissions(
        { ...profile(a), approvalMode: 'assistant' },
        { ...profile(b), approvalMode: 'auto-edits' }
      ).approvalMode
    ).toBe('supervised');
  });
});

it('rebuilds last valid record per id, skips malformed lines, and validates records', () => {
  const root = mkdtempSync(join(tmpdir(), 'delegation-'));
  roots.push(root);
  const file = join(root, 'delegations.jsonl');
  const store = new DelegationStore(file);
  store.save(record);
  store.save({ ...record, state: 'completed', result: 'done', finishedAt: 2 });
  appendFileSync(file, '\nnot-json\n{"id":"bad"}\n');
  expect(new DelegationStore(file).list()).toEqual([
    { ...record, state: 'completed', result: 'done', finishedAt: 2 },
  ]);
});
