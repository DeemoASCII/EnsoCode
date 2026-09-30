import { PRODUCT } from '@shared/product';
import { app, type BrowserWindow } from 'electron';
import { attachAppCloseConfirm } from '../services/appCloseConfirm';
import { createAppWindow, getWindowWebContents, sendToWindow } from './createAppWindow';
import { getEnsobotWindow } from './EnsobotWindow';

let mainWindow: BrowserWindow | null = null;

export function createMainWindow(): BrowserWindow {
  mainWindow = createAppWindow({
    entry: 'index',
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    stateFile: 'window-state.json',
    pinWorkbenchView: true,
  });

  // Main 决定关窗的作用域，询问关闭工作台 / 退出应用或进托盘。before-quit 只在打包版拦：dev 下 Ctrl+C 会变成
  // app.quit()，拦了会卡在确认框上变孤儿。
  attachAppCloseConfirm(
    mainWindow,
    (channel, ...args) => {
      if (mainWindow && !mainWindow.isDestroyed()) sendToWindow(mainWindow, channel, ...args);
    },
    () => getWindowWebContents(mainWindow as BrowserWindow),
    {
      interceptBeforeQuit: app.isPackaged,
      // Bot 与工作台是同级窗口。关工作台不结束 Bot 的窗口或 worker；
      // 应用菜单 / 托盘的明确退出仍走 before-quit。
      windowCloseScope: () =>
        PRODUCT.slug === 'ensobot' || getEnsobotWindow() ? 'workbench' : 'app',
      onTray: () => import('../services/appServerMode').then((mod) => mod.enterServerMode()),
    }
  );

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function isMainWindowAlive(): boolean {
  return Boolean(mainWindow && !mainWindow.isDestroyed());
}

export function isMainWebContents(webContentsId: number): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const contents = getWindowWebContents(mainWindow);
  return !contents.isDestroyed() && contents.id === webContentsId;
}

export function focusMainWindow(): BrowserWindow {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createMainWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return window;
}
