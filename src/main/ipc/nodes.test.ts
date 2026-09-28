import { IPC_CHANNELS } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 主窗口 UI 跑在独立的顶层 WebContentsView 里（createPinnedWorkbench），
 * `win.webContents` 只是 BrowserWindow 自带的空壳，没有 preload 监听。
 * 节点状态/下行帧必须发到 getWindowWebContents(win)，否则渲染层永远收不到，
 * 节点点一直灰、会话一直转圈（b968fdf 漏改了 nodes.ts）。
 */

const mocks = vi.hoisted(() => {
  const shellContents = { id: 1, isDestroyed: () => false, send: vi.fn() };
  const uiContents = { id: 2, isDestroyed: () => false, send: vi.fn() };
  const settingsContents = { id: 3, isDestroyed: () => false, send: vi.fn() };
  const ensobotContents = { id: 4, isDestroyed: () => false, send: vi.fn() };
  const mainWindow = { isDestroyed: () => false, webContents: shellContents, ui: uiContents };
  const settingsWindow = {
    isDestroyed: () => false,
    webContents: settingsContents,
    ui: settingsContents,
  };
  const ensobotWindow = {
    isDestroyed: () => false,
    webContents: ensobotContents,
    ui: ensobotContents,
  };
  return {
    shellContents,
    uiContents,
    settingsContents,
    ensobotContents,
    mainWindow,
    settingsWindow,
    ensobotWindow,
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    sendToNode: vi.fn(() => ({ ok: true })),
    statusListener: null as ((status: unknown) => void) | null,
    messageListener: null as ((message: unknown) => void) | null,
  };
});

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [mocks.mainWindow, mocks.settingsWindow, mocks.ensobotWindow]),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
}));

vi.mock('../windows/createAppWindow', () => ({
  getWindowWebContents: vi.fn((win: { ui: { send: ReturnType<typeof vi.fn> } }) => win.ui),
  sendToWindow: vi.fn(
    (win: { ui: { send: (...args: unknown[]) => void } }, channel: string, ...args: unknown[]) => {
      win.ui.send(channel, ...args);
    }
  ),
  sendToAllWindows: vi.fn((channel: string, ...args: unknown[]) => {
    mocks.uiContents.send(channel, ...args);
  }),
}));

vi.mock('../windows/MainWindow', () => ({
  // 与真实实现同口径：比较的是 UI webContents 的 id，不是 win.webContents.id
  isMainWebContents: vi.fn((id: number) => id === mocks.uiContents.id),
}));

vi.mock('../windows/EnsobotWindow', () => ({
  isEnsobotWebContents: vi.fn((id: number) => id === mocks.ensobotContents.id),
}));

vi.mock('../services/pairGuest', () => ({
  getNodesStatus: vi.fn(),
  pairNode: vi.fn(),
  removeNode: vi.fn(),
  renameNode: vi.fn(),
  sendToNode: mocks.sendToNode,
  setNodesStatusListener: vi.fn((listener: (status: unknown) => void) => {
    mocks.statusListener = listener;
  }),
  setNodesMessageListener: vi.fn((listener: (message: unknown) => void) => {
    mocks.messageListener = listener;
  }),
}));

vi.mock('../services/pairGuestPolicy', () => ({
  parseGuestOutbound: vi.fn((command: unknown) =>
    command && typeof command === 'object'
      ? { ok: true as const, command }
      : { ok: false as const, error: 'bad' }
  ),
}));

describe('registerNodesHandlers → renderer 推送目标', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.statusListener = null;
    mocks.messageListener = null;
    const { registerNodesHandlers } = await import('./nodes');
    registerNodesHandlers();
  });

  it('NODES_STATUS_CHANGED 发到 UI webContents，而不是 BrowserWindow 的空壳', () => {
    const status = { nodes: [], secureStorage: true };
    mocks.statusListener?.(status);
    expect(mocks.uiContents.send).toHaveBeenCalledWith(IPC_CHANNELS.NODES_STATUS_CHANGED, status);
    expect(mocks.shellContents.send).not.toHaveBeenCalled();
  });

  it('NODES_MESSAGE 发到主窗口和 EnsoBot 的 UI webContents，外壳和设置窗收不到', () => {
    const message = { nodeId: 'n1', payload: { type: 'catalog', entries: [] } };
    mocks.messageListener?.(message);
    expect(mocks.uiContents.send).toHaveBeenCalledWith(IPC_CHANNELS.NODES_MESSAGE, message);
    expect(mocks.ensobotContents.send).toHaveBeenCalledWith(IPC_CHANNELS.NODES_MESSAGE, message);
    expect(mocks.shellContents.send).not.toHaveBeenCalled();
    expect(mocks.settingsContents.send).not.toHaveBeenCalled();
  });

  it('NODES_SEND 放行主窗口和 EnsoBot 的 UI，拒绝设置窗和主窗口外壳', () => {
    const send = mocks.handlers.get(IPC_CHANNELS.NODES_SEND);
    expect(send).toBeTypeOf('function');
    const command = { type: 'snapshot' };
    expect(send?.({ sender: { id: mocks.uiContents.id } }, 'n1', command)).toEqual({ ok: true });
    expect(send?.({ sender: { id: mocks.ensobotContents.id } }, 'n1', command)).toEqual({
      ok: true,
    });
    expect(mocks.sendToNode).toHaveBeenCalledTimes(2);

    expect(send?.({ sender: { id: mocks.settingsContents.id } }, 'n1', command)).toMatchObject({
      ok: false,
    });
    expect(send?.({ sender: { id: mocks.shellContents.id } }, 'n1', command)).toMatchObject({
      ok: false,
    });
    expect(mocks.sendToNode).toHaveBeenCalledTimes(2);
  });
});
