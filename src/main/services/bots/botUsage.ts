import type { ConversationAuthority } from '../../../shared/types/agent';
import type { BotProfile } from '../../../shared/types/bot';
import { localDayKey } from '../../../shared/usage/aggregate';
import {
  attributeBotRecords,
  type BotBudgetVerdict,
  type BotUsageOverview,
  type BotUsageRow,
  botOfConversation,
  budgetVerdict,
  localDayStart,
  sumBotUsage,
} from '../../../shared/usage/botUsage';
import type { PricingTable } from '../../../shared/usage/pricing';
import type { UsageRangeDays, UsageRecord } from '../../../shared/usage/types';

export interface BotUsageDeps {
  bots: { get(id: string): BotProfile | undefined; list(): BotProfile[] };
  /** 全部 bot 会话 authority（私聊、群聊、委派子会话） */
  conversations: () => readonly ConversationAuthority[];
  /** 读 pi jsonl 的用量记录（复用用量页解析缓存） */
  load: (file: string) => Promise<{ records: UsageRecord[] } | null>;
  pricing: (now: number) => Promise<PricingTable>;
  now?: () => number;
}

/** 按成员归集 bot 会话的用量：排行、概览与日预算判定共用同一数据源 */
export class BotUsageService {
  constructor(private readonly deps: BotUsageDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async records(botId?: string): Promise<Map<string, UsageRecord[]>> {
    const sessions: { botId: string; records: UsageRecord[] }[] = [];
    for (const conversation of this.deps.conversations()) {
      const owner = botOfConversation(conversation);
      if (!owner || !conversation.sessionFile || (botId && owner !== botId)) continue;
      const parsed = await this.deps.load(conversation.sessionFile).catch(() => null);
      if (parsed) sessions.push({ botId: owner, records: parsed.records });
    }
    return attributeBotRecords(sessions);
  }

  /** 与用量页同一周期口径：[今天 00:00 + 1 天 - days 天, 明天 00:00) */
  async summary(days: UsageRangeDays): Promise<BotUsageRow[]> {
    const now = this.now();
    const [byBot, pricing] = await Promise.all([this.records(), this.deps.pricing(now)]);
    const start = localDayStart(now, 1 - days);
    const end = localDayStart(now, 1);
    const rows: BotUsageRow[] = [];
    for (const [botId, records] of byBot) {
      const totals = sumBotUsage(records, pricing, start, end);
      if (totals.messages === 0) continue;
      rows.push({ botId, name: this.deps.bots.get(botId)?.name ?? '', ...totals });
    }
    return rows.sort((a, b) => b.tokens - a.tokens);
  }

  async overview(): Promise<{ day: string; bots: Record<string, BotUsageOverview> }> {
    const now = this.now();
    const [byBot, pricing] = await Promise.all([this.records(), this.deps.pricing(now)]);
    const end = localDayStart(now, 1);
    const bots: Record<string, BotUsageOverview> = {};
    for (const bot of this.deps.bots.list()) {
      const records = byBot.get(bot.id) ?? [];
      const today = sumBotUsage(records, pricing, localDayStart(now), end);
      const exhausted = budgetVerdict(bot.budget, today);
      bots[bot.id] = {
        today,
        week: sumBotUsage(records, pricing, localDayStart(now, -6), end),
        month: sumBotUsage(records, pricing, localDayStart(now, -29), end),
        ...(exhausted ? { exhausted } : {}),
      };
    }
    return { day: localDayKey(now), bots };
  }

  /** 今日（本地自然日）是否已触达该成员的上限；未设预算不读文件 */
  async exceeded(botId: string): Promise<BotBudgetVerdict | null> {
    const budget = this.deps.bots.get(botId)?.budget;
    if (!budget) return null;
    const now = this.now();
    const [byBot, pricing] = await Promise.all([
      this.records(botId),
      budget.dailyCostUsd !== undefined ? this.deps.pricing(now) : Promise.resolve({}),
    ]);
    return budgetVerdict(
      budget,
      sumBotUsage(byBot.get(botId) ?? [], pricing, localDayStart(now), localDayStart(now, 1))
    );
  }
}
