import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { SpeechEngine } from './engine';

/** 子进程常驻约 900MB，空闲即退，下次冷启动约 1s */
const IDLE_MS = 3 * 60_000;
const TIMEOUT_MS = 30_000;

export interface HanbaoEngineOptions {
  /** 拉起 `hanbao --pipe <model>` */
  start: () => ChildProcessByStdio<Writable, Readable, Readable | null>;
  idleMs?: number;
  timeoutMs?: number;
}

interface Reply {
  ok?: unknown;
  id?: unknown;
  text?: unknown;
  error?: unknown;
}

interface Child {
  ask(message: Record<string, unknown>): Promise<Reply>;
  stop(): void;
  kill(): void;
}

class ExitError extends Error {}

export function toPcm16(samples: Float32Array): Buffer {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), i * 2);
  }
  return pcm;
}

/**
 * stdin/stdout JSON-lines；hanbao 一次只处理一个请求，这里排队串行。
 * 整段识别崩溃后重启并重放一次；流式会话状态在子进程里，崩溃即失败。
 */
export function createHanbaoEngine({
  start,
  idleMs = IDLE_MS,
  timeoutMs = TIMEOUT_MS,
}: HanbaoEngineOptions): SpeechEngine {
  let current: Child | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let inflight = 0;
  let nextId = 0;
  let idle: NodeJS.Timeout | undefined;
  let disposed = false;

  const launch = (): Child => {
    const proc = start();
    let pending: { id: number; resolve: (r: Reply) => void; reject: (e: Error) => void } | null =
      null;
    let exited = false;
    let buffer = '';
    const detach = () => {
      if (current === child) current = null;
    };
    const gone = (reason: string) => {
      exited = true;
      detach();
      pending?.reject(new ExitError(`hanbao exited: ${reason}`));
      pending = null;
    };
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        let reply: Reply;
        try {
          reply = JSON.parse(line);
        } catch {
          continue;
        }
        // 引擎错误不带 id；串行协议下任何无 id 的应答都属于当前请求
        if (pending && (reply.id === pending.id || reply.id === undefined)) {
          pending.resolve(reply);
          pending = null;
        }
      }
    });
    proc.stdin.on('error', () => {});
    proc.on('error', (error) => gone(error.message));
    proc.on('exit', (code, signal) => gone(String(signal ?? code)));
    const child: Child = {
      ask: (message) =>
        new Promise((resolve, reject) => {
          if (exited) return reject(new ExitError('hanbao exited'));
          const id = ++nextId;
          pending = { id, resolve, reject };
          proc.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
        }),
      stop: () => {
        detach();
        proc.stdin.end(`${JSON.stringify({ op: 'shutdown' })}\n`);
        setTimeout(() => proc.kill('SIGKILL'), 5000).unref();
      },
      kill: () => {
        detach();
        proc.kill('SIGKILL');
      },
    };
    return child;
  };

  const alive = (): Child => {
    current ??= launch();
    return current;
  };

  const once = async (message: Record<string, unknown>, child = alive()) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        child.ask(message),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            child.kill();
            reject(new Error('hanbao timed out'));
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const text = (reply: Reply): string => {
    if (reply.ok !== true || typeof reply.text !== 'string') {
      throw new Error(`hanbao failed: ${String(reply.error ?? 'bad reply')}`);
    }
    return reply.text;
  };

  const run = async (samples: Float32Array): Promise<string> => {
    const message = { op: 'asr', b64: toPcm16(samples).toString('base64') };
    try {
      return text(await once(message));
    } catch (error) {
      if (!(error instanceof ExitError) || disposed) throw error;
      return text(await once(message));
    }
  };

  /** 占用期间不计空闲；流式会话从打开到结束一直占用 */
  const hold = () => {
    if (disposed) throw new Error('hanbao engine disposed');
    clearTimeout(idle);
    inflight++;
  };
  const release = () => {
    if (--inflight > 0 || !current || disposed) return;
    idle = setTimeout(() => current?.stop(), idleMs);
    idle.unref?.();
  };
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const task = queue.then(() => {
      if (disposed) throw new Error('hanbao engine disposed');
      return job();
    });
    queue = task.catch(() => {});
    return task;
  };

  return {
    transcribe: async (samples) => {
      hold();
      try {
        return await enqueue(() => run(samples));
      } finally {
        release();
      }
    },
    openStream: () => {
      hold();
      let owner: Child | null = null;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        release();
      };
      const opened = enqueue(async () => {
        const child = alive();
        text(await once({ op: 'begin' }, child));
        owner = child;
      });
      opened.catch(close);
      /**
       * 会话所在子进程已不在（崩溃 / 超时被杀）就不再发，免得拉起新进程报 no session；
       * 任何失败都视为会话结束并释放占用，调用方失败后不一定再调 cancel
       */
      const send = (message: Record<string, unknown>) =>
        enqueue(async () => {
          if (!owner || current !== owner) throw new Error('hanbao stream lost');
          return text(await once(message, owner));
        }).catch((error) => {
          close();
          throw error;
        });
      return {
        accept: (samples) => send({ op: 'chunk', b64: toPcm16(samples).toString('base64') }),
        finish: () => send({ op: 'end' }).finally(close),
        cancel: () => {
          if (closed) return;
          void send({ op: 'cancel' })
            .catch(() => {})
            .finally(close);
        },
      };
    },
    dispose: () => {
      disposed = true;
      clearTimeout(idle);
      current?.stop();
    },
  };
}
