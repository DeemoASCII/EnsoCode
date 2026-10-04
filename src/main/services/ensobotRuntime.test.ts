import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EnsobotHost, EnsobotHostDeps } from './ensobotHost';

const mocks = vi.hoisted(() => ({
  root: '',
  observe: vi.fn(),
  readWork: vi.fn(() => ({ ok: true, text: '分块证据', nextOffset: null, revision: 'rev' })),
  deps: null as EnsobotHostDeps | null,
  spawn: vi.fn((..._args: unknown[]) => ({ ok: true })),
  prepare: vi.fn(async () => true),
  approve: vi.fn(() => ({ ok: true })),
  answer: vi.fn(() => ({ ok: true })),
  owner: vi.fn(() => ({ cardId: '11111111-1111-4111-8111-111111111111', generation: 'g' })),
  resume: vi.fn(async () => undefined),
  spawnListeners: [] as (() => void)[],
  ready: true,
}));
vi.mock('electron', () => ({ app: { getPath: () => mocks.root } }));
vi.mock('../windows/createAppWindow', () => ({ sendToAllWindows: vi.fn() }));
vi.mock('./agentHost', () => ({
  isAgentWorkerReady: () => mocks.ready,
  ensureAgentWorkerReady: mocks.prepare,
  onAgentWorkerSpawn: (listener: () => void) => {
    mocks.spawnListeners.push(listener);
    return () => undefined;
  },
  spawnSession: mocks.spawn,
  promptSession: vi.fn(),
  steerSession: vi.fn(),
  readSettingsState: () => ({}),
  respondApproval: mocks.approve,
  respondAsk: mocks.answer,
}));
vi.mock('./characterCards', () => ({
  createCharacterCardStore: () => ({ list: () => ({ cards: [] }) }),
}));
vi.mock('./oauthProviders', () => ({ readStoredOauthCredentialKeys: async () => [] }));
vi.mock('./ensobotHost', () => ({
  createEnsobotHost: (_root: string, deps: EnsobotHostDeps) => {
    mocks.deps = deps;
    return {
      observe: mocks.observe,
      readWork: mocks.readWork,
      ownerOfSession: mocks.owner,
      touch: vi.fn(),
      resume: mocks.resume,
    } as unknown as EnsobotHost;
  },
}));
let runtime: typeof import('./ensobotRuntime');
beforeEach(async () => {
  vi.resetModules();
  mocks.observe.mockClear();
  mocks.readWork.mockClear();
  mocks.spawn.mockClear();
  mocks.prepare.mockClear();
  mocks.approve.mockClear();
  mocks.answer.mockClear();
  mocks.resume.mockClear();
  mocks.spawnListeners = [];
  mocks.ready = true;
  mocks.root = mkdtempSync(path.join(tmpdir(), 'ensobot-runtime-'));
  runtime = await import('./ensobotRuntime');
});
afterEach(() => rmSync(mocks.root, { recursive: true, force: true }));

it('远端工具证据按同一 host 路径读取，并保留分块与 revision 回执', async () => {
  const request = {
    evidenceId: '11111111-1111-4111-8111-111111111111',
    field: 'output' as const,
    offset: 0,
  };
  const result = await runtime.handleEnsobotGuestCommand({
    type: 'ensobot-work-read',
    requestId: 'read-1',
    request,
  });
  expect(result).toEqual({ ok: true, text: '分块证据', nextOffset: null, revision: 'rev' });
  expect(mocks.readWork).toHaveBeenCalledWith(request);
});

it('转交终态、会话生命周期及 worker 退出事件，不再在运行器吞掉', async () => {
  const { observeEnsobotWorkerEvent } = runtime;
  const identity = { sessionId: 's', generation: 'g' };
  const events = [
    {
      type: 'message-upsert' as const,
      identity,
      seq: 1,
      index: 0,
      message: { role: 'toolResult', content: [] },
    },
    { type: 'worker-exited' as const },
    { type: 'parent-ended' as const, identity, seq: 1, reason: 'evicted' },
    { type: 'parent-rejected' as const, identity, seq: 0, reason: 'gone' },
    { type: 'turn-completed' as const, identity, seq: 2, turnId: 't' },
    { type: 'turn-failed' as const, identity, seq: 3, turnId: 't', error: 'failed' },
  ];
  for (const event of events) observeEnsobotWorkerEvent(event);
  expect(mocks.observe.mock.calls.map(([event]) => event)).toEqual(events);
});

it('恢复沿用 Main 保存的 sessionFile，同时具备按需重启 worker 的入口', async () => {
  const { getEnsobotHost } = runtime;
  getEnsobotHost();
  mocks.deps!.spawn({
    sessionId: 's',
    generation: 'new',
    cwd: mocks.root,
    providerId: 'p',
    modelId: 'm',
    approvalMode: 'supervised',
    rolePrompt: '',
    coordinator: false,
    extraDisabledTools: [],
    resumeFile: path.join(mocks.root, 'history.jsonl'),
  });
  expect(mocks.spawn.mock.calls[0]?.[1]).toMatchObject({
    resumeFile: path.join(mocks.root, 'history.jsonl'),
  });
  await mocks.deps!.prepareWorker?.();
  expect(mocks.prepare).toHaveBeenCalledOnce();
});

it('排着的消息在 worker 就绪时接着送：已在就立刻送，否则等它起来；只挂一次监听', () => {
  mocks.ready = false;
  runtime.getEnsobotHost();
  runtime.getEnsobotHost();
  expect(mocks.resume).not.toHaveBeenCalled();
  expect(mocks.spawnListeners).toHaveLength(1);
  mocks.spawnListeners[0]();
  expect(mocks.resume).toHaveBeenCalledOnce();
});

it('宿主建好时 worker 已经在：马上接着送排队的消息', () => {
  runtime.getEnsobotHost();
  expect(mocks.resume).toHaveBeenCalledOnce();
});

it('审批与提问通过真实运行器投影并经 guest 命令回应 worker，不采信调用方自选目标', async () => {
  runtime.getEnsobotHost();
  const identity = { sessionId: 's', generation: 'g' };
  runtime.observeEnsobotWorkerEvent({
    type: 'approval-request',
    identity,
    seq: 10,
    request: { requestId: 'apr', tool: 'powershell', kind: 'command', summary: 'echo ok' },
  });
  runtime.observeEnsobotWorkerEvent({
    type: 'ask-request',
    identity,
    seq: 11,
    ask: { requestId: 'ask', question: '继续？' },
  });
  const pending = mocks.deps!.interactions!();
  expect(pending.map((item) => item.kind)).toEqual(['approval', 'ask']);
  const approval = pending[0];
  const result = await runtime.handleEnsobotGuestCommand({
    type: 'ensobot-respond',
    deliveryId: 'receipt',
    response: { id: approval.id, cardId: approval.cardId, kind: 'approval', decision: 'allow' },
  });
  expect(result.ok).toBe(true);
  expect(mocks.approve).toHaveBeenCalledWith(identity, 'apr', 'allow');
  const ask = pending[1];
  expect(
    runtime.respondEnsobotInteraction({
      id: ask.id,
      cardId: ask.cardId,
      kind: 'ask',
      answer: '继续',
      sessionId: 'forged',
    }).ok
  ).toBe(true);
  expect(mocks.answer).toHaveBeenCalledWith(identity, 'ask', '继续');
  runtime.observeEnsobotWorkerEvent({
    type: 'approval-resolved',
    identity,
    seq: 12,
    requestId: 'apr',
  });
  runtime.observeEnsobotWorkerEvent({ type: 'ask-resolved', identity, seq: 13, requestId: 'ask' });
  expect(mocks.deps!.interactions!()).toEqual([]);
});
