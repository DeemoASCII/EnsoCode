import type { SessionIdentity } from '@shared/builtinAgents';
import type { EnsobotInteraction, EnsobotResponse } from '@shared/ensobot/interaction';
import type {
  AgentActionResult,
  ApprovalDecision,
  ApprovalRequestInfo,
  AskRequestInfo,
  SessionSnapshot,
} from '@shared/types/agent';

export interface EnsobotInteractionEvent {
  type: string;
  identity?: SessionIdentity;
  seq?: number;
  request?: ApprovalRequestInfo;
  ask?: AskRequestInfo;
  requestId?: string;
  sessions?: SessionSnapshot[];
}
interface Owner {
  cardId: string;
  generation: string;
}
interface Entry {
  identity: SessionIdentity;
  owner: Owner;
  view: EnsobotInteraction;
  response?: string;
}

export function createEnsobotInteractions(deps: {
  ownerOf: (identity: SessionIdentity) => Owner | undefined;
  workerReady: () => boolean;
  approve: (
    identity: SessionIdentity,
    requestId: string,
    decision: ApprovalDecision
  ) => AgentActionResult;
  answer: (identity: SessionIdentity, requestId: string, answer: string) => AgentActionResult;
  uuid: () => string;
  changed: () => void;
}) {
  const entries = new Map<string, Entry>();
  const lastSeq = new Map<string, number>();
  const settled = new Set<string>();
  const keyOf = (identity: SessionIdentity) =>
    JSON.stringify([identity.sessionId, identity.generation]);
  const current = (entry: Entry) => {
    const owner = deps.ownerOf(entry.identity);
    return owner?.cardId === entry.owner.cardId && owner?.generation === entry.owner.generation;
  };
  const prune = () => {
    for (const [id, entry] of entries) if (!current(entry)) entries.delete(id);
  };
  const remove = (identity: SessionIdentity, kind?: string, requestId?: string) => {
    for (const [id, entry] of entries) {
      if (
        keyOf(entry.identity) === keyOf(identity) &&
        (!kind || entry.view.kind === kind) &&
        (!requestId || entry.view.request.requestId === requestId)
      ) {
        settled.add(
          JSON.stringify([keyOf(entry.identity), entry.view.kind, entry.view.request.requestId])
        );
        entries.delete(id);
      }
    }
  };
  const upsert = (
    identity: SessionIdentity,
    owner: Owner,
    data:
      | { kind: 'approval'; request: ApprovalRequestInfo }
      | { kind: 'ask'; request: AskRequestInfo }
  ) => {
    if (settled.has(JSON.stringify([keyOf(identity), data.kind, data.request.requestId]))) return;
    const prior = [...entries.values()].find(
      (entry) =>
        keyOf(entry.identity) === keyOf(identity) &&
        entry.view.kind === data.kind &&
        entry.view.request.requestId === data.request.requestId
    );
    const id = prior?.view.id ?? deps.uuid();
    entries.set(id, {
      identity: { ...identity },
      owner: { ...owner },
      response: prior?.response,
      view: {
        id,
        cardId: owner.cardId,
        responding: prior?.view.responding ?? false,
        ...structuredClone(data),
      },
    });
  };
  return {
    snapshot(): EnsobotInteraction[] {
      prune();
      return [...entries.values()].map((entry) => structuredClone(entry.view));
    },
    observe(event: EnsobotInteractionEvent): void {
      const before = JSON.stringify([...entries.values()].map((entry) => entry.view));
      prune();
      if (event.type === 'worker-exited') {
        entries.clear();
        lastSeq.clear();
        settled.clear();
      } else if (event.type === 'snapshot') {
        for (const session of event.sessions ?? []) {
          const owner = deps.ownerOf(session.identity);
          const key = keyOf(session.identity);
          if (!owner) continue;
          const ids = new Set([
            ...(session.pendingApprovals ?? []).map((request) => `approval:${request.requestId}`),
            ...(session.pendingAsks ?? []).map((request) => `ask:${request.requestId}`),
          ]);
          for (const [id, entry] of entries) {
            if (
              keyOf(entry.identity) === key &&
              !ids.has(`${entry.view.kind}:${entry.view.request.requestId}`)
            )
              entries.delete(id);
          }
          for (const request of session.pendingApprovals ?? [])
            upsert(session.identity, owner, { kind: 'approval', request });
          for (const request of session.pendingAsks ?? [])
            upsert(session.identity, owner, { kind: 'ask', request });
        }
      } else if (
        event.identity?.sessionId &&
        event.identity.generation &&
        typeof event.seq === 'number'
      ) {
        const identity = event.identity;
        const key = keyOf(identity);
        const owner = deps.ownerOf(identity);
        if (event.seq > (lastSeq.get(key) ?? -1)) {
          lastSeq.set(key, event.seq);
          if (
            event.type === 'parent-ended' ||
            event.type === 'child-ended' ||
            event.type === 'parent-rejected' ||
            event.type === 'child-rejected' ||
            event.type === 'turn-failed' ||
            event.type === 'turn-completed'
          )
            remove(identity);
          if (event.type === 'approval-resolved' || event.type === 'ask-resolved') {
            const kind = event.type === 'approval-resolved' ? 'approval' : 'ask';
            settled.add(JSON.stringify([key, kind, event.requestId]));
            remove(identity, kind, event.requestId);
          }
          if (owner && event.type === 'approval-request' && event.request)
            upsert(identity, owner, { kind: 'approval', request: event.request });
          if (owner && event.type === 'ask-request' && event.ask)
            upsert(identity, owner, { kind: 'ask', request: event.ask });
        }
      }
      if (JSON.stringify([...entries.values()].map((entry) => entry.view)) !== before)
        deps.changed();
    },
    respond(input: EnsobotResponse): AgentActionResult {
      prune();
      const entry = entries.get(input.id);
      if (!entry || entry.owner.cardId !== input.cardId || entry.view.kind !== input.kind)
        return { ok: false, error: 'stale-interaction' };
      if (entry.view.kind === 'approval' && entry.view.request.phase === 'reviewing')
        return { ok: false, error: 'reviewing' };
      const fingerprint = JSON.stringify(input);
      if (entry.response)
        return entry.response === fingerprint
          ? { ok: true }
          : { ok: false, error: 'already-responded' };
      if (!deps.workerReady()) return { ok: false, error: 'worker-offline' };
      const result =
        input.kind === 'approval'
          ? deps.approve(entry.identity, entry.view.request.requestId, input.decision)
          : deps.answer(entry.identity, entry.view.request.requestId, input.answer);
      if (result.ok) {
        entry.response = fingerprint;
        entry.view.responding = true;
        deps.changed();
      }
      return result;
    },
  };
}
