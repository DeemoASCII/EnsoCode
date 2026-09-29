import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fork: vi.fn(), root: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => mocks.root, getAppPath: () => mocks.root, isPackaged: false },
  utilityProcess: { fork: mocks.fork },
}));
vi.mock('../../agent/index?modulePath', () => ({ default: '/tmp/agent.js' }));
vi.mock('../ipc/settings', () => ({ readSettings: () => ({}) }));

class Worker extends EventEmitter {
  postMessage = vi.fn();
  kill = vi.fn(() => this.emit('exit'));
}

let host: typeof import('./agentHost');
beforeEach(async () => {
  vi.resetModules();
  mocks.root = mkdtempSync(path.join(tmpdir(), 'agent-lifecycle-'));
  mocks.fork.mockReset().mockImplementation(() => new Worker());
  host = await import('./agentHost');
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(mocks.root, { recursive: true, force: true });
});

it('仅在曾退出后按需重启，等待 spawn 而非把 fork 当作在线', async () => {
  expect(await host.ensureAgentWorkerReady()).toBe(false);
  expect(mocks.fork).not.toHaveBeenCalled();
  host.startAgentWorker();
  const first = mocks.fork.mock.results[0].value as Worker;
  first.emit('spawn');
  expect(await host.ensureAgentWorkerReady()).toBe(true);
  first.emit('exit');
  let ready = false;
  const pending = host.ensureAgentWorkerReady().then((value) => {
    ready = value;
    return value;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  const second = mocks.fork.mock.results[1].value as Worker;
  second.emit('spawn');
  expect(await pending).toBe(true);
  host.stopAgentWorker();
});

it('等待过程中退出或超时明确失败，移除监听器', async () => {
  host.startAgentWorker();
  const child = mocks.fork.mock.results[0].value as Worker;
  const pending = host.ensureAgentWorkerReady();
  child.emit('exit');
  expect(await pending).toBe(false);
  vi.useFakeTimers();
  const timeout = host.ensureAgentWorkerReady();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await timeout).toBe(false);
  host.stopAgentWorker();
});
