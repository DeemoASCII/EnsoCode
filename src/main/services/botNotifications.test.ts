import { beforeEach, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  focused: false,
  click: () => {},
  show: vi.fn(),
  focus: vi.fn(),
  send: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {
    static isSupported() {
      return true;
    }
    on(_event: string, cb: () => void) {
      env.click = cb;
    }
    show() {
      env.show();
    }
  },
}));
vi.mock('../ipc/settings', () => ({ readSettings: () => ({}) }));
vi.mock('../windows/MainWindow', () => ({
  getMainWindow: () => ({ isFocused: () => env.focused }),
  focusMainWindow: env.focus,
}));
vi.mock('../windows/createAppWindow', () => ({ sendToWindow: env.send }));

import { maybeNotifyBot } from './notifications';

const event = {
  type: 'ask-request' as const,
  identity: { sessionId: 's', generation: 'g' },
  seq: 1,
  ask: { requestId: 'q', question: 'Question?', options: [] },
};
beforeEach(() => {
  vi.clearAllMocks();
  env.focused = false;
});
it('notifies background bot questions and focuses the chat on click', async () => {
  await maybeNotifyBot(event, { enabled: true, chatId: 'chat', name: 'Alice' });
  expect(env.show).toHaveBeenCalledOnce();
  env.click();
  expect(env.focus).toHaveBeenCalledOnce();
  expect(env.send).toHaveBeenCalledWith(undefined, 'bots:event', { kind: 'chat', chatId: 'chat' });
});
it('does not notify foreground or disabled bot mode', async () => {
  await maybeNotifyBot(event, { enabled: false, chatId: 'chat', name: 'Alice' });
  env.focused = true;
  await maybeNotifyBot(event, { enabled: true, chatId: 'chat', name: 'Alice' });
  expect(env.show).not.toHaveBeenCalled();
});
