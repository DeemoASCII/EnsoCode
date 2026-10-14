/**
 * 全局 web_search 候选链（PR2）：web_search 不再只看会话模型，
 * 而是按用户配置的模型链依序尝试原生搜索，全部失败落 Exa MCP 兜底。
 *
 * 链条目只是 {providerId, modelId} 引用——凭证/端点由 worker 在调用时经
 * pi modelRegistry 现取（auth.json 刷新即时生效，推送不固化明文 token）。
 */

/** 原生搜索通道。antigravity = Cloud Code Assist googleSearch grounding。 */
export type NativeSearchKind = 'anthropic' | 'responses' | 'codex' | 'gemini' | 'antigravity';

export interface WebSearchChainEntry {
  /** settings 里的 provider 条目 id（OAuth 单账号 = account key） */
  providerId: string;
  modelId: string;
}

export const WEB_SEARCH_CHAIN_MAX = 8;

/**
 * xAI 聊天注册为 openai-completions，但官方 Responses 端点支持 web_search server tool，
 * 原生搜索可以复用 responses 路径。只认 hostname，避免 api.x.ai.evil.com 这类子串误判。
 */
export function isXaiResponsesHost(baseUrl: string): boolean {
  try {
    // 非法 baseUrl 安全回退
    return new URL(baseUrl).hostname === 'api.x.ai';
  } catch {
    return false;
  }
}

/**
 * 按 provider api + baseUrl 判定原生搜索通道；undefined = 无原生能力。
 * UI 过滤候选与 worker 执行共用同一判定，避免两处口径漂移。
 */
export function nativeSearchKindFor(api: string, baseUrl: string): NativeSearchKind | undefined {
  switch (api) {
    case 'anthropic-messages':
      return 'anthropic';
    case 'openai-responses':
      return 'responses';
    case 'openai-codex-responses':
      return 'codex';
    case 'google-generative-ai':
      return 'gemini';
    case 'google-antigravity':
    // antigravity.ts 的 ANTIGRAVITY_API_ID：provider 注册进 pi runtime 后，
    // composeModelProvider 会用 config.api 给每个模型盖戳，registry 里 Antigravity
    // 模型实际携带的是带 -cca 后缀的 id。漏认会被「no native web search support」
    // 静默跳过——请求都发不出去。
    case 'google-antigravity-cca':
      return 'antigravity';
    case 'openai-completions':
      // cli-chat-proxy.grok.com 与其它中转不走这条路径
      return isXaiResponsesHost(baseUrl) ? 'responses' : undefined;
    default:
      return undefined;
  }
}

export function isWebSearchChainEntry(value: unknown): value is WebSearchChainEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<WebSearchChainEntry>;
  return (
    typeof entry.providerId === 'string' &&
    entry.providerId.trim() !== '' &&
    typeof entry.modelId === 'string' &&
    entry.modelId.trim() !== ''
  );
}

/** 坏配置收窄：非数组/超上限/条目非法 → 空链（空链 = 现行行为，安全回退）。 */
export function parseWebSearchChain(value: unknown): WebSearchChainEntry[] {
  if (!Array.isArray(value)) return [];
  const out: WebSearchChainEntry[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isWebSearchChainEntry(item)) continue;
    const providerId = item.providerId.trim();
    const modelId = item.modelId.trim();
    const key = `${providerId}\n${modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ providerId, modelId });
    if (out.length >= WEB_SEARCH_CHAIN_MAX) break;
  }
  return out;
}

/**
 * OAuth 条目在 settings.json 里的 api 字段是历史遗留占位（如 openai-completions），
 * worker 运行时是按 oauthAccountKey 的基础 providerId 注册的。
 * 推导真实通信使用的 api 与 baseUrl，供原生搜索能力判定使用。
 */
export function effectiveSearchEndpoint(provider: {
  api: string;
  baseUrl: string;
  oauthAccountKey?: string | null;
}): { api: string; baseUrl: string } {
  if (provider.oauthAccountKey) {
    const baseId = providerIdOfAccountKey(provider.oauthAccountKey);
    switch (baseId) {
      case 'google-antigravity':
        return { api: 'google-antigravity', baseUrl: provider.baseUrl || '' };
      case 'anthropic':
        return {
          api: 'anthropic-messages',
          baseUrl: provider.baseUrl || 'https://api.anthropic.com',
        };
      case 'openai-codex':
        return {
          api: 'openai-codex-responses',
          baseUrl: provider.baseUrl || 'https://api.openai.com',
        };
      case 'xai':
        return { api: 'openai-completions', baseUrl: provider.baseUrl || 'https://api.x.ai/v1' };
      default:
        break;
    }
  }
  return { api: provider.api, baseUrl: provider.baseUrl };
}

/**
 * 可配置进 web_search 候选链的 provider：启用 + 有原生搜索通道。
 * OAuth 池（openai-codex 多账号合并条目）v1 不支持——worker 按 providerId 取模型时
 * 池条目没有对应的注册 provider，物化会落空，先从候选范围排除。
 */
export function webSearchCandidateProviders<
  T extends {
    enabled?: boolean;
    oauthAccountPool?: unknown;
    api: string;
    baseUrl: string;
    oauthAccountKey?: string | null;
  },
>(providers: readonly T[]): T[] {
  return providers.filter((provider) => {
    if (provider.enabled === false || provider.oauthAccountPool !== undefined) return false;
    const effective = effectiveSearchEndpoint(provider);
    return nativeSearchKindFor(effective.api, effective.baseUrl) !== undefined;
  });
}

import { providerIdOfAccountKey } from './types/oauthProviders';
