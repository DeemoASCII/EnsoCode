export const SPEAK_TEXT_MAX = 8_000;

export const ENSOBOT_WRITE_TOOL_NAMES = new Set([
  'bash',
  'edit',
  'write',
  'apply_patch',
  'powershell',
]);

export type SpeakParams =
  | { ok: true; text: string; deliveryId: string }
  | { ok: false; error: 'empty' | 'too-long' | 'bad-params' };

/**
 * 先把模型传来的参数收成一种形状，再检查空和超长。
 * 工具声明里不把 text 标成必填，这样别名和空格能在校验前被收掉。
 */
export function normalizeSpeakParams(params: unknown, nextId: () => string): SpeakParams {
  const record =
    params && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  const raw = typeof record.text === 'string' ? record.text : record.message;
  if (typeof raw !== 'string') return { ok: false, error: 'bad-params' };
  const text = raw.trim();
  if (!text) return { ok: false, error: 'empty' };
  if (text.length > SPEAK_TEXT_MAX) return { ok: false, error: 'too-long' };
  const given = typeof record.deliveryId === 'string' ? record.deliveryId.trim() : '';
  const deliveryId = given || nextId();
  if (!deliveryId || deliveryId.length > 128) return { ok: false, error: 'bad-params' };
  return { ok: true, text, deliveryId };
}
