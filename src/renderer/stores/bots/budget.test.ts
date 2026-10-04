import { describe, expect, it } from 'vitest';
import { budgetAlerts, budgetDraft, budgetFormOf, limitsDraft, limitsFormOf } from './budget';

describe('budget form', () => {
  it('round-trips a stored budget and treats blanks as unlimited', () => {
    expect(budgetFormOf(undefined)).toEqual({ budgetCost: '', budgetTokens: '' });
    expect(budgetFormOf({ dailyCostUsd: 0.5, dailyTokens: 2000 })).toEqual({
      budgetCost: '0.5',
      budgetTokens: '2000',
    });
    expect(budgetDraft({ budgetCost: ' ', budgetTokens: '' })).toEqual({ ok: true, budget: null });
    expect(budgetDraft({ budgetCost: '1.25', budgetTokens: '' })).toEqual({
      ok: true,
      budget: { dailyCostUsd: 1.25 },
    });
    expect(budgetDraft({ budgetCost: '', budgetTokens: '1500' })).toEqual({
      ok: true,
      budget: { dailyTokens: 1500 },
    });
  });

  it('rejects non-positive or malformed caps', () => {
    for (const form of [
      { budgetCost: '0', budgetTokens: '' },
      { budgetCost: '-1', budgetTokens: '' },
      { budgetCost: 'abc', budgetTokens: '' },
      { budgetCost: '', budgetTokens: '1.5' },
      { budgetCost: '', budgetTokens: '0' },
    ])
      expect(budgetDraft(form).ok, JSON.stringify(form)).toBe(false);
  });
});

describe('limits form', () => {
  it('round-trips the delegation time limit; blank = default (null)', () => {
    expect(limitsFormOf({})).toEqual({ delegationTimeout: '' });
    expect(limitsFormOf({ delegationTimeoutMinutes: 30 })).toEqual({ delegationTimeout: '30' });
    expect(limitsDraft({ delegationTimeout: ' ' })).toEqual({
      ok: true,
      delegationTimeoutMinutes: null,
    });
    expect(limitsDraft({ delegationTimeout: '90' })).toEqual({
      ok: true,
      delegationTimeoutMinutes: 90,
    });
    for (const delegationTimeout of ['0', '1.5', '1441', 'x'])
      expect(limitsDraft({ delegationTimeout }).ok, delegationTimeout).toBe(false);
  });
});

describe('budgetAlerts', () => {
  const today = { tokens: 0, cost: null, messages: 0, sessions: 0 };
  const row = { today, week: today, month: today };
  it('lists members exhausted today that have not been dismissed for that day', () => {
    const overview = {
      day: '2026-10-04',
      bots: {
        a: { ...row, exhausted: 'tokens' as const },
        b: row,
        c: { ...row, exhausted: 'cost' as const },
      },
    };
    expect(budgetAlerts(overview, ['c:2026-10-04', 'a:2026-10-03'])).toEqual([
      { botId: 'a', day: '2026-10-04', reason: 'tokens', key: 'a:2026-10-04' },
    ]);
    expect(budgetAlerts(null, [])).toEqual([]);
  });
});
