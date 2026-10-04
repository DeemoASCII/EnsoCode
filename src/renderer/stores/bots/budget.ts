import type { BotBudget } from '@shared/types/bot';
import type { BotBudgetVerdict, BotUsageOverview } from '@shared/usage/botUsage';

/** 表单里以字符串编辑，留空 = 不限 */
export interface BudgetForm {
  budgetCost: string;
  budgetTokens: string;
}

export interface BotUsageSnapshot {
  day: string;
  bots: Record<string, BotUsageOverview>;
}

export interface BudgetAlert {
  botId: string;
  day: string;
  reason: BotBudgetVerdict;
  /** 收件箱「忽略」的键：按成员 + 自然日 */
  key: string;
}

export function budgetFormOf(budget: BotBudget | undefined): BudgetForm {
  return {
    budgetCost: budget?.dailyCostUsd !== undefined ? String(budget.dailyCostUsd) : '',
    budgetTokens: budget?.dailyTokens !== undefined ? String(budget.dailyTokens) : '',
  };
}

/** budget:null = 不限；ok:false = 有非法输入 */
export function budgetDraft(
  form: BudgetForm
): { ok: true; budget: BotBudget | null } | { ok: false } {
  const budget: BotBudget = {};
  const cost = form.budgetCost.trim();
  if (cost) {
    const value = Number(cost);
    if (!Number.isFinite(value) || value <= 0) return { ok: false };
    budget.dailyCostUsd = value;
  }
  const tokens = form.budgetTokens.trim();
  if (tokens) {
    const value = Number(tokens);
    if (!Number.isSafeInteger(value) || value <= 0) return { ok: false };
    budget.dailyTokens = value;
  }
  return { ok: true, budget: Object.keys(budget).length > 0 ? budget : null };
}

export function budgetAlerts(
  usage: BotUsageSnapshot | null,
  dismissed: readonly string[]
): BudgetAlert[] {
  if (!usage) return [];
  const alerts: BudgetAlert[] = [];
  for (const [botId, overview] of Object.entries(usage.bots)) {
    if (!overview.exhausted) continue;
    const key = `${botId}:${usage.day}`;
    if (!dismissed.includes(key))
      alerts.push({ botId, day: usage.day, reason: overview.exhausted, key });
  }
  return alerts;
}
