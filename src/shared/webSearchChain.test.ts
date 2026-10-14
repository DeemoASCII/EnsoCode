import { describe, expect, it } from 'vitest';
import {
  isXaiResponsesHost,
  nativeSearchKindFor,
  parseWebSearchChain,
  WEB_SEARCH_CHAIN_MAX,
  webSearchCandidateProviders,
} from './webSearchChain';

describe('nativeSearchKindFor', () => {
  it('按 api 映射通道；antigravity 走 CCA grounding', () => {
    expect(nativeSearchKindFor('anthropic-messages', '')).toBe('anthropic');
    expect(nativeSearchKindFor('openai-responses', '')).toBe('responses');
    expect(nativeSearchKindFor('openai-codex-responses', '')).toBe('codex');
    expect(nativeSearchKindFor('google-generative-ai', '')).toBe('gemini');
    expect(nativeSearchKindFor('google-antigravity', '')).toBe('antigravity');
  });

  it('antigravity provider 注册进 pi runtime 后模型带 -cca 后缀的 api 标识（ANTIGRAVITY_API_ID）', () => {
    // pi composeModelProvider.extensionModelFromDefinition 会用 provider config 的 api 给模型盖戳，
    // worker modelRegistry 里 Antigravity 模型的 api 实际是 'google-antigravity-cca'；
    // 分类器必须认这个 id，否则链首候选被「no native web search support」静默跳过、请求都发不出去。
    expect(nativeSearchKindFor('google-antigravity-cca', '')).toBe('antigravity');
  });

  it('openai-completions 仅官方 xAI 主机走 responses；中转与未知 api 无原生能力', () => {
    expect(nativeSearchKindFor('openai-completions', 'https://api.x.ai/v1')).toBe('responses');
    expect(nativeSearchKindFor('openai-completions', 'https://api.x.ai.evil.com')).toBeUndefined();
    expect(
      nativeSearchKindFor('openai-completions', 'https://cli-chat-proxy.grok.com')
    ).toBeUndefined();
    expect(nativeSearchKindFor('openai-completions', 'not a url')).toBeUndefined();
    expect(nativeSearchKindFor('kimi-coding', '')).toBeUndefined();
    expect(nativeSearchKindFor('typesafe-system-one', '')).toBeUndefined();
  });

  it('isXaiResponsesHost 只认精确 hostname', () => {
    expect(isXaiResponsesHost('https://api.x.ai')).toBe(true);
    expect(isXaiResponsesHost('https://api.x.ai:443/v1')).toBe(true);
    expect(isXaiResponsesHost('https://sub.api.x.ai')).toBe(false);
  });
});

describe('parseWebSearchChain', () => {
  it('非数组/非法条目收窄为空链', () => {
    expect(parseWebSearchChain(undefined)).toEqual([]);
    expect(parseWebSearchChain('x')).toEqual([]);
    expect(parseWebSearchChain([null, {}, { providerId: 1, modelId: 'm' }])).toEqual([]);
  });

  it('修剪空白、去重、截断到上限', () => {
    const many = Array.from({ length: WEB_SEARCH_CHAIN_MAX + 3 }, (_, i) => ({
      providerId: `p${i}`,
      modelId: 'm',
    }));
    const parsed = parseWebSearchChain([
      { providerId: ' p1 ', modelId: ' m1 ' },
      { providerId: 'p1', modelId: 'm1' },
      ...many,
    ]);
    expect(parsed[0]).toEqual({ providerId: 'p1', modelId: 'm1' });
    expect(parsed).toHaveLength(WEB_SEARCH_CHAIN_MAX);
    expect(new Set(parsed.map((e) => `${e.providerId}/${e.modelId}`)).size).toBe(parsed.length);
  });
});

describe('webSearchCandidateProviders', () => {
  type Fixture = {
    id: string;
    enabled?: boolean;
    oauthAccountPool?: unknown;
    api: string;
    baseUrl: string;
  };
  const provider = (extra: Record<string, unknown>): Fixture =>
    ({
      id: 'p',
      api: 'openai-completions',
      baseUrl: 'https://api.x.ai/v1',
      enabled: true,
      ...extra,
    }) as Fixture;

  it('OAuth 条目：根据 oauthAccountKey 纠正遗留 api 占位（如 antigravity 标 openai-completions）', () => {
    const list = [
      provider({
        id: 'ag-oauth',
        api: 'openai-completions', // 历史占位
        baseUrl: '',
        oauthAccountKey: 'google-antigravity',
      }),
      provider({
        id: 'kimi-oauth',
        api: 'openai-completions',
        baseUrl: '',
        oauthAccountKey: 'kimi-coding', // 无原生搜索
      }),
      provider({
        id: 'xai-oauth',
        api: 'openai-completions',
        baseUrl: '', // 缺省空 baseUrl 自动补 x.ai
        oauthAccountKey: 'xai',
      }),
    ];
    const out = webSearchCandidateProviders(list);
    expect(out.map((p) => p.id)).toEqual(['ag-oauth', 'xai-oauth']);
  });

  it('只保留有原生搜索能力的启用条目；pool 与禁用排除', () => {
    const list = [
      provider({ id: 'xai' }), // openai-completions + api.x.ai → responses ✓
      provider({ id: 'kimi', api: 'kimi-coding', baseUrl: 'https://api.kimi.com/coding' }), // 无 kind
      provider({ id: 'ag', api: 'google-antigravity', baseUrl: '' }), // antigravity ✓
      provider({ id: 'off', enabled: false }), // 禁用
      provider({
        id: 'pool',
        api: 'openai-codex-responses',
        oauthAccountPool: { accountKeys: ['openai-codex'] },
      }), // pool v1 不支持
      provider({
        id: 'ga',
        api: 'google-generative-ai',
        baseUrl: 'https://generativelanguage.googleapis.com',
      }), // ✓
    ];
    const out = webSearchCandidateProviders(list);
    expect(out.map((p) => p.id)).toEqual(['xai', 'ag', 'ga']);
  });
});
