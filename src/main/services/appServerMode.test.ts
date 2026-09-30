import { EventEmitter } from 'node:events';
import { IPC_CHANNELS } from '@shared/types';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  main: { isDestroyed: () => false, destroy: vi.fn() },
  bot: { isDestroyed: () => false, close: vi.fn() },
  settings: { isDestroyed: () => false, close: vi.fn() },
  botOpen: true,
  dockHide: vi.fn(),
  dockShow: vi.fn(),
  quit: vi.fn(),
  headless: vi.fn(),
  flushSettings: vi.fn(),
  closeContents: vi.fn(),
  allowQuit: vi.fn(),
  bypassNextCloseConfirm: vi.fn(),
  hibernate: vi.fn(async () => {}),
}));
const ipc = new EventEmitter();
const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
Object.defineProperty(process, 'resourcesPath', { value: '/resources', configurable: true });
afterAll(() => {
  if (originalResourcesPath) Object.defineProperty(process, 'resourcesPath', originalResourcesPath);
  else Reflect.deleteProperty(process, 'resourcesPath');
});
vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/app',
    dock: { hide: mocks.dockHide, show: mocks.dockShow },
    quit: mocks.quit,
  },
  ipcMain: ipc,
  Menu: { buildFromTemplate: vi.fn() },
  nativeImage: {
    createEmpty: () => ({ isEmpty: () => false, getSize: () => ({ width: 16 }) }),
    createFromPath: () => ({ isEmpty: () => false, getSize: () => ({ width: 16 }) }),
  },
  Tray: class {
    on() {}
    setContextMenu() {}
    setToolTip() {}
    isDestroyed() {
      return false;
    }
    destroy() {}
  },
}));
vi.mock('../ipc/settings', () => ({
  flushSettings: mocks.flushSettings,
  readSettings: () => ({}),
  readTrayPreventDisplaySleep: () => false,
  readTraySleepPolicy: () => 'when-agent-running',
  writeTrayPreventDisplaySleep: vi.fn(),
  writeTraySleepPolicy: vi.fn(),
}));
vi.mock('../windows/createAppWindow', () => ({
  closeWindowWebContents: mocks.closeContents,
  getWindowWebContents: () => ({ isDestroyed: () => false }),
  sendToWindow: (_win: unknown, channel: string, id: string) => {
    if (channel === IPC_CHANNELS.APP_FLUSH_PERSIST_REQUEST)
      ipc.emit(IPC_CHANNELS.APP_FLUSH_PERSIST_RESPONSE, {}, id);
  },
}));
vi.mock('../windows/MainWindow', () => ({
  getMainWindow: () => mocks.main,
  isMainWindowAlive: () => true,
  createMainWindow: vi.fn(),
}));
vi.mock('../windows/EnsobotWindow', () => ({
  getEnsobotWindow: () => (mocks.botOpen ? mocks.bot : null),
  openEnsobotWindow: vi.fn(),
}));
vi.mock('../windows/SettingsWindow', () => ({ getSettingsWindow: () => mocks.settings }));
vi.mock('./appCloseConfirm', () => ({
  allowAppQuit: mocks.allowQuit,
  bypassNextCloseConfirm: mocks.bypassNextCloseConfirm,
}));
vi.mock('./browserHost', () => ({ browserHost: { hibernateAll: mocks.hibernate } }));
vi.mock('./pairHost', () => ({ refreshPowerKeepAlive: vi.fn() }));
vi.mock('./pairSessionHost', () => ({ setPairHeadless: mocks.headless }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  ipc.removeAllListeners();
  mocks.botOpen = true;
});

it('进入托盘只卸载工作台，同级 Bot 和其设置窗口仍可使用，不停止应用', async () => {
  const service = await import('./appServerMode');
  await service.enterServerMode();
  expect(service.isServerMode()).toBe(true);
  expect(mocks.headless).toHaveBeenCalledWith(true);
  expect(mocks.main.destroy).toHaveBeenCalledOnce();
  expect(mocks.closeContents).toHaveBeenCalledWith(mocks.main);
  expect(mocks.hibernate).toHaveBeenCalledOnce();
  expect(mocks.bot.close).not.toHaveBeenCalled();
  expect(mocks.settings.close).not.toHaveBeenCalled();
  expect(mocks.dockHide).not.toHaveBeenCalled();
  expect(mocks.quit).not.toHaveBeenCalled();
  expect(mocks.bypassNextCloseConfirm).not.toHaveBeenCalled();
});

it('没有 Bot 时仍进入原来的无头模式，关闭设置窗并隐藏 Dock', async () => {
  mocks.botOpen = false;
  const service = await import('./appServerMode');
  await service.enterServerMode();
  expect(mocks.settings.close).toHaveBeenCalledOnce();
  expect(mocks.dockHide).toHaveBeenCalledOnce();
  expect(mocks.quit).not.toHaveBeenCalled();
});

it('托盘的明确退出仍结束整个应用，不因 Bot 窗口打开而改成关工作台', async () => {
  const service = await import('./appServerMode');
  service.quitFromTray();
  expect(mocks.allowQuit).toHaveBeenCalledOnce();
  expect(mocks.quit).toHaveBeenCalledOnce();
  expect(mocks.main.destroy).not.toHaveBeenCalled();
});
