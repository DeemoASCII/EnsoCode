import { EventEmitter } from 'node:events';
import { IPC_CHANNELS } from '@shared/types';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  quit: vi.fn(),
  isQuittingForUpdate: vi.fn(() => false),
}));
const app = new EventEmitter();
const ipc = new EventEmitter();
vi.mock('electron', () => ({ app: Object.assign(app, { quit: mocks.quit }), ipcMain: ipc }));
vi.mock('./updater/AutoUpdater', () => ({
  autoUpdaterService: { isQuittingForUpdate: mocks.isQuittingForUpdate },
}));

beforeEach(() => {
  vi.resetModules();
  app.removeAllListeners();
  ipc.removeAllListeners();
  mocks.quit.mockClear();
  mocks.isQuittingForUpdate.mockReturnValue(false);
});

async function harness(scope: 'app' | 'workbench' = 'app') {
  const win = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const send = vi.fn();
  const onTray = vi.fn();
  const { attachAppCloseConfirm } = await import('./appCloseConfirm');
  attachAppCloseConfirm(win, send, () => contents as never, {
    interceptBeforeQuit: true,
    windowCloseScope: () => scope,
    onTray,
  });
  const close = (event = 'close') => {
    const prevented = vi.fn();
    (event === 'close' ? win : app).emit(event, { preventDefault: prevented });
    expect(prevented).toHaveBeenCalledOnce();
    return send.mock.lastCall?.[1];
  };
  const respond = async (id: unknown, action: string, sender = contents) => {
    ipc.emit(IPC_CHANNELS.APP_CLOSE_RESPONSE, { sender }, id, { action });
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { win, contents, send, onTray, close, respond };
}

it.each(['quit', 'tray'])(
  '同级 Bot 打开时，工作台选择 %s 只关闭工作台，不退出应用',
  async (action) => {
    const h = await harness('workbench');
    const id = h.close();
    expect(h.send).toHaveBeenCalledWith(IPC_CHANNELS.APP_CLOSE_REQUEST, id, 'workbench');
    await h.respond(id, action);
    expect(h.onTray).toHaveBeenCalledOnce();
    expect(mocks.quit).not.toHaveBeenCalled();
    // 关闭工作台不能污染 allowQuit，使之后重新打开的工作台绕过确认。
    const nextId = h.close();
    expect(nextId).not.toBe(id);
    await h.respond(nextId, 'cancel');
  }
);

it('没有同级 Bot 的 EnsoCode 保留原来退出整个应用的行为', async () => {
  const h = await harness();
  const id = h.close();
  await h.respond(id, 'quit');
  expect(mocks.quit).toHaveBeenCalledOnce();
  expect(h.onTray).not.toHaveBeenCalled();
});

it('明确 before-quit 不得被窗口级关闭语义改成收起工作台', async () => {
  const h = await harness('workbench');
  const id = h.close('before-quit');
  expect(h.send).toHaveBeenCalledWith(IPC_CHANNELS.APP_CLOSE_REQUEST, id, 'app');
  await h.respond(id, 'quit');
  expect(mocks.quit).toHaveBeenCalledOnce();
  expect(h.onTray).not.toHaveBeenCalled();
});

it('取消、错误发送方和旧确认不能关闭工作台或退出应用', async () => {
  const h = await harness('workbench');
  const id = h.close();
  await h.respond(id, 'quit', new EventEmitter() as typeof h.contents);
  await h.respond('stale', 'quit');
  expect(h.onTray).not.toHaveBeenCalled();
  expect(mocks.quit).not.toHaveBeenCalled();
  await h.respond(id, 'cancel');
  expect(h.onTray).not.toHaveBeenCalled();
  expect(ipc.listenerCount(IPC_CHANNELS.APP_CLOSE_RESPONSE)).toBe(0);
});
