/** 单次证据回执的字符上限；最坏 UTF-8/JSON 编码仍远低于 pair 的 1MB 防线。 */
export const ENSOBOT_EVIDENCE_CHUNK_MAX = 16_000;

export interface EnsobotWorkReadRequest {
  evidenceId: string;
  field: 'parameters' | 'output';
  /** UTF-16 字符偏移，与 text.length / slice 保持一致。 */
  offset: number;
  /** 续页必须带首次读取的 revision；内容变化返回 stale，重新从 0 读取。 */
  revision?: string;
}

export type EnsobotWorkReadResult =
  | { ok: true; text: string; nextOffset: number | null; revision: string }
  | { ok: false; error: 'bad-params' | 'not-found' | 'stale' };

export function isEnsobotEvidenceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
  );
}

/** IPC 和 pair 共用严格校验；绝不接受 card/session/path 作为证据寻址条件。 */
export function parseEnsobotWorkRead(value: unknown): EnsobotWorkReadRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !['evidenceId', 'field', 'offset', 'revision'].includes(key))
  )
    return null;
  if (
    !isEnsobotEvidenceId(input.evidenceId) ||
    (input.field !== 'parameters' && input.field !== 'output')
  )
    return null;
  if (typeof input.offset !== 'number' || !Number.isSafeInteger(input.offset) || input.offset < 0)
    return null;
  if (
    input.revision !== undefined &&
    (typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision))
  )
    return null;
  if (input.offset > 0 && input.revision === undefined) return null;
  return {
    evidenceId: input.evidenceId,
    field: input.field,
    offset: input.offset,
    ...(typeof input.revision === 'string' ? { revision: input.revision } : {}),
  };
}
