import { expect, it, vi } from 'vitest';
import { createEnsobotInteractions } from './ensobotInteractions';

const identity = { sessionId: 'session', generation: 'generation' };
const request = {
  requestId: 'apr-1',
  tool: 'powershell',
  kind: 'command' as const,
  summary: 'Write-Output OK',
};
function harness() {
  let owner: { cardId: string; generation: string } | undefined = {
    cardId: 'card',
    generation: 'root-generation',
  };
  let ready = true;
  let id = 0;
  const approve = vi.fn(() => ({ ok: true }));
  const answer = vi.fn(() => ({ ok: true }));
  const changed = vi.fn();
  const host = createEnsobotInteractions({
    ownerOf: () => owner,
    workerReady: () => ready,
    approve,
    answer,
    changed,
    uuid: () => `token-${++id}`,
  });
  return {
    host,
    approve,
    answer,
    changed,
    setOwner: (value: typeof owner) => {
      owner = value;
    },
    setReady: (value: boolean) => {
      ready = value;
    },
  };
}

it('默认审批投影可重读；回应使用 Main 权威身份；成功等待 worker resolved，重复不执行', () => {
  const { host, approve } = harness();
  host.observe({ type: 'approval-request', identity, seq: 1, request });
  const pending = host.snapshot()[0];
  expect(pending).toMatchObject({ cardId: 'card', kind: 'approval', request, responding: false });
  expect(host.snapshot()).toEqual([pending]);
  expect(
    host.respond({ id: pending.id, cardId: 'wrong', kind: 'approval', decision: 'allow' }).ok
  ).toBe(false);
  const response = {
    id: pending.id,
    cardId: 'card',
    kind: 'approval' as const,
    decision: 'deny' as const,
  };
  expect(host.respond(response).ok).toBe(true);
  expect(approve).toHaveBeenCalledWith(identity, 'apr-1', 'deny');
  expect(host.respond(response).ok).toBe(true);
  expect(approve).toHaveBeenCalledOnce();
  expect(host.respond({ ...response, decision: 'allow' }).ok).toBe(false);
  expect(host.snapshot()[0].responding).toBe(true);
  host.observe({ type: 'approval-resolved', identity, seq: 2, requestId: 'apr-1' });
  expect(host.snapshot()).toEqual([]);
  host.observe({ type: 'approval-request', identity, seq: 1, request });
  expect(host.snapshot()).toEqual([]);
});

it('离线和投递失败保持待处理；不能把审批回应当 ask，旧代令牌不可重用', () => {
  const h = harness();
  h.host.observe({ type: 'approval-request', identity, seq: 1, request });
  const id = h.host.snapshot()[0].id;
  h.setReady(false);
  expect(
    h.host.respond({ id, cardId: 'card', kind: 'approval', decision: 'allowSession' }).ok
  ).toBe(false);
  expect(h.approve).not.toHaveBeenCalled();
  h.setReady(true);
  h.approve.mockReturnValueOnce({ ok: false });
  expect(
    h.host.respond({ id, cardId: 'card', kind: 'approval', decision: 'allowSession' }).ok
  ).toBe(false);
  expect(h.host.snapshot()[0].responding).toBe(false);
  expect(h.host.respond({ id, cardId: 'card', kind: 'ask', answer: 'yes' }).ok).toBe(false);
  h.setOwner({ cardId: 'card', generation: 'new-root' });
  expect(h.host.respond({ id, cardId: 'card', kind: 'approval', decision: 'allow' }).ok).toBe(
    false
  );
  expect(h.host.snapshot()).toEqual([]);
});

it('代审 reviewing 不可人工抢答，更新为待审批后使用同一令牌；同名 ask 独立结算', () => {
  const h = harness();
  h.host.observe({
    type: 'approval-request',
    identity,
    seq: 1,
    request: { ...request, phase: 'reviewing' },
  });
  const id = h.host.snapshot()[0].id;
  expect(h.host.respond({ id, cardId: 'card', kind: 'approval', decision: 'allow' }).ok).toBe(
    false
  );
  h.host.observe({ type: 'approval-request', identity, seq: 2, request });
  expect(h.host.snapshot()[0].id).toBe(id);
  h.host.observe({
    type: 'ask-request',
    identity,
    seq: 3,
    ask: { requestId: request.requestId, question: '继续？' },
  });
  const ask = h.host.snapshot()[1];
  expect(h.host.respond({ id: ask.id, cardId: 'card', kind: 'ask', answer: '继续' }).ok).toBe(true);
  expect(h.answer).toHaveBeenCalledWith(identity, request.requestId, '继续');
  h.host.observe({ type: 'ask-resolved', identity, seq: 4, requestId: request.requestId });
  expect(h.host.snapshot().map((x) => x.id)).toEqual([id]);
});

it('同一人物卡下子会话的同名请求与序号独立；退出清空，不持久化重放权限', () => {
  const h = harness();
  h.host.observe({ type: 'approval-request', identity, seq: 99, request });
  const child = {
    sessionId: 'child',
    generation: 'child-generation',
    parent: identity,
    instanceId: 'instance',
    instanceName: 'Reviewer',
    typeKey: 'builtin:reviewer',
  };
  h.host.observe({ type: 'approval-request', identity: child, seq: 1, request });
  expect(h.host.snapshot()).toHaveLength(2);
  const pending = h.host.snapshot()[1];
  h.host.respond({ id: pending.id, cardId: 'card', kind: 'approval', decision: 'allow' });
  expect(h.approve).toHaveBeenCalledWith(child, 'apr-1', 'allow');
  h.host.observe({ type: 'parent-ended', identity: child, seq: 2 });
  expect(h.host.snapshot()).toHaveLength(1);
  h.host.observe({ type: 'worker-exited' });
  expect(h.host.snapshot()).toEqual([]);
});

it('worker 快照恢复遗漏请求，迟到快照不能复活已结算的请求', () => {
  const h = harness();
  const session = {
    identity,
    status: 'running' as const,
    messages: [],
    commands: [],
    pendingApprovals: [request],
    pendingAsks: [],
  };
  h.host.observe({ type: 'snapshot', sessions: [session] });
  const id = h.host.snapshot()[0].id;
  h.host.observe({ type: 'snapshot', sessions: [session] });
  expect(h.host.snapshot()[0].id).toBe(id);
  h.host.observe({ type: 'approval-resolved', identity, seq: 10, requestId: request.requestId });
  h.host.observe({ type: 'snapshot', sessions: [session] });
  expect(h.host.snapshot()).toEqual([]);
});

it('轮次终态清理的请求也不能被迟到快照复活', () => {
  const h = harness();
  h.host.observe({ type: 'approval-request', identity, seq: 1, request });
  h.host.observe({ type: 'turn-failed', identity, seq: 2 });
  h.host.observe({
    type: 'snapshot',
    sessions: [
      { identity, status: 'running', messages: [], commands: [], pendingApprovals: [request] },
    ],
  });
  expect(h.host.snapshot()).toEqual([]);
});
