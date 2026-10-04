import { writeFileSync } from 'node:fs';

/**
 * 直接连单个页面的 CDP 会话，用 Input.* 发“受信任”的鼠标和键盘事件（isTrusted=true，
 * 走真实的焦点、IME 和表单管线），用 Runtime.evaluate 读界面。
 *
 * 不用 Playwright 的整浏览器连接：工作台是 BrowserWindow + WebContentsView，窗口自己的
 * webContents 永远不加载页面，整浏览器自动附着会一直等它初始化而卡死。
 */

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export async function listTargets(port: number): Promise<CdpTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`CDP /json/list ${response.status}`);
  return (await response.json()) as CdpTarget[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class CdpPage {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (message.id === undefined) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error('CDP socket closed'));
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpPage> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`CDP connect failed: ${url}`)), {
        once: true,
      });
    });
    const page = new CdpPage(socket);
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    return page;
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP socket is not open (${method})`));
    }
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
  }

  /** 在页面里执行一段表达式（可 await），按值返回。 */
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<{
      result: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      );
    }
    return result.result.value as T;
  }

  /** 反复求值直到为真，像人一样“看到了再动手”。 */
  async waitFor(expression: string, label: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate<boolean>(`Boolean(${expression})`)) return;
      } catch (error) {
        last = error;
      }
      await sleep(200);
    }
    throw new Error(`等待超时：${label}${last ? `（${String(last)}）` : ''}`);
  }

  /**
   * 找到元素、滚进视野，等它停稳（弹层有入场动画和异步定位），确认那个点上确实是它，
   * 再在中心按下、抬起鼠标——和人“看准了再点”一样。
   */
  async click(elementExpression: string, label: string): Promise<void> {
    await this.waitFor(elementExpression, label);
    const probe = `(() => {
      const el = ${elementExpression};
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        x, y, w: rect.width, h: rect.height,
        onTop: !!hit && (hit === el || el.contains(hit)),
        visible: document.visibilityState,
      };
    })()`;
    type Box = { x: number; y: number; w: number; h: number; onTop: boolean; visible: string };
    const deadline = Date.now() + 5_000;
    let box: Box | null = null;
    let previous: Box | null = null;
    while (Date.now() < deadline) {
      box = await this.evaluate<Box | null>(probe);
      const settled =
        box &&
        previous &&
        box.w > 0 &&
        box.h > 0 &&
        box.onTop &&
        Math.abs(box.x - previous.x) < 0.5 &&
        Math.abs(box.y - previous.y) < 0.5 &&
        Math.abs(box.w - previous.w) < 0.5;
      if (settled) break;
      previous = box;
      await sleep(80);
    }
    if (!box) throw new Error(`找不到可点击的元素：${label}`);
    if (!box.onTop) throw new Error(`元素被别的东西挡住了：${label}`);
    if (box.visible !== 'visible') throw new Error(`窗口不可见，鼠标事件会被丢弃：${label}`);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
  }

  /** 逐字输入到当前焦点（走输入法同一条 insertText 管线）。 */
  async type(text: string): Promise<void> {
    for (const char of text) {
      await this.send('Input.insertText', { text: char });
      await sleep(12);
    }
  }

  async pressEnter(): Promise<void> {
    const key = {
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...key });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  }

  async screenshot(file: string): Promise<void> {
    const shot = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
  }

  close(): void {
    this.socket.close();
  }
}

/** 页面内的查找片段：按选择器找第一个包含指定文字的元素。 */
export function byText(selector: string, text: string): string {
  return `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => (el.innerText || el.textContent || '').includes(${JSON.stringify(text)}))`;
}

export function bySelector(selector: string): string {
  return `document.querySelector(${JSON.stringify(selector)})`;
}
