import { describe, expect, it } from 'vitest';
import type { ConversationAuthority } from '../../../shared/types/agent';
import type { BotProfile } from '../../../shared/types/bot';
import type { UsageRecord } from '../../../shared/usage/types';
import { BotUsageService } from './botUsage';

const NOW = new Date(2026, 9, 4, 12).getTime();
const TODAY = new Date(2026, 9, 4).getTime();
const DAY = 86_400_000;

function rec(id: string, ts: number, tokens = 100): UsageRecord {
  return {
    id,
    ts,
    model: 'm',
    provider: 'p',
    project: '',
    sessionId: `s-${id}`,
    input: tokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  };
}

function conv(id: string, bot?: ConversationAuthority['bot']): ConversationAuthority {
  return {
    conversationId: id,
    projectId: 'p',
    kind: 'root',
    lifecycle: 'ready',
    version: 1,
    sessionFile: `/s/${id}.jsonl`,
    ...(bot ? { bot } : {}),
  };
}

function profile(id: string, budget?: BotProfile['budget']): BotProfile {
  return {
    id,
    name: id.toUpperCase(),
    title: '',
    scope: '',
    avatar: { color: '#000000' },
    approvalMode: 'full',
    tools: 'all',
    skillIds: [],
    mcpServerIds: [],
    delegation: { canDelegateTo: 'any', acceptFrom: 'any' },
    memory: { enabled: true },
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    ...(budget ? { budget } : {}),
  };
}

function setup(budgets: Record<string, BotProfile['budget']> = {}) {
  const files: Record<string, UsageRecord[]> = {
    '/s/dm.jsonl': [rec('a1', TODAY + 1000), rec('a2', TODAY - 1)],
    '/s/group.jsonl': [rec('a3', TODAY - 3 * DAY, 50)],
    '/s/child.jsonl': [rec('b1', TODAY + 5, 300)],
    '/s/code.jsonl': [rec('c1', TODAY + 5, 999)],
  };
  const loaded: string[] = [];
  const bots = [profile('alice', budgets.alice), profile('bob', budgets.bob)];
  const service = new BotUsageService({
    bots: { get: (id) => bots.find((b) => b.id === id), list: () => bots },
    conversations: () => [
      conv('dm', { botId: 'alice', chatId: 'chat-dm' }),
      conv('group', { botId: 'alice', chatId: 'chat-group' }),
      // 委派子会话：binding 记目标成员
      conv('child', { botId: 'bob', chatId: null, delegationId: 'd' }),
      conv('code'),
    ],
    load: async (file) => {
      loaded.push(file);
      return files[file] ? { records: files[file] } : null;
    },
    pricing: async () => ({ m: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    now: () => NOW,
  });
  return { service, loaded };
}

describe('BotUsageService', () => {
  it('ranks members over the selected range and leaves Code sessions out', async () => {
    const { service } = setup();
    const rows = await service.summary(7);
    expect(rows.map((row) => [row.botId, row.name, row.tokens, row.sessions])).toEqual([
      ['bob', 'BOB', 300, 1],
      ['alice', 'ALICE', 250, 3],
    ]);
    expect((await service.summary(1)).find((row) => row.botId === 'alice')?.tokens).toBe(100);
  });

  it('reports today / 7 / 30 day windows per member', async () => {
    const { service } = setup({ alice: { dailyTokens: 100 } });
    const overview = await service.overview();
    expect(overview.bots.alice.today.tokens).toBe(100);
    expect(overview.bots.alice.week.tokens).toBe(250);
    expect(overview.bots.alice.today.cost).toBeCloseTo(100 / 1_000_000);
    expect(overview.bots.alice.exhausted).toBe('tokens');
    expect(overview.bots.bob.exhausted).toBeUndefined();
  });

  it('checks only today against the budget and skips reads when unlimited', async () => {
    const { service, loaded } = setup({ bob: { dailyTokens: 301 } });
    expect(await service.exceeded('alice')).toBeNull();
    expect(loaded).toEqual([]);
    expect(await service.exceeded('bob')).toBeNull();
    expect(loaded).toEqual(['/s/child.jsonl']);
    const tight = setup({ bob: { dailyTokens: 300 }, alice: { dailyTokens: 101 } });
    expect(await tight.service.exceeded('bob')).toBe('tokens');
    // 昨天 23:59:59 的用量不计入今天
    expect(await tight.service.exceeded('alice')).toBeNull();
  });
});
