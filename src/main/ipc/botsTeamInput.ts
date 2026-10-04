import { parseTeamFile, parseTeamSpec, type TeamFileError, type TeamSpec } from '@shared/bots/team';
import { isBotId } from '@shared/types/bot';
import type { BotTeamCreateRequest } from '@shared/types/botIpc';

type Rec = Record<string, unknown>;
const record = (value: unknown): Rec | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
const only = (value: Rec, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

export function parseTeamPreviewInput(
  value: unknown
): { ok: true; team: TeamSpec } | { ok: false; error: TeamFileError } {
  const input = record(value);
  if (input && only(input, ['text']) && typeof input.text === 'string') {
    return parseTeamFile(input.text);
  }
  const team = input && only(input, ['team']) ? parseTeamSpec(input.team) : null;
  return team ? { ok: true, team } : { ok: false, error: 'invalid' };
}

export function parseTeamCreateInput(value: unknown): BotTeamCreateRequest | null {
  const input = record(value);
  if (!input || !only(input, ['team', 'workspace'])) return null;
  const team = parseTeamSpec(input.team);
  const ws = record(input.workspace);
  if (!team || !ws) return null;
  if (ws.kind === 'chat-home' && only(ws, ['kind']))
    return { team, workspace: { kind: 'chat-home' } };
  if (ws.kind === 'project' && only(ws, ['kind', 'projectId']) && isBotId(ws.projectId)) {
    return { team, workspace: { kind: 'project', projectId: ws.projectId } };
  }
  return null;
}
