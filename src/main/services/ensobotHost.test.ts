import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CharacterCardData } from '@shared/characterCard';
import type { EnsobotModelDecision } from '@shared/defaultModel';
import { describe, expect, it } from 'vitest';
import type { CardSummary } from './characterCards';
import { createEnsobotHost, type EnsobotHostDeps } from './ensobotHost';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';

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
  const root = path.join(
    tmpdir(),
    `ensobot-host-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  mkdirSync(root, { recursive: true });
  const calls: string[] = [];
  const cards = new Map(
    (options?.cards ?? [personaCard(A), personaCard(B)]).map((card) => [card.id, card])
  );
  let workerReady = options?.ready ?? true;
  let spawnedSession = '';
  let seq = 0;
  const deps: EnsobotHostDeps = {
    workerReady: () => workerReady,
    steer: (input) => {
      calls.push(`steer:${input.text}`);
      return { ok: true };
    },
    prompt: (input) => {
      calls.push(`prompt:${input.text}`);
      return { ok: true };
    },
    spawn: (input) => {
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
  };
  const host = createEnsobotHost(root, deps);
  return {
    host,
    calls,
    root,
    setReady: (value: boolean) => {
      workerReady = value;
    },
    sessionId: () => spawnedSession,
  };
}

describe('ensobot host', () => {
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
    await host.whenIdle();
    expect(host.snapshot().tasks[0]?.status).toBe('done');
    expect(host.snapshot().board.some((note) => note.text === '我闲了')).toBe(true);
  });

  it('留言只叫醒被点名的人，bot 的话不能当成用户授权', async () => {
    const { host, calls } = harness();
    const result = await host.postBoard({
      text: '北北看一下',
      mentions: [B, A, B, 'stranger'],
      deliveryId: 'board-1',
    });
    expect(result.ok).toBe(true);
    const prompts = calls.filter((call) => call.startsWith('prompt:') || call.startsWith('steer:'));
    expect(prompts).toHaveLength(2);
    expect(prompts.every((call) => call.includes('不是用户本人'))).toBe(true);
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

  it('群里的话马上记在房间里，没点名就不叫醒', async () => {
    const { host, calls } = harness({ ready: false });
    const created = await host.createRoom({ name: '小队', memberIds: [A, B] });
    expect(created.ok).toBe(true);
    const sent = await host.postRoom({
      roomId: created.roomId ?? '',
      text: '大家看看',
      deliveryId: 'r1',
    });
    expect(sent).toMatchObject({ ok: true, disposition: 'silent' });
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
    expect(prompts[0]).toContain('不是用户本人');
    host.observe({
      type: 'ensobot-bubble',
      identity: { sessionId: sessionId() },
      text: '我看了',
      deliveryId: 'speak-1',
    });
    const room = host.snapshot().roomMessages;
    expect(room.map((message) => message.text)).toEqual(['@北北 看一下', '我看了']);
    expect(room[1]?.authorKind).toBe('bot');
    expect(host.snapshot().board.some((note) => note.text === '我看了')).toBe(false);
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
