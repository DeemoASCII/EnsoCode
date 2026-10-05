export const DEFAULT_BOT_MAX_RUNNING_TURNS = 4;
export const MIN_BOT_MAX_RUNNING_TURNS = 1;
export const MAX_BOT_MAX_RUNNING_TURNS = 16;

/** 全局 Bot 并发上限：非法/缺失回落默认值，整数夹到 1–16 */
export function normalizeBotMaxRunningTurns(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return DEFAULT_BOT_MAX_RUNNING_TURNS;
  if (value < MIN_BOT_MAX_RUNNING_TURNS) return MIN_BOT_MAX_RUNNING_TURNS;
  if (value > MAX_BOT_MAX_RUNNING_TURNS) return MAX_BOT_MAX_RUNNING_TURNS;
  return value;
}
