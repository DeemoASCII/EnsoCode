import {
  type AbilitySuggestInput,
  abilitySuggestPrompt,
  parseAbilitySuggestion,
} from '../../../shared/bots/abilitySuggest';
import type { BotAbilitySuggestResult } from '../../../shared/types/botIpc';

export const ABILITY_SUGGEST_TIMEOUT_MS = 20_000;

/** 便宜模型一次性补全；没有可用模型返回 null */
export type AbilityCompleter = (
  request: { systemPrompt: string; userText: string; timeoutMs: number },
  signal: AbortSignal
) => Promise<string | null>;

export async function suggestAbilities(
  input: AbilitySuggestInput,
  complete: AbilityCompleter,
  timeoutMs = ABILITY_SUGGEST_TIMEOUT_MS
): Promise<BotAbilitySuggestResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, timeoutMs);
  });
  try {
    const text = await Promise.race([
      complete({ ...abilitySuggestPrompt(input), timeoutMs }, controller.signal),
      timeout,
    ]);
    if (text === 'timeout') return { ok: false, error: 'timeout' };
    if (text === null) return { ok: false, error: 'no-model' };
    const suggestion = parseAbilitySuggestion(text, input);
    if (!suggestion) {
      console.warn('[bots] ability suggestion not understood:', text.slice(0, 120));
      return { ok: false, error: 'invalid-reply' };
    }
    return { ok: true, suggestion };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, error: 'timeout' };
    return {
      ok: false,
      error: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
