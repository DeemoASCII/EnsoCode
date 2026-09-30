import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SpeechEngine } from './engine';
import { createHanbaoEngine, toPcm16 } from './hanbao';

/** 按 --pipe 协议应答的假子进程：回 PCM 字节数（流式回累计字节数）；MODE 控制崩溃 / 卡死 / 报错 */
const FAKE = `
const fs = require('node:fs');
const mode = process.env.MODE;
let buf = '';
let live = null;
const reply = (msg, extra) => process.stdout.write(JSON.stringify({ id: msg.id, ...extra }) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  for (let i = buf.indexOf('\\n'); i >= 0; i = buf.indexOf('\\n')) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.op === 'shutdown') { process.stdout.write('{"ok":true}\\n'); process.exit(0); }
    if (msg.op === 'begin') { live = 0; reply(msg, { ok: true, text: '' }); continue; }
    if (msg.op === 'chunk' || msg.op === 'end' || msg.op === 'cancel') {
      if (live === null) { reply(msg, { ok: false, error: 'no session' }); continue; }
      if (msg.op === 'chunk') {
        if (mode === 'crash-chunk' && live > 0) process.exit(3);
        live += Buffer.from(msg.b64, 'base64').length;
      }
      reply(msg, { ok: true, text: (msg.op === 'end' ? 'final ' : '') + live });
      if (msg.op !== 'chunk') live = null;
      continue;
    }
    const once = process.env.MARK && !fs.existsSync(process.env.MARK);
    if (once) fs.writeFileSync(process.env.MARK, '');
    if (mode === 'crash' || (mode === 'crash-once' && once)) process.exit(3);
    if (mode === 'hang') continue;
    if (mode === 'error') { process.stdout.write(JSON.stringify({ ok: false, error: 'engine' }) + '\\n'); continue; }
    process.stdout.write('noise\\n' + JSON.stringify({ ok: true, id: msg.id, text: String(Buffer.from(msg.b64, 'base64').length) }) + '\\n');
  }
});
`;

let dir: string;
let launches: number;
let engine: SpeechEngine | null;

function create(mode = 'ok', options: { idleMs?: number; timeoutMs?: number } = {}) {
  const script = path.join(dir, 'fake.js');
  writeFileSync(script, FAKE);
  engine = createHanbaoEngine({
    ...options,
    start: () => {
      launches++;
      return spawn(process.execPath, [script], {
        env: { ...process.env, MODE: mode, MARK: path.join(dir, 'mark') },
      });
    },
  });
  return engine;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'hanbao-engine-'));
  launches = 0;
  engine = null;
});

afterEach(() => {
  engine?.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe('toPcm16', () => {
  it('encodes clipped samples as little-endian s16', () => {
    const pcm = toPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
    expect([...new Int16Array(pcm.buffer, pcm.byteOffset, 6)]).toEqual([
      0, 32767, -32768, 32767, -32768, 16384,
    ]);
  });
});

describe('hanbao engine', () => {
  it('keeps one child for sequential and concurrent requests', async () => {
    const hanbao = create();
    const [a, b] = await Promise.all([
      hanbao.transcribe(new Float32Array(100)),
      hanbao.transcribe(new Float32Array(300)),
    ]);
    expect([a, b, await hanbao.transcribe(new Float32Array(5))]).toEqual(['200', '600', '10']);
    expect(launches).toBe(1);
  });

  it('restarts once and replays the request after a crash', async () => {
    const hanbao = create('crash-once');
    await expect(hanbao.transcribe(new Float32Array(8))).resolves.toBe('16');
    expect(launches).toBe(2);
  });

  it('gives up when the replay crashes too', async () => {
    const hanbao = create('crash');
    await expect(hanbao.transcribe(new Float32Array(8))).rejects.toThrow(/exited/);
    expect(launches).toBe(2);
  });

  it('rejects engine errors without restarting', async () => {
    const hanbao = create('error');
    await expect(hanbao.transcribe(new Float32Array(8))).rejects.toThrow(/engine/);
    expect(launches).toBe(1);
  });

  it('kills a hung child on timeout and starts fresh next time', async () => {
    const hanbao = create('hang', { timeoutMs: 200 });
    await expect(hanbao.transcribe(new Float32Array(8))).rejects.toThrow(/timed out/);
    await expect(hanbao.transcribe(new Float32Array(8))).rejects.toThrow(/timed out/);
    expect(launches).toBe(2);
  });

  it('shuts the child down when idle and relaunches on demand', async () => {
    const hanbao = create('ok', { idleMs: 50 });
    await hanbao.transcribe(new Float32Array(8));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(hanbao.transcribe(new Float32Array(8))).resolves.toBe('16');
    expect(launches).toBe(2);
  });

  it('refuses work after dispose', async () => {
    const hanbao = create();
    hanbao.dispose();
    await expect(hanbao.transcribe(new Float32Array(8))).rejects.toThrow(/disposed/);
    expect(launches).toBe(0);
  });
});

describe('hanbao stream', () => {
  it('returns the running text for every chunk and the final text on finish', async () => {
    const stream = create().openStream();
    await expect(stream.accept(new Float32Array(100))).resolves.toBe('200');
    await expect(stream.accept(new Float32Array(50))).resolves.toBe('300');
    await expect(stream.finish()).resolves.toBe('final 300');
    expect(launches).toBe(1);
  });

  it('keeps the child alive while a stream is open', async () => {
    const hanbao = create('ok', { idleMs: 50 });
    const stream = hanbao.openStream();
    await stream.accept(new Float32Array(8));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(stream.finish()).resolves.toBe('final 16');
    expect(launches).toBe(1);
  });

  it('fails the stream after a crash instead of silently starting over', async () => {
    const hanbao = create('crash-chunk', { idleMs: 50 });
    const stream = hanbao.openStream();
    await stream.accept(new Float32Array(8));
    await expect(stream.accept(new Float32Array(8))).rejects.toThrow(/exited/);
    expect(launches).toBe(1);
    await expect(hanbao.transcribe(new Float32Array(8))).resolves.toBe('16');
    // 失败的流不再占着引擎：空闲后照常退出
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(hanbao.transcribe(new Float32Array(8))).resolves.toBe('16');
    expect(launches).toBe(3);
    await expect(stream.finish()).rejects.toThrow(/lost/);
  });

  it('lets a cancelled stream free the engine for the next session', async () => {
    const hanbao = create();
    const first = hanbao.openStream();
    await first.accept(new Float32Array(8));
    first.cancel();
    const second = hanbao.openStream();
    await expect(second.accept(new Float32Array(4))).resolves.toBe('8');
    await expect(second.finish()).resolves.toBe('final 8');
  });
});
