import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  setFeedURL: vi.fn(),
  check: vi.fn(),
  send: vi.fn(),
  updater: { allowDowngrade: true },
}));
vi.mock('electron', () => ({
  app: {},
  BrowserWindow: { getAllWindows: () => [{}] },
  net: { fetch: mocks.fetch },
}));
vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: { ...mocks.updater, setFeedURL: mocks.setFeedURL, checkForUpdates: mocks.check },
  },
}));
vi.mock('../../ipc/settings', () => ({
  flushSettings: vi.fn(),
  writeTrayReenterAfterUpdate: vi.fn(),
}));
vi.mock('../../windows/createAppWindow', () => ({ sendToWindow: mocks.send }));
vi.mock('./idleRestartSnapshot', () => ({ currentIdleRestartObservation: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal('__ENSO_PRODUCT__', 'ensobot');
});
afterEach(() => vi.unstubAllGlobals());

it('EnsoBot 检查先隔离到正确 tag 的 generic 源，再调用更新器，不能选择 EnsoCode', async () => {
  mocks.fetch.mockResolvedValue(
    Response.json([
      { tag_name: 'v99.0.0', draft: false },
      { tag_name: 'ensobot-v0.0.2', draft: false, prerelease: true },
    ])
  );
  const { autoUpdaterService } = await import('./AutoUpdater');
  await autoUpdaterService.checkForUpdates();
  expect(mocks.setFeedURL).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: 'ensobot',
      url: 'https://github.com/J3n5en/EnsoCode/releases/download/ensobot-v0.0.2/',
    })
  );
  expect(mocks.check).toHaveBeenCalledOnce();
  expect(mocks.setFeedURL.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.check.mock.invocationCallOrder[0]
  );
});

it('EnsoBot API 失败时显示错误且不调用默认更新源', async () => {
  mocks.fetch.mockResolvedValue(new Response('', { status: 403 }));
  const { autoUpdaterService } = await import('./AutoUpdater');
  await autoUpdaterService.checkForUpdates();
  expect(mocks.check).not.toHaveBeenCalled();
  expect(mocks.setFeedURL).not.toHaveBeenCalled();
  expect(mocks.send).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ status: 'error' })
  );
});

it('EnsoCode 构建保留既有更新源，不读取 EnsoBot 列表', async () => {
  vi.stubGlobal('__ENSO_PRODUCT__', 'ensocode');
  const { autoUpdaterService } = await import('./AutoUpdater');
  await autoUpdaterService.checkForUpdates();
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.setFeedURL).not.toHaveBeenCalled();
  expect(mocks.check).toHaveBeenCalledOnce();
});
