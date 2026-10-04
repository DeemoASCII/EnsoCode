import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmartRouteInput } from '../../../shared/bots/smartRoute';
import { createSmartRouter } from './smartRouter';

const input: SmartRouteInput = {
  candidates: [
    { id: 'a', name: 'Alice', title: '', scope: 'lead', canAct: false, owner: true },
    { id: 'b', name: 'Bob', title: '', scope: 'backend', canAct: true, owner: false },
    { id: 'c', name: 'Carol', title: '', scope: 'frontend', canAct: true, owner: false },
  ],
  bossBotId: 'a',
  recent: [],
  message: 'fix the api',
};
const signal = new AbortController().signal;
const judgeModel = { providerId: 'p', modelId: 'fast' };

let settings: Record<string, unknown> | undefined;
const judge = vi.fn();
const classify = vi.fn();
const router = () => createSmartRouter({ settings: () => settings, judge, classify });

beforeEach(() => {
  settings = {};
  judge.mockReset();
  classify.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('createSmartRouter', () => {
  it('未设置时走 judge（标题模型回退链），默认超时 3000ms', async () => {
    judge.mockResolvedValueOnce('Bob');
    expect(router().timeoutMs()).toBe(3000);
    expect(await router().select(input, signal)).toEqual(['b']);
    expect(judge.mock.calls[0][0]).toMatchObject({ preferred: undefined, timeoutMs: 3000 });
    expect(judge.mock.calls[0][0].userText).toContain('fix the api');
    expect(classify).not.toHaveBeenCalled();
  });

  it('指定 judge 模型时排在最前，并使用其超时', async () => {
    settings = { botRouteClassifier: { source: 'judge', model: judgeModel, timeoutMs: 5000 } };
    judge.mockResolvedValueOnce('BOSS');
    expect(router().timeoutMs()).toBe(5000);
    expect(await router().select(input, signal)).toEqual(['a']);
    expect(judge.mock.calls[0][0]).toMatchObject({ preferred: judgeModel, timeoutMs: 5000 });
  });

  it('judge 回复多名时按顺序返回名单', async () => {
    judge.mockResolvedValueOnce('Carol\nBob');
    expect(await router().select(input, signal)).toEqual(['c', 'b']);
  });

  it('judge 回复不认识或没有可用模型时返回空名单', async () => {
    judge.mockResolvedValueOnce('maybe Dave');
    expect(await router().select(input, signal)).toEqual([]);
    judge.mockResolvedValueOnce(null);
    expect(await router().select(input, signal)).toEqual([]);
  });

  it('pi-classifier 取达到 0.4 的候选（降序），都不达标或不可用时返回空名单', async () => {
    settings = {
      botRouteClassifier: {
        source: 'pi-classifier',
        model: { providerId: 'or', modelId: 'cls' },
        timeoutMs: 3000,
      },
    };
    classify.mockResolvedValueOnce({ a: 0.3, b: 0.7 });
    expect(await router().select(input, signal)).toEqual(['b']);
    const [config, question] = classify.mock.calls[0];
    expect(config).toMatchObject({ source: 'pi-classifier', model: { modelId: 'cls' } });
    expect(Object.keys(question.criteria)).toEqual(['a', 'b', 'c']);
    classify.mockResolvedValueOnce({ a: 0.1, b: 0.42, c: 0.48 });
    expect(await router().select(input, signal)).toEqual(['c', 'b']);
    classify.mockResolvedValueOnce({ a: 0.35, b: 0.3, c: 0.35 });
    expect(await router().select(input, signal)).toEqual([]);
    classify.mockResolvedValueOnce(null);
    expect(await router().select(input, signal)).toEqual([]);
    expect(judge).not.toHaveBeenCalled();
  });
});
