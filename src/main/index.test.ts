import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  isPackaged: false,
  appHandlers: new Map<string, (...args: unknown[]) => void>(),
  setPath: vi.fn(),
  setName: vi.fn(),
  openEnsobot: vi.fn(() => mocks.order.push('ensobot')),
  autoUpdaterInit: vi.fn(),
  startAgentWorker: vi.fn(() => mocks.order.push('worker')),
  createMainWindow: vi.fn(() => {
    mocks.order.push('window');
    return {};
  }),
  consumeTrayReenter: vi.fn(() => false),
  scheduleReenter: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mocks.isPackaged;
    },
    commandLine: { appendSwitch: vi.fn() },
    dock: { setIcon: vi.fn() },
    getAppPath: () => '/app',
    getPath: (name: string) => (name === 'appData' ? '/system-app-data' : '/tmp'),
    setPath: mocks.setPath,
    setName: mocks.setName,
    requestSingleInstanceLock: () => true,
    quit: vi.fn(),
    whenReady: () => Promise.resolve(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      mocks.appHandlers.set(event, handler);
    }),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('@electron-toolkit/utils', () => ({
  electronApp: { setAppUserModelId: vi.fn() },
  optimizer: { watchWindowShortcuts: vi.fn() },
}));
vi.mock('./ipc', () => ({
  registerIpcHandlers: vi.fn(() => mocks.order.push('ipc')),
}));
vi.mock('./ipc/settings', () => ({
  readSettings: vi.fn(() => null),
  consumeTrayReenterAfterUpdate: () => mocks.consumeTrayReenter(),
}));
vi.mock('./services/localImageProtocol', () => ({
  registerLocalImageProtocolHandler: vi.fn(),
  registerLocalImageSchemePrivileges: vi.fn(),
}));
vi.mock('./services/ensobotCardProtocol', () => ({
  registerEnsobotCardProtocol: vi.fn(),
}));
vi.mock('./services/appMenu', () => ({ installAppMenu: vi.fn() }));
vi.mock('./services/pairHost', () => ({
  startPairHost: vi.fn(() => mocks.order.push('pair')),
  stopPairHost: vi.fn(),
  refreshPowerKeepAlive: vi.fn(),
}));
vi.mock('./services/pairGuest', () => ({
  startPairGuest: vi.fn(),
  stopPairGuest: vi.fn(),
}));
vi.mock('./services/agentHost', () => ({
  startAgentWorker: mocks.startAgentWorker,
  agentWorkerAlive: () => false,
  stopAgentWorkerForQuit: vi.fn(async () => undefined),
}));
vi.mock('./services/proxyConfig', () => ({
  getProxyConfig: () => ({
    initFromConfig: vi.fn(),
    whenReady: () => Promise.resolve(true),
  }),
}));
vi.mock('./services/shellPath', () => ({
  seedProcessPath: vi.fn(),
  hydrateShellPath: vi.fn(async () => undefined),
}));
vi.mock('./services/updater/AutoUpdater', () => ({
  autoUpdaterService: { init: mocks.autoUpdaterInit },
}));
vi.mock('./windows/MainWindow', () => ({
  createMainWindow: mocks.createMainWindow,
  getMainWindow: vi.fn(() => null),
}));
vi.mock('./windows/EnsobotWindow', () => ({ openEnsobotWindow: mocks.openEnsobot }));
vi.mock('./services/appServerMode', () => ({
  ensureTray: vi.fn(() => mocks.order.push('tray')),
  leaveServerMode: vi.fn(),
  enterServerMode: vi.fn(),
  isServerMode: () => false,
  restoreFromSecondInstance: vi.fn(),
  shouldQuitOnWindowAllClosed: () => false,
  scheduleReenterServerMode: (...args: unknown[]) => mocks.scheduleReenter(...args),
}));
vi.mock('./services/trayToggleShortcut', () => ({
  setTrayToggleHandler: vi.fn(),
  syncTrayToggleShortcut: vi.fn(),
  stopTrayToggleShortcut: vi.fn(),
}));

const originalUserDataOverride = process.env.ENSO_USER_DATA_DIR;

beforeEach(async () => {
  // 前一用例的 deferred startup 必须先收口，避免串入下一用例的 worker 计数。
  await new Promise<void>((resolve) => setImmediate(resolve));
  vi.unstubAllGlobals();
  vi.resetModules();
  mocks.order.length = 0;
  mocks.appHandlers.clear();
  mocks.isPackaged = false;
  mocks.setPath.mockClear();
  mocks.setName.mockClear();
  mocks.openEnsobot.mockClear();
  mocks.startAgentWorker.mockClear();
  mocks.createMainWindow.mockClear();
  mocks.autoUpdaterInit.mockClear();
  mocks.consumeTrayReenter.mockReset();
  mocks.consumeTrayReenter.mockReturnValue(false);
  mocks.scheduleReenter.mockClear();
  delete process.env.ENSO_USER_DATA_DIR;
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (originalUserDataOverride === undefined) delete process.env.ENSO_USER_DATA_DIR;
  else process.env.ENSO_USER_DATA_DIR = originalUserDataOverride;
});

describe('Main startup order', () => {
  it('creates the renderer window before asynchronously starting the worker, exactly once', async () => {
    await import('./index');
    await Promise.resolve();

    expect(mocks.order).toEqual(['ipc', 'window', 'tray']);
    expect(mocks.startAgentWorker).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => setImmediate(resolve));
    // pair 不依赖代理；worker 等 whenReady 后再 fork，所以排在 pair 之后。
    await Promise.resolve();
    expect(mocks.order).toEqual(['ipc', 'window', 'tray', 'pair', 'worker']);
    expect(mocks.createMainWindow).toHaveBeenCalledOnce();
    expect(mocks.startAgentWorker).toHaveBeenCalledOnce();
    expect(mocks.scheduleReenter).not.toHaveBeenCalled();
  });

  it('schedules tray re-entry after an update restart', async () => {
    mocks.consumeTrayReenter.mockReturnValue(true);
    await import('./index');
    await Promise.resolve();
    expect(mocks.createMainWindow).toHaveBeenCalledOnce();
    expect(mocks.scheduleReenter).toHaveBeenCalledOnce();
  });
});

describe('Main process diagnostics', () => {
  it('listens for child-process-gone', async () => {
    await import('./index');
    expect(mocks.appHandlers.has('child-process-gone')).toBe(true);
  });
});

describe('Main userData isolation', () => {
  it('EnsoBot 打包身份固定为独立数据目录，并保留工作台且打开 Bot 窗口', async () => {
    vi.stubGlobal('__ENSO_PRODUCT__', 'ensobot');
    mocks.isPackaged = true;
    process.env.ENSO_USER_DATA_DIR = '/tmp/must-not-be-used';
    await import('./index');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mocks.setPath).toHaveBeenCalledWith(
      'userData',
      path.join('/system-app-data', 'ensobot')
    );
    expect(mocks.setName).toHaveBeenCalledWith('EnsoBot');
    expect(mocks.createMainWindow).toHaveBeenCalledOnce();
    expect(mocks.openEnsobot).toHaveBeenCalledOnce();
    // Linux 打包分支还会异步探测登录 shell，不能把一次 setImmediate 当成 ready。
    await vi.waitFor(() => expect(mocks.startAgentWorker).toHaveBeenCalledOnce());
    expect(mocks.order.indexOf('window')).toBeLessThan(mocks.order.indexOf('worker'));
  });
  it('uses ENSO_USER_DATA_DIR only in development when it is non-empty', async () => {
    process.env.ENSO_USER_DATA_DIR = '  ./temp/isolated-user-data  ';
    await import('./index');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mocks.setPath).toHaveBeenCalledWith(
      'userData',
      path.resolve('./temp/isolated-user-data')
    );
  });

  it('defaults development userData to the isolated enso-code-dev profile', async () => {
    await import('./index');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mocks.setPath).toHaveBeenCalledWith(
      'userData',
      path.join('/system-app-data', 'enso-code-dev')
    );
  });

  it('ignores ENSO_USER_DATA_DIR in packaged builds', async () => {
    mocks.isPackaged = true;
    process.env.ENSO_USER_DATA_DIR = '/tmp/must-not-be-used';
    await import('./index');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mocks.setPath).toHaveBeenCalledWith(
      'userData',
      path.join('/system-app-data', 'enso-code')
    );
    expect(mocks.setPath).not.toHaveBeenCalledWith('userData', '/tmp/must-not-be-used');
  });
});
