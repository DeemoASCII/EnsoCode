import { readFileSync, writeFileSync } from 'node:fs';
import { IPC_CHANNELS } from '@shared/types';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { getCharacterCardStore, getEnsobotHost } from '../services/ensobotRuntime';

export function registerEnsobotHandlers(): void {
  const senderWindow = (event: Electron.IpcMainInvokeEvent): BrowserWindow | null => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win && !win.isDestroyed() ? win : null;
  };

  ipcMain.handle(IPC_CHANNELS.ENSOBOT_STATE_GET, () => getEnsobotHost().snapshot());

  ipcMain.handle(IPC_CHANNELS.ENSOBOT_CARDS_LIST, () => getCharacterCardStore().list());

  ipcMain.handle(IPC_CHANNELS.ENSOBOT_CARDS_IMPORT, async (event) => {
    const win = senderWindow(event);
    if (!win) return { ok: false, error: 'no-window' };
    const picked = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg'] }],
    });
    const file = picked.filePaths[0];
    if (picked.canceled || !file) return { ok: false, error: 'cancelled' };
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      return { ok: false, error: 'unreadable' };
    }
    const imported = getCharacterCardStore().importBytes(new Uint8Array(bytes));
    if (imported.ok) getEnsobotHost().touch();
    return imported;
  });

  ipcMain.handle(IPC_CHANNELS.ENSOBOT_CARDS_UPDATE, (_event, id: unknown, card: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: 'invalid-id' };
    const updated = getCharacterCardStore().update(id, card);
    if (updated.ok) getEnsobotHost().touch();
    return updated;
  });

  ipcMain.handle(IPC_CHANNELS.ENSOBOT_CARDS_EXPORT, async (event, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: 'invalid-id' };
    const win = senderWindow(event);
    if (!win) return { ok: false, error: 'no-window' };
    const read = getCharacterCardStore().readPng(id);
    if (!read.ok) return read;
    const picked = await dialog.showSaveDialog(win, {
      defaultPath: `${read.cardId}.png`,
      filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (picked.canceled || !picked.filePath) return { ok: false, error: 'cancelled' };
    try {
      writeFileSync(picked.filePath, read.png);
    } catch {
      return { ok: false, error: 'write-failed' };
    }
    return { ok: true, cardId: read.cardId };
  });

  ipcMain.handle(IPC_CHANNELS.ENSOBOT_CARDS_DELETE, (_event, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: 'invalid-id' };
    const removed = getCharacterCardStore().remove(id);
    if (removed.ok) getEnsobotHost().touch();
    return removed;
  });

  ipcMain.handle(IPC_CHANNELS.ENSOBOT_SEND, (_event, raw: unknown) => {
    const input = record(raw);
    if (!input || typeof input.cardId !== 'string' || typeof input.text !== 'string') {
      return { ok: false, error: 'bad-params' };
    }
    if (typeof input.deliveryId !== 'string') return { ok: false, error: 'bad-params' };
    return getEnsobotHost().submitUtterance({
      cardId: input.cardId,
      text: input.text,
      lane: 'human',
      deliveryId: input.deliveryId,
      retarget: input.retarget === true,
    });
  });

  ipcMain.handle(IPC_CHANNELS.ENSOBOT_BOARD, (_event, raw: unknown) => {
    const input = record(raw);
    if (!input || typeof input.text !== 'string' || typeof input.deliveryId !== 'string') {
      return { ok: false, error: 'bad-params' };
    }
    const mentions = Array.isArray(input.mentions)
      ? input.mentions.filter((id): id is string => typeof id === 'string')
      : [];
    return getEnsobotHost().postBoard({ text: input.text, mentions, deliveryId: input.deliveryId });
  });

  ipcMain.handle(IPC_CHANNELS.ENSOBOT_CLAIM, (_event, raw: unknown) => {
    const input = record(raw);
    if (!input || typeof input.taskId !== 'string' || typeof input.cardId !== 'string') {
      return { ok: false, error: 'bad-params' };
    }
    return getEnsobotHost().claim({ taskId: input.taskId, cardId: input.cardId });
  });

  ipcMain.handle(IPC_CHANNELS.ENSOBOT_ENQUEUE, (_event, raw: unknown) => {
    const input = record(raw);
    if (
      !input ||
      typeof input.cardId !== 'string' ||
      typeof input.title !== 'string' ||
      typeof input.check !== 'string'
    ) {
      return { ok: false, error: 'bad-params' };
    }
    return getEnsobotHost().enqueueTask({
      cardId: input.cardId,
      title: input.title,
      check: input.check,
    });
  });

  ipcMain.handle(IPC_CHANNELS.ENSOBOT_WORKSPACE, (_event, raw: unknown) => {
    const input = record(raw);
    if (!input) return { ok: false, error: 'bad-params' };
    const projectId =
      input.projectId === null || typeof input.projectId === 'string' ? input.projectId : null;
    const sessionId =
      input.sessionId === null || typeof input.sessionId === 'string' ? input.sessionId : null;
    if (
      input.projectId !== undefined &&
      input.projectId !== null &&
      typeof input.projectId !== 'string'
    ) {
      return { ok: false, error: 'bad-params' };
    }
    if (
      input.sessionId !== undefined &&
      input.sessionId !== null &&
      typeof input.sessionId !== 'string'
    ) {
      return { ok: false, error: 'bad-params' };
    }
    return getEnsobotHost().setWorkspace({ projectId, sessionId });
  });
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
