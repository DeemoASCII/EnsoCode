import type { BrowserWindow } from 'electron';
import { createAppWindow, getWindowWebContents } from './createAppWindow';

let ensobotWindow: BrowserWindow | null = null;

/** EnsoBot 窗口单例：已打开则恢复并聚焦，否则创建与主窗口同级的普通窗口。 */
export function openEnsobotWindow(): BrowserWindow {
  if (ensobotWindow && !ensobotWindow.isDestroyed()) {
    if (ensobotWindow.isMinimized()) ensobotWindow.restore();
    ensobotWindow.focus();
    return ensobotWindow;
  }

  ensobotWindow = createAppWindow({
    entry: 'ensobot',
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 560,
    stateFile: 'ensobot-window-state.json',
  });

  ensobotWindow.on('closed', () => {
    ensobotWindow = null;
  });

  return ensobotWindow;
}

export function getEnsobotWindow(): BrowserWindow | null {
  return ensobotWindow && !ensobotWindow.isDestroyed() ? ensobotWindow : null;
}

/** 比较的是这扇窗的 UI webContents。普通窗没有钉住的外壳，结果就是窗口自己的 webContents。 */
export function isEnsobotWebContents(webContentsId: number): boolean {
  if (!ensobotWindow || ensobotWindow.isDestroyed()) return false;
  const contents = getWindowWebContents(ensobotWindow);
  return !contents.isDestroyed() && contents.id === webContentsId;
}
