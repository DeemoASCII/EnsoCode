import { IPC_CHANNELS } from '@shared/types';
import { BrowserWindow, ipcMain } from 'electron';
import {
  getNodesStatus,
  pairNode,
  removeNode,
  renameNode,
  sendToNode,
  setNodesMessageListener,
  setNodesStatusListener,
} from '../services/pairGuest';
import { parseGuestOutbound } from '../services/pairGuestPolicy';
import { getWindowWebContents, sendToAllWindows, sendToWindow } from '../windows/createAppWindow';
import { isEnsobotWebContents } from '../windows/EnsobotWindow';
import { isMainWebContents } from '../windows/MainWindow';

/**
 * 「连接到节点」：本机作为 guest 连别的 EnsoCode 桌面。
 * 主窗口 UI 跑在独立的顶层 WebContentsView 里，`win.webContents` 是没有 preload 监听的空壳；
 * 推送一律走 sendToWindow / getWindowWebContents，否则渲染层收不到状态与下行帧。
 * 会话帧和 NODES_SEND 只放行主窗口与 EnsoBot 的 UI webContents，设置窗排除。
 */
export function registerNodesHandlers(): void {
  setNodesStatusListener((status) => {
    sendToAllWindows(IPC_CHANNELS.NODES_STATUS_CHANGED, status);
  });
  // 下行帧给主窗口和 EnsoBot 的 UI webContents。设置窗不渲染会话，继续排除。
  setNodesMessageListener((message) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      const contentsId = getWindowWebContents(win).id;
      if (!isMainWebContents(contentsId) && !isEnsobotWebContents(contentsId)) continue;
      sendToWindow(win, IPC_CHANNELS.NODES_MESSAGE, message);
    }
  });

  ipcMain.handle(IPC_CHANNELS.NODES_LIST, () => getNodesStatus());
  ipcMain.handle(IPC_CHANNELS.NODES_PAIR, async (_event, uri: unknown) => {
    if (typeof uri !== 'string' || !uri.trim()) return { ok: false, error: 'invalid-uri' };
    return pairNode(uri.trim());
  });
  ipcMain.handle(IPC_CHANNELS.NODES_REMOVE, async (_event, nodeId: unknown) => {
    if (typeof nodeId !== 'string' || !nodeId) return { ok: false, error: 'invalid nodeId' };
    return removeNode(nodeId);
  });
  ipcMain.handle(IPC_CHANNELS.NODES_RENAME, (_event, nodeId: unknown, label: unknown) => {
    if (typeof nodeId !== 'string' || !nodeId || typeof label !== 'string') {
      return { ok: false, error: 'invalid arguments' };
    }
    return renameNode(nodeId, label);
  });
  ipcMain.handle(IPC_CHANNELS.NODES_SEND, (event, nodeId: unknown, command: unknown) => {
    if (!isMainWebContents(event.sender.id) && !isEnsobotWebContents(event.sender.id)) {
      return { ok: false, error: 'Only the main window and EnsoBot can talk to nodes.' };
    }
    if (typeof nodeId !== 'string' || !nodeId) return { ok: false, error: 'invalid nodeId' };
    const parsed = parseGuestOutbound(command);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return sendToNode(nodeId, parsed.command);
  });
}
