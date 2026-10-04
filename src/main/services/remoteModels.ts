import type { SpawnModelConfig } from '@shared/types/agent';
import { resolveModelSelection } from './agentHost';
import { readStoredOauthCredentialKeys } from './oauthProviders';
import { titleModelCandidates } from './titleSummary';

/** 功能单独选的远程模型排最前，其后是标题模型的回退链 */
export async function remoteCandidates(
  state: Record<string, unknown>,
  preferred: unknown
): Promise<SpawnModelConfig[]> {
  const credentialKeys = await readStoredOauthCredentialKeys();
  const chain = [
    ...(preferred && typeof preferred === 'object'
      ? [preferred as { providerId: string; modelId: string }]
      : []),
    ...titleModelCandidates(state),
  ];
  const candidates: SpawnModelConfig[] = [];
  for (const candidate of chain) {
    const resolved = resolveModelSelection(candidate.providerId, candidate.modelId, credentialKeys);
    if (resolved.ok && resolved.selection) candidates.push(resolved.selection.config);
  }
  return candidates;
}
