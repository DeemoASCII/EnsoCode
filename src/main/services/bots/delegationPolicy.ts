import type { BotProfile } from '../../../shared/types/bot';

export function delegationPolicy(
  parent: BotProfile,
  target: BotProfile,
  depth: number,
  active: number,
  members?: readonly string[]
): string | undefined {
  if (parent.id === target.id) return 'Cannot delegate to yourself.';
  if (parent.archivedAt !== undefined || target.archivedAt !== undefined)
    return 'Member is archived.';
  if (
    parent.delegation.canDelegateTo !== 'any' &&
    !parent.delegation.canDelegateTo.includes(target.id)
  )
    return 'Your delegation permissions do not allow this target.';
  if (target.delegation.acceptFrom !== 'any' && !target.delegation.acceptFrom.includes(parent.id))
    return 'Target does not accept delegations from you.';
  if (members && !members.includes(target.id))
    return 'Group delegations must stay within this group.';
  if (depth > 2) return 'Delegation depth limit (2) reached.';
  if (active >= 3) return 'Parent session already has 3 active delegations.';
  return undefined;
}

export function intersectBotPermissions(parent: BotProfile, target: BotProfile): BotProfile {
  const a = parent.approvalMode,
    b = target.approvalMode;
  // assistant is policy-driven, not a total ordering relative to auto-edits.
  const approvalMode = a === b ? a : a === 'full' ? b : b === 'full' ? a : 'supervised';
  return {
    ...target,
    tools: parent.tools === 'readonly' || target.tools === 'readonly' ? 'readonly' : 'all',
    approvalMode,
    skillIds: target.skillIds.filter((id) => parent.skillIds.includes(id)),
    mcpServerIds: target.mcpServerIds.filter((id) => parent.mcpServerIds.includes(id)),
  };
}
