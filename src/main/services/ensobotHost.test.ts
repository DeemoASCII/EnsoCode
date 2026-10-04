import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CharacterCardData } from '@shared/characterCard';
import type { EnsobotModelDecision } from '@shared/defaultModel';
import { applyEnsobotSnapshot, type EnsobotSnapshot } from '@shared/ensobot/snapshot';
import type { ProjectedMessage } from '@shared/types/agent';
import { afterEach, describe, expect, it } from 'vitest';
import type { CardSummary } from './characterCards';
import {
  createEnsobotHost,
  type EnsobotHost,
  type EnsobotHostDeps,
  type EnsobotSpawnInput,
} from './ensobotHost';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function personaCard(id: string, patch?: Partial<CharacterCardData['role']>): CharacterCardData {
  return {
    id,
    persona: { name: id === A ? '阿宁' : '北北', personality: '稳', setting: '桌边' },
    role: {
      callableBy: [],
      toolIds: [],
      approvalScope: 'supervised',
      duty: id === A ? '写测试' : '看留言',
      providerId: 'openai',
      modelId: 'gpt',
      concurrency: 1,
      coordinator: false,
      ...patch,
    },
    crop: null,
  };
}

function summary(card: CharacterCardData): CardSummary {
  return {
    id: card.id,
    previewUrl: `ensobot-card://card/${card.id}`,
    bare: false,
    width: 4,
    height: 4,
    card,
  };
}

function harness(options?: {
  ready?: boolean;
  spawnReady?: boolean;
  model?: EnsobotModelDecision;
  cards?: CharacterCardData[];
}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ensobot-host-'));
  roots.push(root);
  const calls: string[] = [];
  const sent: { sessionId: string; text: string; kind: 'prompt' | 'steer' }[] = [];
  const cards = new Map(
    (options?.cards ?? [personaCard(A), personaCard(B)]).map((card) => [card.id, card])
  );
  let workerReady = options?.ready ?? true;
  let spawnedSession = '';
  let seq = 0;
  const snapshots: EnsobotSnapshot[] = [];
  const spawns: EnsobotSpawnInput[] = [];
  const deps: EnsobotHostDeps = {
    workerReady: () => workerReady,
    steer: (input) => {
      calls.push(`steer:${input.text}`);
      sent.push({ sessionId: input.sessionId, text: input.text, kind: 'steer' });
      return { ok: true };
    },
    prompt: (input) => {
      calls.push(`prompt:${input.text}`);
      sent.push({ sessionId: input.sessionId, text: input.text, kind: 'prompt' });
      return { ok: true };
    },
    spawn: (input) => {
      spawns.push(input);
      spawnedSession = input.sessionId;
      calls.push(`spawn:${input.coordinator}:${input.rolePrompt}`);
      return { ok: true, ready: options?.spawnReady ?? true };
    },
    resolveModel: async () =>
      options?.model ?? { kind: 'card', providerId: 'openai', modelId: 'gpt' },
    projectById: (projectId) =>
      projectId === 'proj'
        ? { ok: true, name: '演示', cwd: '/work/demo' }
        : { ok: false, error: 'unknown-project' },
    loadCard: (id) => {
      const card = cards.get(id);
      return card ? summary(card) : null;
    },
    listCardIds: () => [...cards.keys()],
    uuid: () => {
      seq += 1;
      return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
    },
    onChange: (snapshot) => snapshots.push(snapshot),
  };
  const host = createEnsobotHost(root, deps);
  return {
    host,
    calls,
    sent,
    root,
    deps,
    snapshots,
    spawns,
    setReady: (value: boolean) => {
      workerReady = value;
    },
    sessionId: () => spawnedSession,
    sessionOf: (cardId: string) => sessionOf(spawns, cardId),
    sentTo: (cardId: string) => {
      const ids = new Set(
        spawns.filter((spawn) => spawn.cwd.endsWith(cardId)).map((spawn) => spawn.sessionId)
      );
      return sent.filter((item) => ids.has(item.sessionId));
    },
  };
}

function sessionOf(
  spawns: EnsobotSpawnInput[],
  cardId: string
): { sessionId: string; generation: string } {
  const spawn = [...spawns].reverse().find((item) => item.cwd.endsWith(cardId));
  if (!spawn) throw new Error(`no session for ${cardId}`);
  return { sessionId: spawn.sessionId, generation: spawn.generation };
}

function reply(
  host: EnsobotHost,
  identity: { sessionId: string; generation?: string },
  text: string,
  patch?: Partial<ProjectedMessage>
): void {
  host.observe({
    type: 'message-upsert',
    identity,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      stopReason: 'stop',
      timestamp: Date.now(),
      ...patch,
    },
  });
}

async function finish(
  host: EnsobotHost,
  identity: { sessionId: string; generation?: string },
  type: 'turn-completed' | 'turn-failed' = 'turn-completed',
  error?: string
): Promise<void> {
  host.observe({ type, identity, ...(error ? { error } : {}) });
  await host.whenIdle();
}

function roomTexts(host: EnsobotHost): string[] {
  return host.snapshot().roomMessages.map((message) => message.text);
}

function readEvidence(
  host: EnsobotHost,
  evidenceId: string,
  field: 'parameters' | 'output'
): string {
  let text = '';
  let offset = 0;
  let revision: string | undefined;
  for (;;) {
    const chunk = host.readWork({ evidenceId, field, offset, ...(revision ? { revision } : {}) });
    expect(chunk.ok).toBe(true);
    if (!chunk.ok) throw new Error(chunk.error);
    expect(chunk.text.length).toBeLessThanOrEqual(16_000);
    expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThan(1_048_576);
    if (revision) expect(chunk.revision).toBe(revision);
    revision = chunk.revision;
    text += chunk.text;
    if (chunk.nextOffset === null) return text;
    expect(chunk.nextOffset).toBeGreaterThan(offset);
    offset = chunk.nextOffset;
  }
}

describe('ensobot host', () => {
  it('超过 1MB 的中文工具证据不进入任何快照，分块可重建且历史重启仍可读', async () => {
    const { host, root, deps, sessionOf, snapshots } = harness();
    const text = `${'中文证据😀\n'.repeat(100_000)}末尾`;
    expect(Buffer.byteLength(text)).toBeGreaterThan(1_048_576);
    await host.submitUtterance({ cardId: A, text: '检查', lane: 'human', deliveryId: 'large' });
    const identity = sessionOf(A);
    reply(host, identity, '', {
      stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'same', name: 'write', arguments: { content: text } }],
    });
    host.observe({
      type: 'message-upsert',
      identity,
      message: { role: 'toolResult', toolCallId: 'same', content: [{ type: 'text', text }] },
    });
    const step = host.snapshot().activity![0].steps[0];
    expect(step).not.toHaveProperty('parameters');
    expect(step).not.toHaveProperty('output');
    expect(step).toMatchObject({
      evidenceId: expect.any(String),
      hasParameters: true,
      hasOutput: true,
    });
    expect(readEvidence(host, step.evidenceId!, 'parameters')).toBe(
      JSON.stringify({ content: text }, null, 2)
    );
    expect(readEvidence(host, step.evidenceId!, 'output')).toBe(text);
    reply(host, identity, '检查完成');
    await finish(host, identity);
    const saved = readFileSync(path.join(root, 'log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(saved.at(-1).work[0].output).toBe(text);
    expect(saved.at(-1).work[0].parameters).toBe(JSON.stringify({ content: text }, null, 2));
    const restored = createEnsobotHost(root, deps);
    expect(restored.snapshot().bubbles.at(-1)?.work?.[0]).toEqual(step);
    expect(readEvidence(restored, step.evidenceId!, 'output')).toBe(text);
    for (const snapshot of [...snapshots, restored.snapshot()]) {
      const encoded = JSON.stringify(snapshot);
      expect(Buffer.byteLength(encoded)).toBeLessThan(1_048_576);
      expect(encoded).not.toContain('中文证据');
    }
  });

  it('同 toolCallId 不同轮、不同人物和不同用户 source 的证据不会串数据', async () => {
    const { host, sessionOf } = harness();
    const ids: string[] = [];
    for (const [index, cardId] of [A, A, B].entries()) {
      await host.submitUtterance({
        cardId,
        text: '检查',
        lane: 'human',
        deliveryId: `round-${index}`,
      });
      const identity = sessionOf(cardId);
      reply(host, identity, '', {
        stopReason: 'toolUse',
        content: [
          { type: 'toolCall', id: 'reused', name: 'read', arguments: { path: `file-${index}` } },
        ],
      });
      ids.push(
        host.snapshot().activity!.find((activity) => activity.cardId === cardId)!.steps[0]
          .evidenceId!
      );
      reply(host, identity, '完成');
      await finish(host, identity);
    }
    expect(new Set(ids).size).toBe(3);
    for (const [index, id] of ids.entries())
      expect(readEvidence(host, id, 'parameters')).toContain(`file-${index}`);
    const other = harness();
    await other.host.submitUtterance({
      cardId: A,
      text: '检查',
      lane: 'human',
      deliveryId: 'other',
    });
    reply(other.host, other.sessionOf(A), '', {
      stopReason: 'toolUse',
      content: [
        { type: 'toolCall', id: 'reused', name: 'read', arguments: { path: 'other-source' } },
      ],
    });
    expect(other.host.readWork({ evidenceId: ids[0], field: 'parameters', offset: 0 })).toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  it('live 内容变更使旧 revision 失效，非法 payload 不读取任意路径，缺详情明确 not-found', async () => {
    const { host, sessionOf } = harness();
    await host.submitUtterance({ cardId: A, text: '检查', lane: 'human', deliveryId: 'live' });
    const identity = sessionOf(A);
    const update = (content: string) =>
      reply(host, identity, '', {
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 'live', name: 'write', arguments: { content } }],
      });
    update('旧'.repeat(30_000));
    const evidenceId = host.snapshot().activity![0].steps[0].evidenceId!;
    const request = { evidenceId, field: 'parameters', offset: 0 };
    const first = host.readWork(request);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('missing evidence');
    expect(first.nextOffset).toBe(16_000);
    update('新'.repeat(30_000));
    expect(host.snapshot().activity![0].steps[0].evidenceId).toBe(evidenceId);
    expect(
      host.readWork({ ...request, offset: first.nextOffset, revision: first.revision })
    ).toEqual({ ok: false, error: 'stale' });
    expect(readEvidence(host, evidenceId, 'parameters')).toBe(
      JSON.stringify({ content: '新'.repeat(30_000) }, null, 2)
    );
    expect(host.readWork({ ...request, field: 'output' })).toEqual({
      ok: false,
      error: 'not-found',
    });
    const latest = host.readWork(request);
    if (!latest.ok) throw new Error(latest.error);
    expect(host.readWork({ ...request, offset: 99_999, revision: latest.revision })).toEqual({
      ok: false,
      error: 'bad-params',
    });
    host.observe({
      type: 'message-upsert',
      identity,
      message: { role: 'toolResult', toolCallId: 'live', content: [{ type: 'text', text: '' }] },
    });
    const empty = host.readWork({ ...request, field: 'output' });
    expect(empty).toMatchObject({ ok: true, text: '', nextOffset: null });
    host.observe({
      type: 'message-upsert',
      identity,
      message: {
        role: 'toolResult',
        toolCallId: 'live',
        content: [{ type: 'text', text: '补齐结果' }],
      },
    });
    if (!empty.ok) throw new Error(empty.error);
    expect(host.readWork({ ...request, field: 'output', revision: empty.revision })).toEqual({
      ok: false,
      error: 'stale',
    });
    for (const bad of [
      null,
      [],
      'x',
      {},
      { ...request, evidenceId: '../sessions.json' },
      { ...request, field: 'env' },
      ...[-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 99_999].map((offset) => ({
        ...request,
        offset,
      })),
      { ...request, offset: 1 },
      { ...request, revision: {} },
      { ...request, sessionFile: '/private' },
      { ...request, cardId: A },
    ])
      expect(host.readWork(bad), JSON.stringify(bad)).toEqual({ ok: false, error: 'bad-params' });
  });

  it('旧宿主日志补稳定 ID 且白名单不带出 env/provider 私有字段，无详情不可伪造', () => {
    const { root, deps } = harness();
    writeFileSync(
      path.join(root, 'log.jsonl'),
      JSON.stringify({
        seq: 2,
        kind: 'bubble',
        cardId: A,
        deliveryId: 'old',
        lane: 'bot',
        authorKind: 'bot',
        text: '完成',
        work: [
          {
            id: 'old',
            name: 'read',
            summary: 'a.ts',
            status: 'done',
            parameters: '{"path":"a.ts"}',
            output: '历史完整证据',
            env: { SECRET: 'PRIVATE_SECRET' },
            provider: { apiKey: 'PRIVATE_SECRET' },
          },
          { id: 'missing', name: 'read', summary: '', status: 'done' },
        ],
      })
    );
    const host = createEnsobotHost(root, deps);
    const work = host.snapshot().bubbles.at(-1)!.work!;
    expect(JSON.stringify(host.snapshot())).not.toContain('PRIVATE_SECRET');
    expect(JSON.stringify(host.snapshot())).not.toContain('历史完整证据');
    expect(readEvidence(host, work[0].evidenceId!, 'output')).toBe('历史完整证据');
    expect(host.readWork({ evidenceId: work[1].evidenceId, field: 'output', offset: 0 })).toEqual({
      ok: false,
      error: 'not-found',
    });
    const restarted = createEnsobotHost(root, deps);
    expect(restarted.snapshot().bubbles.at(-1)!.work).toEqual(work);
    expect(readEvidence(restarted, work[0].evidenceId!, 'parameters')).toBe('{"path":"a.ts"}');
  });

  it('非流式工具的最终成功结果也可通过检查，但仍等待轮次结束', async () => {
    const { host, spawns } = harness();
    await host.enqueueTask({ cardId: A, title: '非流式检查', check: 'PASS' });
    host.observe({
      type: 'message-upsert',
      identity: spawns[0],
      message: {
        role: 'toolResult',
        toolCallId: 'check',
        isError: false,
        content: [{ type: 'text', text: 'PASS' }],
      },
    });
    expect(host.snapshot().tasks[0].status).toBe('doing');
    host.observe({ type: 'turn-completed', identity: spawns[0] });
    await host.whenIdle();
    expect(host.snapshot().tasks[0].status).toBe('done');
  });

  it('工具最终报错会覆盖中途 PASS，不能通过任务检查', async () => {
    const { host, spawns } = harness();
    await host.enqueueTask({ cardId: A, title: '错误结果', check: 'PASS' });
    host.observe({ type: 'tool-output', identity: spawns[0], toolCallId: 'check', output: 'PASS' });
    host.observe({
      type: 'message-upsert',
      identity: spawns[0],
      message: {
        role: 'toolResult',
        toolCallId: 'check',
        isError: true,
        content: [{ type: 'text', text: 'PASS then error' }],
      },
    });
    host.observe({ type: 'turn-completed', identity: spawns[0] });
    await host.whenIdle();
    expect(host.snapshot().tasks[0].status).toBe('failed');
  });

  it('用户中断后的 completed 不能把已出现 PASS 的任务报成成功', async () => {
    const { host, spawns } = harness();
    await host.enqueueTask({ cardId: A, title: '中断任务', check: 'PASS' });
    host.observe({ type: 'tool-output', identity: spawns[0], output: 'PASS' });
    host.observe({
      type: 'message-upsert',
      identity: spawns[0],
      message: { role: 'assistant', content: [], stopReason: 'aborted' },
    });
    host.observe({ type: 'turn-completed', identity: spawns[0] });
    await host.whenIdle();
    expect(host.snapshot().tasks[0].status).toBe('failed');
  });
  it('工人不在线就拒绝，不留下气泡', async () => {
    const { host } = harness({ ready: false });
    const result = await host.submitUtterance({
      cardId: A,
      text: '在吗',
      lane: 'human',
      deliveryId: 'd1',
    });
    expect(result).toEqual({ ok: false, error: 'worker-offline' });
    expect(host.snapshot().bubbles).toEqual([]);
  });

  it('没有活轮就原样交给工人，活轮则补充进去且不另开一轮', async () => {
    const { host, calls, sessionId } = harness();
    const first = await host.submitUtterance({
      cardId: A,
      text: '把测试补上',
      lane: 'human',
      deliveryId: 'd1',
    });
    expect(first).toMatchObject({ ok: true, disposition: 'sent' });
    expect(calls.some((call) => call.startsWith('prompt:把测试补上'))).toBe(true);
    expect(calls.some((call) => call.includes('abort'))).toBe(false);

    host.observe({ type: 'status', identity: { sessionId: sessionId() }, status: 'running' });
    const second = await host.submitUtterance({
      cardId: A,
      text: '再加一条边界',
      lane: 'human',
      deliveryId: 'd2',
    });
    expect(second).toMatchObject({ ok: true, disposition: 'sent' });
    const steer = calls.find((call) => call.startsWith('steer:'));
    expect(steer).toContain('保留原目标');
    expect(steer).toContain('再加一条边界');
    expect(steer).not.toContain('abort');
  });

  it('重试倒计时里的话先排着，不打断', async () => {
    const { host, calls, sessionId } = harness();
    await host.submitUtterance({ cardId: A, text: '先做', lane: 'human', deliveryId: 'd1' });
    host.observe({ type: 'turn-retry', identity: { sessionId: sessionId() } });
    calls.length = 0;
    const result = await host.submitUtterance({
      cardId: A,
      text: '等一下',
      lane: 'human',
      deliveryId: 'd2',
    });
    expect(result).toMatchObject({ ok: true, disposition: 'queued' });
    expect(calls.filter((call) => call.startsWith('steer:') || call.startsWith('prompt:'))).toEqual(
      []
    );
    expect(host.snapshot().bubbles.map((item) => item.deliveryId)).toEqual(['d1', 'd2']);
  });

  it('同一条 deliveryId 不会送第二次，空话直接拒绝', async () => {
    const { host, calls } = harness();
    await host.submitUtterance({ cardId: A, text: '一次', lane: 'human', deliveryId: 'd1' });
    const again = await host.submitUtterance({
      cardId: A,
      text: '一次',
      lane: 'human',
      deliveryId: 'd1',
    });
    expect(again).toEqual({ ok: false, error: 'duplicate' });
    expect(calls.filter((call) => call.startsWith('prompt:'))).toHaveLength(1);
    expect(
      await host.submitUtterance({ cardId: A, text: '  ', lane: 'human', deliveryId: 'd3' })
    ).toEqual({ ok: false, error: 'empty' });
  });

  it('会话还没就绪时先收下，等 parent-ready 再送', async () => {
    const { host, calls, sessionId } = harness({ spawnReady: false });
    const result = await host.submitUtterance({
      cardId: A,
      text: '等工人',
      lane: 'human',
      deliveryId: 'd1',
    });
    expect(result).toMatchObject({ ok: true, disposition: 'queued' });
    expect(calls.some((call) => call.startsWith('prompt:'))).toBe(false);
    host.observe({ type: 'parent-ready', identity: { sessionId: sessionId() } });
    await host.whenIdle();
    expect(calls.some((call) => call.startsWith('prompt:等工人'))).toBe(true);
  });

  it('换目标不包补充说明', async () => {
    const { host, calls, sessionId } = harness();
    await host.submitUtterance({ cardId: A, text: '原目标', lane: 'human', deliveryId: 'd1' });
    host.observe({ type: 'status', identity: { sessionId: sessionId() }, status: 'running' });
    await host.submitUtterance({
      cardId: A,
      text: '改成写文档',
      lane: 'human',
      deliveryId: 'd2',
      retarget: true,
    });
    const steer = calls.find((call) => call.startsWith('steer:'));
    expect(steer).toBe('steer:改成写文档');
  });

  it('占不上槽或目录被占就继续排队，工人不在线不标成正在做', async () => {
    const { host, setReady } = harness();
    await host.setWorkspace({ projectId: 'proj', sessionId: null });
    const first = await host.enqueueTask({ cardId: A, title: '先写', check: 'PASS' });
    expect(first.disposition).toBe('doing');
    const second = await host.enqueueTask({ cardId: B, title: '后写', check: 'PASS' });
    expect(second).toMatchObject({ ok: true, disposition: 'waiting-directory' });
    setReady(false);
    const third = await host.enqueueTask({ cardId: A, title: '离线', check: 'PASS' });
    expect(third).toMatchObject({ ok: false, error: 'worker-offline' });
    const offline = host.snapshot().tasks.find((task) => task.title === '离线');
    expect(offline?.status).toBe('queued');
    expect(host.snapshot().tasks.find((task) => task.title === '后写')?.status).toBe(
      'waiting-directory'
    );
  });

  it('模型还在加载就停在队列里，缺模型则回默认再做', async () => {
    const blocked = harness({
      model: {
        kind: 'oauth-blocked',
        reason: 'oauth-credentials-loading',
        suggestedAction: 'wait-for-oauth-credentials',
      },
    });
    const waiting = await blocked.host.enqueueTask({ cardId: A, title: '等钥匙', check: 'PASS' });
    expect(waiting.ok).toBe(false);
    expect(waiting.error).toBe('oauth-credentials-loading');
    expect(blocked.host.snapshot().tasks[0]?.status).toBe('queued');

    const fallback = harness({
      model: { kind: 'default', providerId: 'anthropic', modelId: 'sonnet', fellBack: true },
    });
    const started = await fallback.host.enqueueTask({ cardId: A, title: '用默认', check: 'PASS' });
    expect(started).toMatchObject({ ok: true, disposition: 'doing' });
    expect(fallback.host.snapshot().tasks[0]).toMatchObject({
      status: 'doing',
      fellBack: true,
      providerId: 'anthropic',
      modelId: 'sonnet',
    });
  });

  it('工具输出里的检查才算做完，留言板里出现同样的字不算', async () => {
    const { host } = harness();
    await host.enqueueTask({ cardId: A, title: '跑测试', check: 'PASS' });
    await host.postBoard({ text: '我觉得 PASS', mentions: [], deliveryId: 'board-1' });
    expect(host.snapshot().tasks[0]?.status).toBe('doing');
    const session = host.snapshot().tasks[0]?.sessionId ?? '';
    host.observe({
      type: 'tool-output',
      identity: { sessionId: session },
      output: 'still running',
    });
    expect(host.snapshot().tasks[0]?.status).toBe('doing');
    host.observe({
      type: 'tool-output',
      identity: { sessionId: session },
      output: 'PASS',
    });
    expect(host.snapshot().tasks[0]?.status).toBe('doing');
    host.observe({ type: 'turn-completed', identity: { sessionId: session } });
    await host.whenIdle();
    expect(host.snapshot().tasks[0]?.status).toBe('done');
    expect(host.snapshot().board.some((note) => note.text === '我闲了')).toBe(true);
  });

  it('留言只叫醒被点名的人；人发的留言不能被标成 bot 转述', async () => {
    const { host, calls } = harness();
    const result = await host.postBoard({
      text: '北北看一下',
      mentions: [B, A, B, 'stranger'],
      deliveryId: 'board-1',
    });
    expect(result.ok).toBe(true);
    const prompts = calls.filter((call) => call.startsWith('prompt:') || call.startsWith('steer:'));
    expect(prompts).toHaveLength(2);
    expect(prompts.some((call) => call.includes('不是用户本人'))).toBe(false);
    expect(prompts.every((call) => call.includes('用户在公共留言板上点了你'))).toBe(true);
    expect(host.snapshot().board[0]?.mentions).toEqual([B, A]);
  });

  it('协调者开跑时会标上不写工作区', async () => {
    const { host, calls } = harness({
      cards: [personaCard(A, { coordinator: true })],
    });
    await host.submitUtterance({ cardId: A, text: '分给北北', lane: 'human', deliveryId: 'd1' });
    const spawned = calls.find((call) => call.startsWith('spawn:true:'));
    expect(spawned).toContain('人设');
    expect(spawned).toContain('职能');
  });

  it('坏掉的队列行不会让剩下的任务消失', async () => {
    const root = path.join(tmpdir(), `ensobot-queue-${Date.now()}`);
    roots.push(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, 'queue.jsonl'),
      `${'not-json'}\n${JSON.stringify({
        id: 'task-1',
        cardId: A,
        title: '还在',
        workspaceKey: `scratch:${A}`,
        status: 'queued',
        check: 'PASS',
      })}\n`
    );
    const host = createEnsobotHost(root, harnessDeps());
    expect(host.snapshot().tasks.map((task) => task.title)).toEqual(['还在']);
  });

  it('不知道的项目不能设成公共工作区', async () => {
    const { host } = harness();
    expect(await host.setWorkspace({ projectId: 'missing', sessionId: null })).toEqual({
      ok: false,
      error: 'unknown-project',
    });
    expect((await host.setWorkspace({ projectId: 'proj', sessionId: 'session-1' })).ok).toBe(true);
    expect(host.snapshot().workspace).toEqual({
      projectId: 'proj',
      projectName: '演示',
      sessionId: 'session-1',
    });
  });

  it('群里的话马上记在房间里；没点名交给主持人，worker 不在时如实报失败', async () => {
    const { host, calls } = harness({ ready: false });
    const created = await host.createRoom({ name: '小队', memberIds: [A, B] });
    expect(created.ok).toBe(true);
    const sent = await host.postRoom({
      roomId: created.roomId ?? '',
      text: '大家看看',
      deliveryId: 'r1',
    });
    expect(sent).toMatchObject({ ok: true, disposition: 'partial' });
    expect(host.snapshot().roomMessages.map((message) => message.text)).toEqual(['大家看看']);
    expect(calls.filter((call) => call.startsWith('prompt:') || call.startsWith('steer:'))).toEqual(
      []
    );
  });

  it('群里点名才叫醒那一个人，回话出现在房间里，不写进私聊', async () => {
    const { host, calls, sessionId } = harness();
    const created = await host.createRoom({ name: '小队', memberIds: [A, B] });
    const sent = await host.postRoom({
      roomId: created.roomId ?? '',
      text: '@北北 看一下',
      deliveryId: 'r2',
    });
    expect(sent.ok).toBe(true);
    expect(host.snapshot().roomMessages[0]?.mentions).toEqual([B]);
    expect(host.snapshot().bubbles).toEqual([]);
    const prompts = calls.filter((call) => call.startsWith('prompt:') || call.startsWith('steer:'));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('不是用户本人');
    expect(prompts[0]).toContain('用户在群里点了你：\n@北北 看一下');
    host.observe({
      type: 'ensobot-bubble',
      identity: { sessionId: sessionId() },
      text: '我看了',
      deliveryId: 'speak-1',
    });
    const room = host.snapshot().roomMessages;
    expect(room.map((message) => message.text)).toEqual(['@北北 看一下', '我看了']);
    expect(room[1]?.authorKind).toBe('bot');
    expect(host.snapshot().bubbles).toEqual([]);
    expect(host.snapshot().board.some((note) => note.text === '我看了')).toBe(false);
  });

  it('留言板回复按实际投递的来源返回，不依赖已清空的 pending，不污染私聊', async () => {
    const { host, sessionId } = harness();
    await host.postBoard({ text: '请看板', mentions: [A], deliveryId: 'board' });
    host.observe({
      type: 'ensobot-bubble',
      identity: { sessionId: sessionId() },
      text: '已看板',
      deliveryId: 'reply',
    });
    expect(host.snapshot().board.map((note) => note.text)).toEqual(['请看板', '已看板']);
    expect(host.snapshot().bubbles).toEqual([]);
  });

  it('私聊活轮期间群点名先排队，旧回复不泄露到群，收口后群回复不进入私聊', async () => {
    const { host, calls, sessionId } = harness();
    const room = await host.createRoom({ name: '小队', memberIds: [A, B] });
    await host.submitUtterance({
      cardId: A,
      text: '私聊问题',
      lane: 'human',
      deliveryId: 'private',
    });
    await host.postRoom({ roomId: room.roomId!, text: '@阿宁 群问题', deliveryId: 'group' });
    expect(calls.filter((call) => call.startsWith('steer:'))).toEqual([]);
    host.observe({
      type: 'ensobot-bubble',
      identity: { sessionId: sessionId() },
      text: '私聊回答',
      deliveryId: 'private-reply',
    });
    expect(host.snapshot().roomMessages.map((message) => message.text)).toEqual(['@阿宁 群问题']);
    host.observe({ type: 'turn-completed', identity: { sessionId: sessionId() } });
    await host.whenIdle();
    host.observe({
      type: 'ensobot-bubble',
      identity: { sessionId: sessionId() },
      text: '群回答',
      deliveryId: 'group-reply',
    });
    expect(host.snapshot().roomMessages.map((message) => message.text)).toEqual([
      '@阿宁 群问题',
      '群回答',
    ]);
    expect(host.snapshot().bubbles.map((message) => message.text)).toEqual([
      '私聊问题',
      '私聊回答',
    ]);
  });

  it('两个群的点名不能互相覆盖回复目标', async () => {
    const { host, sessionId } = harness();
    const one = await host.createRoom({ name: '一群', memberIds: [A, B] });
    const two = await host.createRoom({ name: '二群', memberIds: [A, B] });
    await host.postRoom({ roomId: one.roomId!, text: '@阿宁 一', deliveryId: 'one' });
    await host.postRoom({ roomId: two.roomId!, text: '@阿宁 二', deliveryId: 'two' });
    host.observe({
      type: 'ensobot-bubble',
      identity: { sessionId: sessionId() },
      text: '第一群回答',
      deliveryId: 'reply-one',
    });
    expect(
      host.snapshot().roomMessages.find((message) => message.text === '第一群回答')?.roomId
    ).toBe(one.roomId);
    host.observe({ type: 'turn-completed', identity: { sessionId: sessionId() } });
    await host.whenIdle();
    host.observe({
      type: 'ensobot-bubble',
      identity: { sessionId: sessionId() },
      text: '第二群回答',
      deliveryId: 'reply-two',
    });
    expect(
      host.snapshot().roomMessages.find((message) => message.text === '第二群回答')?.roomId
    ).toBe(two.roomId);
  });

  it('worker 延迟接收群点名后重投保留群来源与原文', async () => {
    const { host, calls, sessionId } = harness();
    const room = await host.createRoom({ name: '小队', memberIds: [A, B] });
    await host.postRoom({ roomId: room.roomId!, text: '@阿宁 看一下', deliveryId: 'deferred' });
    host.observe({
      type: 'ensobot-interject-deferred',
      identity: { sessionId: sessionId() },
      deliveryId: `deferred:${A}`,
    });
    host.observe({ type: 'turn-completed', identity: { sessionId: sessionId() } });
    await host.whenIdle();
    expect(calls.filter((call) => call.startsWith('prompt:'))).toHaveLength(2);
    host.observe({
      type: 'ensobot-bubble',
      identity: { sessionId: sessionId() },
      text: '重新收到',
      deliveryId: 'reply',
    });
    expect(host.snapshot().roomMessages.at(-1)?.text).toBe('重新收到');
    expect(host.snapshot().bubbles).toEqual([]);
  });

  it('任务 doing 推送通过真实 renderer 的 seq 去重门，重建宿主不回退序号', async () => {
    const { host, snapshots, root, deps } = harness();
    await host.enqueueTask({ cardId: A, title: '执行', check: 'PASS' });
    const projection = snapshots.reduce<EnsobotSnapshot | null>(applyEnsobotSnapshot, null);
    expect(host.snapshot().tasks[0].status).toBe('doing');
    expect(projection?.tasks[0].status).toBe('doing');
    const restored = createEnsobotHost(root, deps);
    expect(restored.snapshot().seq).toBeGreaterThan(host.snapshot().seq);
  });

  it('后台 prompt 发送失败后可重新认领，不能被去重标记永久吞掉', async () => {
    const { host, deps, calls } = harness();
    const prompt = deps.prompt;
    deps.prompt = () => ({ ok: false });
    await host.enqueueTask({ cardId: A, title: '重投', check: 'PASS' });
    const task = host.snapshot().tasks[0];
    expect(task.status).toBe('queued');
    deps.prompt = prompt;
    expect(await host.claim({ cardId: A, taskId: task.id })).toMatchObject({
      ok: true,
      disposition: 'doing',
    });
    expect(calls.filter((call) => call.startsWith('prompt:'))).toHaveLength(1);
  });

  it('检查命中仍保留目录锁，只有整轮成功结束才唤醒另一个写入任务', async () => {
    const { host, calls } = harness();
    await host.setWorkspace({ projectId: 'proj', sessionId: null });
    await host.enqueueTask({ cardId: A, title: '先写', check: 'PASS' });
    await host.enqueueTask({ cardId: B, title: '后写', check: 'PASS' });
    const sessionId = host.snapshot().tasks[0].sessionId!;
    host.observe({ type: 'tool-output', identity: { sessionId }, output: 'PASS' });
    host.observe({ type: 'status', identity: { sessionId }, status: 'idle' });
    await host.whenIdle();
    expect(host.snapshot().tasks.map((task) => task.status)).toEqual([
      'doing',
      'waiting-directory',
    ]);
    expect(calls.filter((call) => call.startsWith('prompt:'))).toHaveLength(1);
    host.observe({ type: 'turn-completed', identity: { sessionId } });
    await host.whenIdle();
    expect(host.snapshot().tasks.map((task) => task.status)).toEqual(['done', 'doing']);
  });

  it.each(['turn-failed', 'turn-completed'])(
    '任务 %s 没通过检查时失败并释放目录，不能一直 doing',
    async (type) => {
      const { host } = harness();
      await host.setWorkspace({ projectId: 'proj', sessionId: null });
      await host.enqueueTask({ cardId: A, title: '失败', check: 'PASS' });
      await host.enqueueTask({ cardId: B, title: '接着做', check: 'PASS' });
      const sessionId = host.snapshot().tasks[0].sessionId!;
      host.observe({
        type: 'status',
        identity: { sessionId },
        status: type === 'turn-failed' ? 'failed' : 'idle',
      });
      host.observe({ type, identity: { sessionId } });
      await host.whenIdle();
      expect(host.snapshot().tasks.map((task) => task.status)).toEqual(['failed', 'doing']);
      expect(host.snapshot().tasks[0].note).toBeTruthy();
    }
  );

  it('工具输出曾通过但轮最终失败，不能报 done', async () => {
    const { host, sessionId } = harness();
    await host.enqueueTask({ cardId: A, title: '失败', check: 'PASS' });
    host.observe({ type: 'tool-output', identity: { sessionId: sessionId() }, output: 'PASS' });
    host.observe({ type: 'turn-failed', identity: { sessionId: sessionId() } });
    await host.whenIdle();
    expect(host.snapshot().tasks[0].status).toBe('failed');
  });

  it('后台只 claimed 等前台结束时，前台工具 PASS 不算后台完成', async () => {
    const { host, sessionId } = harness();
    await host.submitUtterance({ cardId: A, text: '前台问题', lane: 'human', deliveryId: 'front' });
    await host.enqueueTask({ cardId: A, title: '后台任务', check: 'PASS' });
    host.observe({ type: 'tool-output', identity: { sessionId: sessionId() }, output: 'PASS' });
    host.observe({ type: 'turn-completed', identity: { sessionId: sessionId() } });
    await host.whenIdle();
    expect(host.snapshot().tasks[0].status).toBe('doing');
    host.observe({ type: 'turn-completed', identity: { sessionId: sessionId() } });
    await host.whenIdle();
    expect(host.snapshot().tasks[0].status).toBe('failed');
  });

  it('重建宿主重新 spawn 并恢复权威会话文件，拒绝旧 generation 的回复', async () => {
    const { host, root, deps, spawns } = harness();
    await host.submitUtterance({
      cardId: A,
      text: '以前的话',
      lane: 'human',
      deliveryId: 'before',
    });
    const old = spawns[0];
    host.observe({
      type: 'parent-ready',
      identity: old,
      sessionFile: path.join(root, 'history.jsonl'),
    });
    await host.whenIdle();
    const restored = createEnsobotHost(root, deps);
    await restored.submitUtterance({ cardId: A, text: '继续', lane: 'human', deliveryId: 'after' });
    expect(spawns).toHaveLength(2);
    expect(spawns[1].resumeFile).toBe(path.join(root, 'history.jsonl'));
    expect(spawns[1].generation).not.toBe(old.generation);
    restored.observe({
      type: 'ensobot-bubble',
      identity: old,
      text: '旧代回复',
      deliveryId: 'stale',
    });
    expect(restored.snapshot().bubbles.some((bubble) => bubble.text === '旧代回复')).toBe(false);
  });

  it('worker 退出会结束活任务、解开目录并在再次发消息时恢复 session', async () => {
    const { host, spawns } = harness();
    await host.enqueueTask({ cardId: A, title: '进行中', check: 'PASS' });
    host.observe({ type: 'worker-exited' });
    expect(host.snapshot().tasks[0].status).toBe('failed');
    await host.submitUtterance({
      cardId: A,
      text: '恢复',
      lane: 'human',
      deliveryId: 'after-exit',
    });
    expect(spawns).toHaveLength(2);
    expect(spawns[1].generation).not.toBe(spawns[0].generation);
    expect(host.snapshot().notices).toEqual([]);
  });

  it.each(['parent-ended', 'parent-rejected'])(
    '%s 后不能一直使用已经消失的 session',
    async (type) => {
      const { host, spawns } = harness();
      await host.submitUtterance({ cardId: A, text: '开始', lane: 'human', deliveryId: 'before' });
      host.observe({ type, identity: spawns[0] });
      await host.submitUtterance({
        cardId: A,
        text: '再次发送',
        lane: 'human',
        deliveryId: 'after',
      });
      expect(spawns).toHaveLength(2);
      expect(spawns[1].generation).not.toBe(spawns[0].generation);
    }
  );

  it('冷启动不能遗留 doing/claimed 目录占用，也不能自动重放已执行任务', async () => {
    const { host, root, deps, calls } = harness();
    await host.enqueueTask({ cardId: A, title: '已执行', check: 'PASS' });
    const restored = createEnsobotHost(root, deps);
    expect(restored.snapshot().tasks[0].status).toBe('failed');
    expect(calls.filter((call) => call.startsWith('prompt:'))).toHaveLength(1);
  });

  it('worker 退出后下一次发送等待按需重启，不用用户去普通聊天唤醒', async () => {
    const { host, deps, setReady, calls } = harness({ ready: false });
    deps.prepareWorker = async () => {
      setReady(true);
      return true;
    };
    expect(
      await host.submitUtterance({ cardId: A, text: '恢复', lane: 'human', deliveryId: 'recover' })
    ).toMatchObject({ ok: true });
    expect(calls.filter((call) => call.startsWith('prompt:'))).toHaveLength(1);
  });

  it('同聊天面 steer 被 worker 延迟后，保留投递用于重发', async () => {
    const { host, calls, spawns } = harness();
    await host.submitUtterance({ cardId: A, text: '前一轮', lane: 'human', deliveryId: 'first' });
    await host.submitUtterance({ cardId: A, text: '补充', lane: 'human', deliveryId: 'follow' });
    host.observe({ type: 'ensobot-interject-deferred', identity: spawns[0], deliveryId: 'follow' });
    host.observe({ type: 'turn-completed', identity: spawns[0] });
    await host.whenIdle();
    expect(calls.filter((call) => call.startsWith('prompt:'))).toHaveLength(2);
  });

  it('人在群里点名：成员收到用户原话和群上下文，不被标成 bot 转述', async () => {
    const { host, sentTo } = harness();
    const room = await host.createRoom({ name: '快递单', memberIds: [A, B] });
    await host.postRoom({ roomId: room.roomId!, text: '中通第二页只有条码', deliveryId: 'r0' });
    await host.postRoom({ roomId: room.roomId!, text: '@北北 看一下', deliveryId: 'r1' });
    const toB = sentTo(B);
    expect(toB).toHaveLength(1);
    expect(toB[0].text).not.toContain('不是用户本人');
    expect(toB[0].text).toContain('群聊「快递单」');
    expect(toB[0].text).toContain('阿宁（主持人）：写测试');
    expect(toB[0].text).toContain('北北（你）：看留言');
    expect(toB[0].text).toContain('- 用户：中通第二页只有条码');
    expect(toB[0].text).toContain('用户在群里点了你：\n@北北 看一下');
  });

  it('成员这一轮最后的文字发到群里，没调说话工具也有回复；中途旁白不算', async () => {
    const { host, sessionOf } = harness();
    const room = await host.createRoom({ name: '小队', memberIds: [A, B] });
    await host.postRoom({ roomId: room.roomId!, text: '@北北 看一下', deliveryId: 'r1' });
    const b = sessionOf(B);
    reply(host, b, '我先看看', { stopReason: 'toolUse' });
    reply(host, b, '看过了，没问题');
    await finish(host, b);
    expect(roomTexts(host)).toEqual(['@北北 看一下', '看过了，没问题']);
    expect(host.snapshot().roomMessages[1]).toMatchObject({ authorId: B, authorKind: 'bot' });
    expect(host.snapshot().bubbles).toEqual([]);
  });

  it('私聊的最终回复进私聊；与已发气泡相同不重复；旧时间戳的消息不冒充本轮回复', async () => {
    const { host, sessionOf } = harness();
    await host.submitUtterance({ cardId: A, text: '你好', lane: 'human', deliveryId: 'p1' });
    const a = sessionOf(A);
    reply(host, a, '很久以前的回复', { timestamp: Date.now() - 60_000 });
    host.observe({ type: 'ensobot-bubble', identity: a, text: 'HI', deliveryId: 'say-1' });
    reply(host, a, 'HI');
    await finish(host, a);
    await host.submitUtterance({ cardId: A, text: '再说', lane: 'human', deliveryId: 'p2' });
    reply(host, a, '第二轮');
    await finish(host, a);
    expect(host.snapshot().bubbles.map((bubble) => bubble.text)).toEqual([
      '你好',
      'HI',
      '再说',
      '第二轮',
    ]);
  });

  it('群里失败的一轮留下系统说明，不会无声无息', async () => {
    const { host, sessionOf } = harness();
    const room = await host.createRoom({ name: '小队', memberIds: [A, B] });
    await host.postRoom({ roomId: room.roomId!, text: '@北北 看一下', deliveryId: 'r1' });
    await finish(host, sessionOf(B), 'turn-failed', '模型超时');
    const last = host.snapshot().roomMessages.at(-1);
    expect(last).toMatchObject({ authorKind: 'system', authorId: B });
    expect(last?.text).toContain('模型超时');
  });

  it('没点名的人话交给主持人：默认是协调者，也可以建群时指定', async () => {
    const { host, sentTo } = harness({
      cards: [personaCard(A), personaCard(B, { coordinator: true })],
    });
    const room = await host.createRoom({ name: '小队', memberIds: [A, B] });
    expect(host.snapshot().groups[0]?.hostId).toBe(B);
    expect(
      await host.postRoom({ roomId: room.roomId!, text: '大家看看', deliveryId: 'r1' })
    ).toMatchObject({ ok: true, disposition: 'sent' });
    expect(sentTo(A)).toEqual([]);
    expect(sentTo(B)).toHaveLength(1);
    expect(sentTo(B)[0].text).toContain('你是主持人');
    expect(sentTo(B)[0].text).toContain('没有点名');
    const picked = await host.createRoom({ name: '二队', memberIds: [A, B], hostId: A });
    await host.postRoom({ roomId: picked.roomId!, text: '看看', deliveryId: 'r2' });
    expect(sentTo(A)).toHaveLength(1);
    expect(await host.createRoom({ name: '坏', memberIds: [A, B], hostId: SESSION })).toEqual({
      ok: false,
      error: 'bad-host',
    });
  });

  it('主持人 @ 成员分派；成员回复后主持人收到汇总，再给用户结论', async () => {
    const { host, sentTo, sessionOf } = harness({
      cards: [personaCard(A, { coordinator: true }), personaCard(B)],
    });
    const room = await host.createRoom({ name: '小队', memberIds: [A, B] });
    await host.postRoom({ roomId: room.roomId!, text: '做个方案', deliveryId: 'human' });
    reply(host, sessionOf(A), '@北北 你来核对数据');
    await finish(host, sessionOf(A));
    expect(sentTo(B)).toHaveLength(1);
    expect(sentTo(B)[0].text).toContain('不是用户本人');
    expect(sentTo(B)[0].text).toContain('- 用户：做个方案');
    expect(sentTo(B)[0].text).toContain('阿宁在群里点了你：\n@北北 你来核对数据');
    reply(host, sessionOf(B), '数据没问题');
    await finish(host, sessionOf(B));
    expect(sentTo(A)).toHaveLength(2);
    expect(sentTo(A)[1].text).toContain('你分派的成员都回复了');
    expect(sentTo(A)[1].text).toContain('北北：数据没问题');
    reply(host, sessionOf(A), '结论：可以上线');
    await finish(host, sessionOf(A));
    expect(roomTexts(host)).toEqual([
      '做个方案',
      '@北北 你来核对数据',
      '数据没问题',
      '结论：可以上线',
    ]);
    expect(sentTo(A)).toHaveLength(2);
    expect(sentTo(B)).toHaveLength(1);
  });

  it('成员失败也回报主持人，汇总不会一直等下去', async () => {
    const { host, sentTo, sessionOf } = harness({
      cards: [personaCard(A, { coordinator: true }), personaCard(B)],
    });
    const room = await host.createRoom({ name: '小队', memberIds: [A, B] });
    await host.postRoom({ roomId: room.roomId!, text: '做个方案', deliveryId: 'human' });
    reply(host, sessionOf(A), '@北北 查数据');
    await finish(host, sessionOf(A));
    await finish(host, sessionOf(B), 'turn-failed', '超时');
    expect(sentTo(A)).toHaveLength(2);
    expect(sentTo(A)[1].text).toContain('北北：');
    expect(sentTo(A)[1].text).toContain('失败');
  });

  it('接力有上限：bot 互相 @ 会停下，并在群里说明一次', async () => {
    const { host, sent, sessionOf } = harness();
    const room = await host.createRoom({ name: '小队', memberIds: [A, B] });
    await host.postRoom({ roomId: room.roomId!, text: '@阿宁 开始', deliveryId: 'human' });
    const a = sessionOf(A).sessionId;
    for (let round = 0; round < 40; round += 1) {
      const before = sent.length;
      const owner = sent.at(-1)!.sessionId === a ? A : B;
      reply(host, sessionOf(owner), owner === A ? '@北北 继续' : '@阿宁 继续');
      await finish(host, sessionOf(owner));
      if (sent.length === before) break;
    }
    expect(sent.length).toBeLessThanOrEqual(13);
    const notes = host.snapshot().roomMessages.filter((message) => message.authorKind === 'system');
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain('上限');
  });

  it('成员工作可见：排队、调用工具、完成后清空，工作记录挂在回复上', async () => {
    const { host, sessionOf } = harness();
    await host.submitUtterance({ cardId: A, text: '私聊在忙', lane: 'human', deliveryId: 'dm' });
    const room = await host.createRoom({ name: '小队', memberIds: [A, B] });
    await host.postRoom({ roomId: room.roomId!, text: '@阿宁 @北北 看文件', deliveryId: 'r1' });
    const activity = () => host.snapshot().activity ?? [];
    expect(activity().find((item) => item.cardId === A)).toMatchObject({
      state: 'thinking',
      surface: 'chat',
      queued: 1,
    });
    expect(activity().find((item) => item.cardId === B)).toMatchObject({
      state: 'thinking',
      surface: 'room',
      roomId: room.roomId,
      queued: 0,
    });
    const b = sessionOf(B);
    reply(host, b, '我看看', {
      stopReason: 'toolUse',
      content: [
        { type: 'text', text: '我看看' },
        { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.txt' } },
      ],
    });
    expect(activity().find((item) => item.cardId === B)).toMatchObject({
      state: 'tool',
      steps: [{ id: 't1', name: 'read', summary: 'a.txt', status: 'running' }],
    });
    host.observe({
      type: 'message-upsert',
      identity: b,
      message: {
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'read',
        content: [{ type: 'text', text: '内容' }],
        isError: false,
      },
    });
    expect(activity().find((item) => item.cardId === B)?.steps[0]?.status).toBe('done');
    reply(host, b, '看完了');
    await finish(host, b);
    expect(activity().some((item) => item.cardId === B)).toBe(false);
    expect(host.snapshot().roomMessages.at(-1)).toMatchObject({
      text: '看完了',
      work: [{ id: 't1', name: 'read', summary: 'a.txt', status: 'done' }],
    });
  });

  it.each(['chat', 'board', 'room'] as const)(
    '%s 的工具参数、结果和耗时变化会推送，完成后的工作记录重启仍可查看',
    async (surface) => {
      const { host, root, deps, snapshots, sessionOf } = harness();
      if (surface === 'room') {
        const room = await host.createRoom({ name: '工作群', memberIds: [A, B] });
        await host.postRoom({ roomId: room.roomId!, text: '@阿宁 看文件', deliveryId: 'work' });
      } else if (surface === 'board') {
        await host.postBoard({ text: '看文件', mentions: [A], deliveryId: 'work' });
      } else {
        await host.submitUtterance({
          cardId: A,
          text: '看文件',
          lane: 'human',
          deliveryId: 'work',
        });
      }
      const identity = sessionOf(A);
      reply(host, identity, '', {
        stopReason: 'toolUse',
        content: [
          { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'a.txt', offset: 2 } },
        ],
      });
      let before = snapshots.length;
      reply(host, identity, '', {
        stopReason: 'toolUse',
        content: [
          { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'a.txt', offset: 3 } },
        ],
      });
      expect(snapshots).toHaveLength(before + 1);
      const evidenceId = snapshots.at(-1)!.activity![0].steps[0].evidenceId!;
      expect(readEvidence(host, evidenceId, 'parameters')).toBe(
        JSON.stringify({ path: 'a.txt', offset: 3 }, null, 2)
      );
      const result = (output: string, durationMs: number): void =>
        host.observe({
          type: 'message-upsert',
          identity,
          message: {
            role: 'toolResult',
            toolCallId: 'read-1',
            toolName: 'read',
            content: [{ type: 'text', text: output }],
            isError: false,
            toolDurationMs: durationMs,
          },
        });
      result('文件第一版', 10);
      expect(snapshots.at(-1)?.activity?.[0]?.steps[0]).toMatchObject({
        status: 'done',
        hasOutput: true,
        durationMs: 10,
      });
      expect(readEvidence(host, evidenceId, 'output')).toBe('文件第一版');
      before = snapshots.length;
      result('文件第二版', 10);
      expect(snapshots).toHaveLength(before + 1);
      expect(readEvidence(host, evidenceId, 'output')).toBe('文件第二版');
      before = snapshots.length;
      result('文件第二版', 20);
      expect(snapshots).toHaveLength(before + 1);
      expect(snapshots.at(-1)?.activity?.[0]?.steps[0]).toMatchObject({ durationMs: 20 });
      before = snapshots.length;
      result('文件第二版', 20);
      expect(snapshots).toHaveLength(before);
      reply(host, identity, '已检查');
      await finish(host, identity);
      const messages = (snapshot: EnsobotSnapshot) =>
        surface === 'room'
          ? snapshot.roomMessages
          : surface === 'board'
            ? snapshot.board
            : snapshot.bubbles;
      const work = messages(host.snapshot()).at(-1)?.work;
      expect(work).toMatchObject([
        {
          id: 'read-1',
          name: 'read',
          status: 'done',
          evidenceId,
          hasParameters: true,
          hasOutput: true,
          durationMs: 20,
        },
      ]);
      const restored = createEnsobotHost(root, deps);
      expect(messages(restored.snapshot()).at(-1)?.work).toEqual(work);
      expect(readEvidence(restored, evidenceId, 'parameters')).toBe(
        JSON.stringify({ path: 'a.txt', offset: 3 }, null, 2)
      );
      expect(readEvidence(restored, evidenceId, 'output')).toBe('文件第二版');
      expect(restored.snapshot().activity).toEqual([]);
    }
  );

  it('用户拒绝工具的状态与结果随失败轮次落盘，重启不重新申请权限', async () => {
    const { host, root, deps, sent, sessionOf } = harness();
    await host.submitUtterance({ cardId: A, text: '写文件', lane: 'human', deliveryId: 'deny' });
    const identity = sessionOf(A);
    reply(host, identity, '', {
      stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'write-1', name: 'write', arguments: { path: 'a.txt' } }],
    });
    host.observe({
      type: 'message-upsert',
      identity,
      message: {
        role: 'toolResult',
        toolCallId: 'write-1',
        toolName: 'write',
        isError: true,
        content: [{ type: 'text', text: 'User denied this operation' }],
        toolDurationMs: 0,
      },
    });
    expect(host.snapshot().activity?.[0]?.steps[0]).toMatchObject({ status: 'denied' });
    await finish(host, identity, 'turn-failed', '操作被拒绝');
    const work = host.snapshot().bubbles.at(-1)?.work;
    expect(work).toMatchObject([
      {
        status: 'denied',
        hasParameters: true,
        hasOutput: true,
        durationMs: 0,
      },
    ]);
    const restored = createEnsobotHost(root, deps);
    await restored.resume();
    expect(restored.snapshot().bubbles.at(-1)?.work).toEqual(work);
    expect(readEvidence(restored, work![0].evidenceId!, 'parameters')).toContain('a.txt');
    expect(readEvidence(restored, work![0].evidenceId!, 'output')).toBe(
      'User denied this operation'
    );
    expect(restored.ownerOfSession(identity)).toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  it('建群后换主持人：之后没点名的话交给新主持人；非成员、坏上限、未知群被拒', async () => {
    const { host, sentTo } = harness();
    const room = await host.createRoom({ name: '小队', memberIds: [A, B] });
    expect(host.snapshot().groups[0]?.hostId).toBe(A);
    expect(await host.updateRoom({ roomId: room.roomId!, hostId: B })).toMatchObject({
      ok: true,
      disposition: 'saved',
    });
    expect(host.snapshot().groups[0]?.hostId).toBe(B);
    await host.postRoom({ roomId: room.roomId!, text: '看看', deliveryId: 'r1' });
    expect(sentTo(A)).toEqual([]);
    expect(sentTo(B)[0]?.text).toContain('北北（你，主持人）');
    expect(await host.updateRoom({ roomId: room.roomId!, hostId: SESSION })).toEqual({
      ok: false,
      error: 'bad-host',
    });
    expect(await host.updateRoom({ roomId: room.roomId!, relayLimit: 0 })).toEqual({
      ok: false,
      error: 'bad-limit',
    });
    expect(await host.updateRoom({ roomId: SESSION, hostId: A })).toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  it('接力上限按群设置生效，说明里写的是这个群的上限', async () => {
    const { host, sent, sessionOf } = harness();
    const room = await host.createRoom({ name: '小队', memberIds: [A, B] });
    await host.updateRoom({ roomId: room.roomId!, relayLimit: 2 });
    expect(host.snapshot().groups[0]?.relayLimit).toBe(2);
    await host.postRoom({ roomId: room.roomId!, text: '@阿宁 开始', deliveryId: 'human' });
    const a = sessionOf(A).sessionId;
    for (let round = 0; round < 10; round += 1) {
      const before = sent.length;
      const owner = sent.at(-1)!.sessionId === a ? A : B;
      reply(host, sessionOf(owner), owner === A ? '@北北 继续' : '@阿宁 继续');
      await finish(host, sessionOf(owner));
      if (sent.length === before) break;
    }
    expect(sent).toHaveLength(3);
    const notes = host.snapshot().roomMessages.filter((message) => message.authorKind === 'system');
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain('2 次');
  });

  it('重启后讨论链延续：排队的接力照常送达，已用的接力次数不清零', async () => {
    const { host, root, deps, sentTo, sessionOf } = harness();
    const room = await host.createRoom({ name: '小队', memberIds: [A, B] });
    await host.updateRoom({ roomId: room.roomId!, relayLimit: 1 });
    await host.submitUtterance({ cardId: B, text: '私聊在忙', lane: 'human', deliveryId: 'dm' });
    await host.postRoom({ roomId: room.roomId!, text: '@阿宁 开始', deliveryId: 'human' });
    reply(host, sessionOf(A), '@北北 你来');
    await finish(host, sessionOf(A));
    expect(host.snapshot().activity?.find((item) => item.cardId === B)?.queued).toBe(1);
    const before = sentTo(B).length;
    const restarted = createEnsobotHost(root, deps);
    await restarted.resume();
    await restarted.whenIdle();
    expect(sentTo(B)).toHaveLength(before + 1);
    expect(sentTo(B).at(-1)?.text).toContain('阿宁在群里点了你：\n@北北 你来');
    reply(restarted, sessionOf(B), '@阿宁 好了');
    await finish(restarted, sessionOf(B));
    expect(sentTo(A)).toHaveLength(1);
    const notes = restarted
      .snapshot()
      .roomMessages.filter((message) => message.authorKind === 'system');
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain('上限');
  });

  it('重启时正在做的那一支如实标为中断，不让主持人一直等，也不自动重放', async () => {
    const { host, root, deps, sent, sessionOf } = harness({
      cards: [personaCard(A, { coordinator: true }), personaCard(B)],
    });
    const room = await host.createRoom({ name: '小队', memberIds: [A, B] });
    await host.postRoom({ roomId: room.roomId!, text: '做个方案', deliveryId: 'human' });
    reply(host, sessionOf(A), '@北北 查数据');
    await finish(host, sessionOf(A));
    const count = sent.length;
    const restarted = createEnsobotHost(root, deps);
    const last = restarted.snapshot().roomMessages.at(-1);
    expect(last).toMatchObject({ authorKind: 'system', roomId: room.roomId });
    expect(last?.text).toContain('北北');
    expect(last?.text).toContain('中断');
    await restarted.resume();
    await restarted.whenIdle();
    expect(sent).toHaveLength(count);
    const again = createEnsobotHost(root, deps);
    expect(
      again.snapshot().roomMessages.filter((message) => message.authorKind === 'system')
    ).toHaveLength(1);
  });

  it.each(
    (['重启', 'worker-exited'] as const).flatMap((interruption) =>
      (['直接点名', '主持人', '私聊', '留言板'] as const).map((surface) => ({
        interruption,
        surface,
      }))
    )
  )(
    '$interruption：$surface 活轮在原来源持久化一次中断说明，不重放轮次或旧身份',
    async ({ interruption, surface }) => {
      const { host, root, deps, sent, spawns, sessionOf } = harness();
      const room = await host.createRoom({ name: '来源群', memberIds: [A, B] });
      await host.createRoom({ name: '无关群', memberIds: [A, B] });
      const cardId = surface === '直接点名' ? B : A;
      if (surface === '私聊') {
        await host.submitUtterance({
          cardId,
          text: '私聊请求',
          lane: 'human',
          deliveryId: 'active',
        });
      } else if (surface === '留言板') {
        await host.postBoard({ text: '留言请求', mentions: [cardId], deliveryId: 'active' });
      } else {
        await host.postRoom({
          roomId: room.roomId!,
          text: surface === '直接点名' ? '@北北 群请求' : '请主持人处理',
          deliveryId: 'active',
        });
      }
      const identity = sessionOf(cardId);
      reply(host, identity, '不能发布的半句', { stopReason: 'toolUse' });
      const sentCount = sent.length;
      const spawnCount = spawns.length;
      if (interruption === 'worker-exited') host.observe({ type: interruption });
      const interrupted = interruption === '重启' ? createEnsobotHost(root, deps) : host;
      const snapshot = interrupted.snapshot();
      const bubbles = snapshot.bubbles.filter((line) => line.authorKind === 'system');
      const board = snapshot.board.filter((line) => line.authorKind === 'system');
      const messages = snapshot.roomMessages.filter((line) => line.authorKind === 'system');
      expect(bubbles).toHaveLength(surface === '私聊' ? 1 : 0);
      expect(board).toHaveLength(surface === '留言板' ? 1 : 0);
      expect(messages).toHaveLength(surface === '直接点名' || surface === '主持人' ? 1 : 0);
      const note = [...bubbles, ...board, ...messages][0];
      expect(note.text).toContain('中断');
      expect(note.text).toContain(cardId === A ? '阿宁' : '北北');
      if (messages.length) expect(messages[0].roomId).toBe(room.roomId);
      if (bubbles.length) expect(bubbles[0].cardId).toBe(cardId);
      expect(snapshot.activity).toEqual([]);
      expect(interrupted.ownerOfSession(identity)).toBeUndefined();
      interrupted.observe({
        type: 'ensobot-bubble',
        identity,
        text: '旧代越权回复',
        deliveryId: 'stale',
      });
      await finish(interrupted, identity);
      await interrupted.resume();
      expect(sent).toHaveLength(sentCount);
      expect(spawns).toHaveLength(spawnCount);
      if (interruption === 'worker-exited') interrupted.observe({ type: interruption });
      // 反复从同一临时目录重建，证明说明确实落盘且不会重复生成。
      for (let count = 0; count < 2; count += 1) {
        const restored = createEnsobotHost(root, deps);
        await restored.resume();
        expect(restored.snapshot().bubbles).toEqual(snapshot.bubbles);
        expect(restored.snapshot().board).toEqual(snapshot.board);
        expect(restored.snapshot().roomMessages).toEqual(snapshot.roomMessages);
        expect(restored.ownerOfSession(identity)).toBeUndefined();
        expect(sent).toHaveLength(sentCount);
      }
    }
  );

  it.each(['重启', 'worker-exited'] as const)(
    '%s：跨聊天面排队不算中断，只恢复从未送出的 pending',
    async (interruption) => {
      const { host, root, deps, sent, sessionOf } = harness();
      const one = await host.createRoom({ name: '一群', memberIds: [A, B] });
      const two = await host.createRoom({ name: '二群', memberIds: [A, B] });
      await host.submitUtterance({
        cardId: A,
        text: '已执行的私聊',
        lane: 'human',
        deliveryId: 'active',
      });
      await host.postRoom({ roomId: one.roomId!, text: '@阿宁 排队一', deliveryId: 'queue-one' });
      await host.postRoom({ roomId: two.roomId!, text: '@阿宁 排队二', deliveryId: 'queue-two' });
      await host.postBoard({ text: '排队留言', mentions: [A], deliveryId: 'queue-board' });
      expect(sent).toHaveLength(1);
      if (interruption === 'worker-exited') host.observe({ type: interruption });
      const restored = createEnsobotHost(root, deps);
      expect(
        restored.snapshot().bubbles.filter((line) => line.authorKind === 'system')
      ).toHaveLength(1);
      expect(
        restored.snapshot().roomMessages.filter((line) => line.authorKind === 'system')
      ).toEqual([]);
      expect(restored.snapshot().board.filter((line) => line.authorKind === 'system')).toEqual([]);
      expect(restored.snapshot().activity).toMatchObject([
        { cardId: A, state: 'queued', queued: 3 },
      ]);
      await restored.resume();
      for (const text of ['群一完成', '群二完成', '留言完成']) {
        reply(restored, sessionOf(A), text);
        await finish(restored, sessionOf(A));
      }
      expect(sent).toHaveLength(4);
      expect(
        restored.snapshot().roomMessages.filter((line) => line.authorKind === 'bot')
      ).toMatchObject([
        { roomId: one.roomId, text: '群一完成' },
        { roomId: two.roomId, text: '群二完成' },
      ]);
      expect(restored.snapshot().board.at(-1)?.text).toBe('留言完成');
      const again = createEnsobotHost(root, deps);
      await again.resume();
      expect(sent).toHaveLength(4);
      expect(again.snapshot().roomMessages).toEqual(restored.snapshot().roomMessages);
      expect(again.snapshot().bubbles).toEqual(restored.snapshot().bubbles);
    }
  );

  it.each(['重启', 'worker-exited'] as const)(
    '%s：主持人分派与同面插话的活轮只说明一次，不重复汇总或重做',
    async (interruption) => {
      const { host, root, deps, sent, sessionOf } = harness();
      const room = await host.createRoom({ name: '小队', memberIds: [A, B] });
      await host.postRoom({ roomId: room.roomId!, text: '做个方案', deliveryId: 'host' });
      reply(host, sessionOf(A), '@北北 查数据');
      await finish(host, sessionOf(A));
      await host.postRoom({ roomId: room.roomId!, text: '@北北 再检查边界', deliveryId: 'steer' });
      const before = sent.length;
      if (interruption === 'worker-exited') host.observe({ type: interruption });
      const restored = createEnsobotHost(root, deps);
      const notes = restored.snapshot().roomMessages.filter((line) => line.authorKind === 'system');
      expect(notes).toHaveLength(1);
      expect(notes[0].text).toContain('北北');
      expect(notes[0].text).toContain('中断');
      await restored.resume();
      expect(sent).toHaveLength(before);
      const again = createEnsobotHost(root, deps);
      expect(again.snapshot().roomMessages).toEqual(restored.snapshot().roomMessages);
    }
  );

  it.each(['重启', 'worker-exited'] as const)(
    '%s：会话尚未就绪的纯排队消息不留中断说明，反复恢复前不会丢失',
    async (interruption) => {
      const { host, root, deps, sent, sessionOf } = harness({ spawnReady: false });
      const room = await host.createRoom({ name: '排队群', memberIds: [A, B] });
      await host.postRoom({ roomId: room.roomId!, text: '@阿宁 群排队', deliveryId: 'room' });
      await host.postBoard({ text: '留言排队', mentions: [A], deliveryId: 'board' });
      await host.submitUtterance({ cardId: A, text: '私聊排队', lane: 'human', deliveryId: 'dm' });
      expect(sent).toEqual([]);
      if (interruption === 'worker-exited') host.observe({ type: interruption });
      let restored = createEnsobotHost(root, deps);
      restored = createEnsobotHost(root, deps);
      const snapshot = restored.snapshot();
      expect([...snapshot.bubbles, ...snapshot.board, ...snapshot.roomMessages]).toHaveLength(3);
      expect(snapshot.activity).toMatchObject([{ cardId: A, state: 'queued', queued: 3 }]);
      const spawn = deps.spawn;
      deps.spawn = (input) => ({ ...spawn(input), ready: true });
      await restored.resume();
      for (const text of ['群完成', '留言完成', '私聊完成']) {
        reply(restored, sessionOf(A), text);
        await finish(restored, sessionOf(A));
      }
      expect(sent).toHaveLength(3);
      expect(restored.snapshot().roomMessages.at(-1)?.text).toBe('群完成');
      expect(restored.snapshot().board.at(-1)?.text).toBe('留言完成');
      expect(restored.snapshot().bubbles.at(-1)?.text).toBe('私聊完成');
    }
  );

  it.each(['重启', 'worker-exited'] as const)(
    '%s：工具检查已命中的后台任务仍持久化为 failed，不重放任务',
    async (interruption) => {
      const { host, root, deps, sent, sessionOf } = harness();
      await host.enqueueTask({ cardId: A, title: '尚未收口的任务', check: 'PASS' });
      host.observe({ type: 'tool-output', identity: sessionOf(A), output: 'PASS' });
      if (interruption === 'worker-exited') host.observe({ type: interruption });
      const restored = createEnsobotHost(root, deps);
      const task = restored.snapshot().tasks[0];
      expect(task.status).toBe('failed');
      expect(task.note).toContain('中断');
      await restored.resume();
      const again = createEnsobotHost(root, deps);
      await again.resume();
      expect(again.snapshot().tasks[0]).toEqual(task);
      expect(sent).toHaveLength(1);
      expect(again.snapshot().activity).toEqual([]);
    }
  );

  it('排队消息的成员已被删除：恢复时丢掉，不去开会话', async () => {
    const { host, root, deps, spawns } = harness();
    const room = await host.createRoom({ name: '小队', memberIds: [A, B] });
    await host.submitUtterance({ cardId: A, text: '先忙着', lane: 'human', deliveryId: 'busy' });
    await host.postRoom({ roomId: room.roomId!, text: '@阿宁 排着', deliveryId: 'queued' });
    expect(host.snapshot().activity?.find((item) => item.cardId === A)?.queued).toBe(1);
    const loadCard = deps.loadCard;
    deps.loadCard = (id) => (id === A ? null : loadCard(id));
    const restarted = createEnsobotHost(root, deps);
    const spawned = spawns.length;
    await restarted.resume();
    await restarted.whenIdle();
    expect(spawns).toHaveLength(spawned);
    expect(restarted.snapshot().activity ?? []).toEqual([]);
  });
});

function harnessDeps(): EnsobotHostDeps {
  return {
    workerReady: () => true,
    steer: () => ({ ok: true }),
    prompt: () => ({ ok: true }),
    spawn: () => ({ ok: true, ready: true }),
    resolveModel: async () => ({ kind: 'card', providerId: 'openai', modelId: 'gpt' }),
    projectById: () => ({ ok: false, error: 'unknown-project' }),
    loadCard: () => null,
    listCardIds: () => [],
    uuid: () => SESSION,
  };
}
