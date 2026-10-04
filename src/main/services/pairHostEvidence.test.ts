import { openFrame, sealFrame, toBase64Url } from '@enso/pair';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface TestSocket {
  readyState: number;
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const hostMocks = vi.hoisted(() => ({
  sockets: new Map<string, TestSocket>(),
  readWork: vi.fn(),
  loadDevices: vi.fn(),
}));

vi.mock('@enso/pair', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@enso/pair')>()),
  attachHeartbeat: () => ({ stop: vi.fn(), probe: vi.fn() }),
}));
vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  powerMonitor: { on: vi.fn() },
  powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn() },
}));
vi.mock('./agentHost', () => ({
  requestSnapshot: vi.fn(),
  setPinnedSessions: vi.fn(),
}));
vi.mock('./macosSystemSleepAssertion', () => ({
  MacosSystemSleepAssertion: class {
    start(): void {}
    stop(): void {}
  },
}));
vi.mock('./notifications', () => ({ readNotifyMainAgentOnly: () => false }));
vi.mock('./pairDirectConfig', () => ({ PAIR_DIRECT_ENABLED: false, PAIR_STUN_SERVERS: [] }));
vi.mock('./pairDirectPeer', () => ({
  isDirectPeerAvailable: () => false,
  mainDirectPeerFactory: null,
  preloadDirectPeer: () => Promise.resolve(),
}));
vi.mock('./pairNetworkWatch', () => ({ startPairNetworkWatch: () => vi.fn() }));
vi.mock('./pairRelayLookup', () => ({ seedRelayHostCache: vi.fn() }));
vi.mock('./pairRelayOpen', () => ({
  openPairRelayWebSocket: (url: string) =>
    Promise.resolve(hostMocks.sockets.get(new URL(url).pathname.split('/').at(-1)!)),
}));
vi.mock('./pairStore', () => ({
  isSecureStorageAvailable: () => true,
  loadDevices: hostMocks.loadDevices,
  loadRelayHostCache: () => null,
  loadRelayUrl: () => null,
  renameDevice: (devices: unknown) => devices,
  saveDevices: vi.fn(),
  saveRelayUrl: vi.fn(),
  upsertDevice: (devices: unknown) => devices,
}));
vi.mock('./pushNotifier', () => ({
  buildPushPayload: () => null,
  clearPushSubscription: vi.fn(),
  getVapidPublicKey: () => '',
  hasPushSubscription: () => false,
  sendPush: vi.fn(),
  setPushSubscription: vi.fn(),
}));

vi.mock('./ensobotRuntime', () => ({ handleEnsobotGuestCommand: hostMocks.readWork }));

import { publishEnsobotFrame, startPairHost, stopPairHost } from './pairHost';

const contentKey = new Uint8Array(32).fill(7);
const request = { evidenceId: '11111111-1111-4111-8111-111111111111', field: 'output', offset: 0 };

async function sentPayloads(socket: TestSocket): Promise<Record<string, unknown>[]> {
  return Promise.all(
    socket.send.mock.calls.map(
      async ([data]) =>
        (await openFrame(contentKey, new Uint8Array(data))) as Record<string, unknown>
    )
  );
}

async function receive(socket: TestSocket, payload: unknown): Promise<void> {
  const frame = await sealFrame(contentKey, payload);
  socket.onmessage?.({
    data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer,
  });
}

beforeEach(async () => {
  hostMocks.readWork.mockReset();
  hostMocks.sockets.clear();
  for (const id of ['pair-1', 'pair-2'])
    hostMocks.sockets.set(id, {
      readyState: 1,
      binaryType: '',
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: vi.fn(),
      close: vi.fn(),
    });
  hostMocks.loadDevices.mockReturnValue(
    [...hostMocks.sockets.keys()].map((pairId) => ({
      pairId,
      token: 'token',
      contentKey: toBase64Url(contentKey),
      deviceName: pairId,
      relayUrl: 'https://relay.example.com',
      pairedAt: 1,
    }))
  );
  startPairHost();
  for (const socket of hostMocks.sockets.values()) {
    await vi.waitFor(() => expect(socket.onmessage).toBeTypeOf('function'));
    socket.onopen?.();
    socket.onmessage?.({ data: JSON.stringify({ type: 'peer-joined' }) });
    await vi.waitFor(async () =>
      expect((await sentPayloads(socket)).some((frame) => frame.type === 'host-info')).toBe(true)
    );
    socket.send.mockClear();
  }
});
afterEach(() => {
  stopPairHost();
  vi.restoreAllMocks();
});

describe('pairHost 按需证据', () => {
  it('加密入站到运行器的分块回执只发送请求连接，聊天快照仍正常广播', async () => {
    const first = hostMocks.sockets.get('pair-1')!;
    const second = hostMocks.sockets.get('pair-2')!;
    const result = {
      ok: true,
      text: '完整中文证据'.repeat(2000),
      nextOffset: 12_000,
      revision: 'a'.repeat(64),
    };
    hostMocks.readWork.mockResolvedValue(result);
    const command = { type: 'ensobot-work-read', requestId: 'read-1', request };
    await receive(first, command);
    await vi.waitFor(async () =>
      expect(await sentPayloads(first)).toContainEqual({
        type: 'ensobot-work-result',
        requestId: 'read-1',
        result,
      })
    );
    expect(hostMocks.readWork).toHaveBeenCalledWith(command);
    expect((await sentPayloads(second)).some((frame) => frame.type === 'ensobot-work-result')).toBe(
      false
    );
    publishEnsobotFrame({ type: 'ensobot-snapshot', snapshot: { seq: 2 } });
    for (const socket of [first, second])
      await vi.waitFor(async () =>
        expect(await sentPayloads(socket)).toContainEqual({
          type: 'ensobot-snapshot',
          snapshot: { seq: 2 },
        })
      );
  });

  it('坏查询走专用失败回执而不调用运行器，不向另一连接泄漏请求', async () => {
    const first = hostMocks.sockets.get('pair-1')!;
    const second = hostMocks.sockets.get('pair-2')!;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await receive(first, {
      type: 'ensobot-work-read',
      requestId: 'bad',
      request: { ...request, path: '/private' },
    });
    await vi.waitFor(async () =>
      expect(await sentPayloads(first)).toContainEqual({
        type: 'ensobot-work-result',
        requestId: 'bad',
        result: { ok: false, error: 'bad-params' },
      })
    );
    expect(hostMocks.readWork).not.toHaveBeenCalled();
    expect((await sentPayloads(second)).some((frame) => frame.type === 'ensobot-work-result')).toBe(
      false
    );
  });
});
