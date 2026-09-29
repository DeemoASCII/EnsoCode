import { isCharacterCardId } from '../characterCard';
import type { ApprovalDecision, ApprovalRequestInfo, AskRequestInfo } from '../types/agent';

/** 只暴露 Main 生成的令牌，不接受 Renderer 自选 worker session/generation。 */
export type EnsobotInteraction = { id: string; cardId: string; responding: boolean } & (
  | { kind: 'approval'; request: ApprovalRequestInfo }
  | { kind: 'ask'; request: AskRequestInfo }
);
export type EnsobotResponse = { id: string; cardId: string } & (
  | { kind: 'approval'; decision: ApprovalDecision }
  | { kind: 'ask'; answer: string }
);

export function parseEnsobotResponse(raw: unknown): EnsobotResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (
    !isCharacterCardId(value.cardId) ||
    typeof value.id !== 'string' ||
    !value.id.trim() ||
    value.id.length > 128
  )
    return null;
  const base = { id: value.id, cardId: value.cardId };
  if (
    value.kind === 'approval' &&
    (value.decision === 'allow' || value.decision === 'allowSession' || value.decision === 'deny')
  )
    return { ...base, kind: 'approval', decision: value.decision };
  if (
    value.kind === 'ask' &&
    typeof value.answer === 'string' &&
    value.answer.trim() &&
    value.answer.length <= 8000
  )
    return { ...base, kind: 'ask', answer: value.answer.trim() };
  return null;
}
