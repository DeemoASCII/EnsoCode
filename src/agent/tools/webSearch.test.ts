import { describe, expect, it, vi } from 'vitest';
import { formatSearchResult, type SearchModel, webSearch } from './webSearch';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sse = (events: unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
const exaReply = () =>
  new Response(
    `event: message\ndata: ${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          { type: 'text', text: 'Title: Node.js\nURL: https://nodejs.org/\nHighlights: fast' },
        ],
      },
    })}\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );

const anthropicModel: SearchModel = {
  provider: 'max',
  api: 'anthropic-messages',
  baseUrl: 'https://gw.example',
  id: 'claude-x',
  headers: { 'User-Agent': 'enso' },
};
const auth = async () => ({ apiKey: 'sk-test' });

const anthropicHit = {
  content: [
    { type: 'server_tool_use', id: 't1', name: 'web_search', input: { query: 'node' } },
    {
      type: 'web_search_tool_result',
      tool_use_id: 't1',
      content: [
        { type: 'web_search_result', title: 'Node.js', url: 'https://nodejs.org/', page_age: '1d' },
      ],
    },
    { type: 'text', text: 'Node 26 is current.' },
  ],
};

function urlOf(call: unknown): string {
  return String((call as unknown[])[0]);
}
function initOf(fetch: { mock: { calls: unknown[] } }, index: number): RequestInit {
  return (fetch.mock.calls[index] as [string, RequestInit])[1];
}

describe('webSearch', () => {
  it('显式空候选表示配置链全失效，直接 Exa，不回退会话模型', async () => {
    const fetch = vi.fn(async () => exaReply());
    const resolveAuth = vi.fn(auth);
    const { outcome } = await webSearch(
      'node',
      { model: anthropicModel, candidates: [], auth: resolveAuth },
      { fetch, unsupported: new Set() }
    );
    expect(outcome.source).toBe('exa');
    expect(resolveAuth).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(urlOf(fetch.mock.calls[0])).toMatch(/^https:\/\/mcp\.exa\.ai/);
  });
  it('Anthropic 原生搜索：带 server tool 请求并解析结果', async () => {
    const fetch = vi.fn(async () => json(anthropicHit));
    const { outcome } = await webSearch(
      'node',
      { model: anthropicModel, auth },
      { fetch, unsupported: new Set() }
    );
    expect(urlOf(fetch.mock.calls[0])).toBe('https://gw.example/v1/messages');
    const init = initOf(fetch, 0);
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['User-Agent']).toBe('enso');
    expect(JSON.parse(String(init.body)).tools[0]).toMatchObject({
      type: 'web_search_20250305',
      name: 'web_search',
    });
    expect(outcome).toMatchObject({
      source: 'anthropic',
      answer: 'Node 26 is current.',
      hits: [{ title: 'Node.js', url: 'https://nodejs.org/' }],
    });

    await webSearch(
      'node',
      { model: { ...anthropicModel, baseUrl: 'https://gw.example/v1/' }, auth },
      { fetch, unsupported: new Set() }
    );
    expect(urlOf(fetch.mock.calls[1])).toBe('https://gw.example/v1/messages');
  });

  it('网关静默忽略搜索工具时降级到 Exa，并在本会话记住不再尝试', async () => {
    const unsupported = new Set<string>();
    const fetch = vi.fn(async (url: string) =>
      url.startsWith('https://mcp.exa.ai')
        ? exaReply()
        : json({ content: [{ type: 'text', text: 'from memory' }] })
    );
    const first = await webSearch('node', { model: anthropicModel, auth }, { fetch, unsupported });
    expect(first.outcome.source).toBe('exa');
    expect(first.outcome.hits).toEqual([{ title: 'Node.js', url: 'https://nodejs.org/' }]);
    expect(first.notes.join('\n')).toMatch(/did not run a web search/);
    expect(fetch).toHaveBeenCalledTimes(2);

    await webSearch('node', { model: anthropicModel, auth }, { fetch, unsupported });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(urlOf(fetch.mock.calls[2])).toMatch(/^https:\/\/mcp\.exa\.ai\/mcp/);
  });

  it('临时错误（429）降级但不记为不支持', async () => {
    const unsupported = new Set<string>();
    const fetch = vi.fn(async (url: string) =>
      url.startsWith('https://mcp.exa.ai') ? exaReply() : json({ error: 'busy' }, 429)
    );
    const { outcome } = await webSearch(
      'node',
      { model: anthropicModel, auth },
      { fetch, unsupported }
    );
    expect(outcome.source).toBe('exa');
    expect(unsupported.size).toBe(0);
  });

  it('原生搜索没有带回任何来源时视为未搜索，降级并记住', async () => {
    const unsupported = new Set<string>();
    const fetch = vi.fn(async (url: string) =>
      url.startsWith('https://mcp.exa.ai')
        ? exaReply()
        : json({
            content: [
              { type: 'web_search_tool_result', tool_use_id: 't1', content: [] },
              { type: 'text', text: 'guess' },
            ],
          })
    );
    const { outcome } = await webSearch(
      'node',
      { model: anthropicModel, auth },
      { fetch, unsupported }
    );
    expect(outcome.source).toBe('exa');
    expect(unsupported.size).toBe(1);
  });

  it('OpenAI Responses 流式原生搜索', async () => {
    const fetch = vi.fn(async () =>
      sse([
        {
          type: 'response.output_item.done',
          item: {
            type: 'web_search_call',
            action: { type: 'search', sources: [{ url: 'https://a.example/', title: 'A' }] },
          },
        },
        { type: 'response.output_text.delta', delta: 'Answer ' },
        { type: 'response.output_text.delta', delta: 'text' },
        {
          type: 'response.output_text.annotation.added',
          annotation: { type: 'url_citation', url: 'https://b.example/', title: 'B' },
        },
        { type: 'response.completed', response: { output: [] } },
      ])
    );
    const { outcome } = await webSearch(
      'q',
      {
        model: {
          provider: 'openai',
          api: 'openai-responses',
          baseUrl: 'https://api.x/v1',
          id: 'm',
        },
        auth,
      },
      { fetch, unsupported: new Set() }
    );
    expect(urlOf(fetch.mock.calls[0])).toBe('https://api.x/v1/responses');
    const init = initOf(fetch, 0);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    expect(JSON.parse(String(init.body))).toMatchObject({
      tools: [{ type: 'web_search' }],
      stream: true,
    });
    expect(outcome).toMatchObject({
      source: 'openai',
      answer: 'Answer text',
      hits: [
        { title: 'A', url: 'https://a.example/' },
        { title: 'B', url: 'https://b.example/' },
      ],
    });
  });

  it('xAI（openai-completions + api.x.ai）走 Responses 原生 web_search', async () => {
    const fetch = vi.fn(async () =>
      sse([
        {
          type: 'response.output_item.done',
          item: {
            type: 'web_search_call',
            action: {
              type: 'search',
              sources: [{ url: 'https://a.example/' }, { url: 'https://b.example/', title: 'B' }],
            },
          },
        },
        { type: 'response.output_text.delta', delta: 'Grok answer' },
      ])
    );
    const { outcome } = await webSearch(
      'q',
      {
        model: {
          provider: 'xai',
          api: 'openai-completions',
          baseUrl: 'https://api.x.ai/v1',
          id: 'grok-4.7',
        },
        auth,
      },
      { fetch, unsupported: new Set() }
    );
    expect(urlOf(fetch.mock.calls[0])).toBe('https://api.x.ai/v1/responses');
    expect(initOf(fetch, 0).method).toBe('POST');
    expect(JSON.parse(String(initOf(fetch, 0).body)).tools).toEqual([{ type: 'web_search' }]);
    expect(outcome).toMatchObject({
      source: 'openai',
      answer: 'Grok answer',
      hits: [
        { title: 'https://a.example/', url: 'https://a.example/' },
        { title: 'B', url: 'https://b.example/' },
      ],
    });
  });

  it('openai-completions 且 baseUrl 不是 api.x.ai 时仍直接走 Exa', async () => {
    const fetch = vi.fn(async () => exaReply());
    const baseUrls = [
      'https://api.deepseek.com/v1',
      'https://proxy.example/openai/v1',
      'https://api.x.ai.evil.com/v1',
      'https://cli-chat-proxy.grok.com/v1',
      'not a url',
    ];
    for (const baseUrl of baseUrls) {
      const { outcome } = await webSearch(
        'q',
        {
          model: { provider: 'p', api: 'openai-completions', baseUrl, id: 'm' },
          auth,
        },
        { fetch, unsupported: new Set() }
      );
      expect(outcome.source).toBe('exa');
    }
    expect(fetch).toHaveBeenCalledTimes(baseUrls.length);
    for (const call of fetch.mock.calls) {
      expect(urlOf(call)).toMatch(/^https:\/\/mcp\.exa\.ai\/mcp/);
      expect(urlOf(call)).not.toContain('/responses');
    }
  });

  it('xAI 端点明确拒绝后记入 unsupported（按模型+端点），本会话不再尝试且不影响其它端点', async () => {
    const unsupported = new Set<string>();
    const xaiModel: SearchModel = {
      provider: 'xai',
      api: 'openai-completions',
      baseUrl: 'https://api.x.ai/v1',
      id: 'grok-4.7',
    };
    const fetch = vi.fn(async (url: string) =>
      url.startsWith('https://mcp.exa.ai') ? exaReply() : json({ error: 'bad request' }, 400)
    );
    const first = await webSearch('q', { model: xaiModel, auth }, { fetch, unsupported });
    expect(first.outcome.source).toBe('exa');
    expect(unsupported.size).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);

    // 第二次：跳过 api.x.ai 直接打 Exa
    await webSearch('q', { model: xaiModel, auth }, { fetch, unsupported });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(urlOf(fetch.mock.calls[2])).toMatch(/^https:\/\/mcp\.exa\.ai\/mcp/);

    // 其它端点（如 deepseek）不受 xAI 的记忆影响
    await webSearch(
      'q',
      {
        model: {
          provider: 'deepseek',
          api: 'openai-completions',
          baseUrl: 'https://api.deepseek.com',
          id: 'm',
        },
        auth,
      },
      { fetch, unsupported }
    );
    expect(unsupported.size).toBe(1);
  });

  it('ChatGPT 订阅走 codex 端点并带账号头', async () => {
    const payload = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } };
    const token = `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
    const fetch = vi.fn(async () =>
      sse([
        {
          type: 'response.output_item.done',
          item: {
            type: 'web_search_call',
            action: { type: 'search', sources: [{ url: 'https://c.example/' }] },
          },
        },
        { type: 'response.output_text.delta', delta: 'ok' },
      ])
    );
    await webSearch(
      'q',
      {
        model: {
          provider: 'openai-codex',
          api: 'openai-codex-responses',
          baseUrl: 'https://chatgpt.com/backend-api',
          id: 'gpt',
        },
        auth: async () => ({ apiKey: token }),
      },
      { fetch, unsupported: new Set() }
    );
    expect(urlOf(fetch.mock.calls[0])).toBe('https://chatgpt.com/backend-api/codex/responses');
    const init = initOf(fetch, 0);
    expect((init.headers as Record<string, string>)['chatgpt-account-id']).toBe('acct-1');
    expect(JSON.parse(String(init.body)).instructions).toBeTruthy();
  });

  it('Gemini 原生搜索解析 grounding', async () => {
    const fetch = vi.fn(async () =>
      json({
        candidates: [
          {
            content: { parts: [{ text: 'Gemini answer' }] },
            groundingMetadata: {
              webSearchQueries: ['q'],
              groundingChunks: [{ web: { uri: 'https://g.example/', title: 'G' } }],
            },
          },
        ],
      })
    );
    const { outcome } = await webSearch(
      'q',
      {
        model: {
          provider: 'gemma',
          api: 'google-generative-ai',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          id: 'gemini-x',
        },
        auth,
      },
      { fetch, unsupported: new Set() }
    );
    expect(urlOf(fetch.mock.calls[0])).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent'
    );
    expect(initOf(fetch, 0).headers).toMatchObject({
      'x-goog-api-key': 'sk-test',
    });
    expect(outcome).toMatchObject({
      source: 'gemini',
      answer: 'Gemini answer',
      hits: [{ title: 'G', url: 'https://g.example/' }],
    });
  });

  it('不支持原生搜索的协议或无模型时直接用 Exa', async () => {
    const fetch = vi.fn(async () => exaReply());
    for (const model of [
      { provider: 'p', api: 'openai-completions', baseUrl: 'https://x', id: 'm' },
      undefined,
    ]) {
      const { outcome } = await webSearch('q', { model, auth }, { fetch, unsupported: new Set() });
      expect(outcome.source).toBe('exa');
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('所有来源都失败时报出每个来源的原因', async () => {
    const fetch = vi.fn(async () => json({ error: 'nope' }, 500));
    await expect(
      webSearch('q', { model: anthropicModel, auth }, { fetch, unsupported: new Set() })
    ).rejects.toThrow(/anthropic.*500[\s\S]*exa.*500/);
  });

  it('Exa 返回无结果的提示文本（如限流）时按失败处理', async () => {
    const limited = () =>
      new Response(
        `data: ${JSON.stringify({ result: { content: [{ type: 'text', text: "You've hit Exa's free MCP rate limit." }] } })}\n\n`,
        { status: 200 }
      );
    const fetch = vi.fn(async () => limited());
    await expect(
      webSearch('q', { model: undefined, auth }, { fetch, unsupported: new Set() })
    ).rejects.toThrow(/exa: You've hit Exa's free MCP rate limit/);
  });

  it('格式化结果带来源与不可信提示', () => {
    const text = formatSearchResult('node', {
      source: 'anthropic',
      answer: 'Node 26',
      hits: [{ title: 'Node.js', url: 'https://nodejs.org/', age: '1d' }],
    });
    expect(text).toContain('Node 26');
    expect(text).toContain('1. [Node.js](https://nodejs.org/) (1d)');
    expect(text).toMatch(/untrusted/i);
  });
});

describe('webSearch 候选链', () => {
  const geminiModel: SearchModel = {
    provider: 'ga',
    api: 'google-generative-ai',
    baseUrl: 'https://generativelanguage.googleapis.com',
    id: 'gemini-x',
  };
  const geminiHit = {
    candidates: [
      {
        content: { parts: [{ text: 'Gemini answer.' }] },
        groundingMetadata: {
          groundingChunks: [{ web: { uri: 'https://example.com/', title: 'Example' } }],
        },
      },
    ],
  };
  const kimiModel: SearchModel = {
    provider: 'kimi',
    api: 'kimi-coding',
    baseUrl: 'https://api.kimi.com/coding',
    id: 'k3',
  };

  it('链非空时依序尝试，首候选成功不试后续', async () => {
    const fetch = vi.fn(async () => json(geminiHit));
    const { outcome, notes } = await webSearch(
      'node',
      { model: anthropicModel, candidates: [geminiModel, anthropicModel], auth },
      { fetch, unsupported: new Set() }
    );
    expect(outcome).toMatchObject({ source: 'gemini', answer: 'Gemini answer.' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(notes.join('\n')).toMatch(/gemini-x/);
  });

  it('首候选失败下移并记录，次候选成功', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.includes('generativelanguage') ? json({ error: 'bad' }, 400) : json(anthropicHit)
    );
    const { outcome, notes } = await webSearch(
      'node',
      { candidates: [geminiModel, anthropicModel], auth },
      { fetch, unsupported: new Set() }
    );
    expect(outcome.source).toBe('anthropic');
    expect(notes.join('\n')).toMatch(/gemini-x.*400/s);
  });

  it('无原生能力的候选跳过并记 note，不消耗请求', async () => {
    const fetch = vi.fn(async () => json(anthropicHit));
    const { outcome, notes } = await webSearch(
      'node',
      { candidates: [kimiModel, anthropicModel], auth },
      { fetch, unsupported: new Set() }
    );
    expect(outcome.source).toBe('anthropic');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(notes.join('\n')).toMatch(/k3/);
  });

  it('unsupported 集合里的候选直接跳过', async () => {
    const unsupported = new Set<string>([
      `ga\nhttps://generativelanguage.googleapis.com\ngemini-x`,
    ]);
    const fetch = vi.fn(async () => json(anthropicHit));
    const { outcome } = await webSearch(
      'node',
      { candidates: [geminiModel, anthropicModel], auth },
      { fetch, unsupported }
    );
    expect(outcome.source).toBe('anthropic');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('全部候选失败落 Exa；Exa 也败报全部摘要', async () => {
    const failing = vi.fn(async (url: string) =>
      url.startsWith('https://mcp.exa.ai') ? exaReply() : json({ error: 'x' }, 500)
    );
    const { outcome, notes } = await webSearch(
      'node',
      { candidates: [geminiModel], auth },
      { fetch: failing, unsupported: new Set() }
    );
    expect(outcome.source).toBe('exa');
    expect(notes.join('\n')).toMatch(/Exa/i);

    const allFail = vi.fn(async (url: string) =>
      url.startsWith('https://mcp.exa.ai')
        ? new Response('rate limited', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          })
        : json({ error: 'x' }, 500)
    );
    await expect(
      webSearch(
        'node',
        { candidates: [geminiModel], auth },
        { fetch: allFail, unsupported: new Set() }
      )
    ).rejects.toThrow(/gemini[\s\S]*exa/i);
  });

  it('空链保持现状：只用会话模型', async () => {
    const fetch = vi.fn(async () => json(anthropicHit));
    const { outcome } = await webSearch(
      'node',
      { model: anthropicModel, candidates: undefined, auth },
      { fetch, unsupported: new Set() }
    );
    expect(outcome.source).toBe('anthropic');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('antigravity grounding 搜索', () => {
  const agModel: SearchModel = {
    provider: 'google-antigravity',
    api: 'google-antigravity',
    baseUrl: '',
    id: 'gemini-3.8-flash',
  };
  const agAuth = async () => ({
    apiKey: JSON.stringify({
      access: 'ya29.test',
      refresh: 'r',
      expires: Date.now() + 3600_000,
      projectId: 'proj-1',
    }),
  });
  const agSse = () =>
    sse([
      {
        response: {
          candidates: [
            {
              content: { parts: [{ text: 'AG answer.' }] },
              groundingMetadata: {
                groundingChunks: [{ web: { uri: 'https://ag.example/', title: 'AG' } }],
              },
            },
          ],
        },
      },
    ]);

  it('CCA 信封 + googleSearch 工具 + Bearer + UA；解析文本与 grounding 来源', async () => {
    const fetch = vi.fn(async () => agSse());
    const { outcome } = await webSearch(
      'node',
      { model: agModel, auth: agAuth },
      { fetch, unsupported: new Set() }
    );
    expect(outcome).toMatchObject({
      source: 'antigravity',
      answer: 'AG answer.',
      hits: [{ title: 'AG', url: 'https://ag.example/' }],
    });
    const url = urlOf(fetch.mock.calls[0]);
    expect(url).toMatch(/cloudcode-pa.*\/v1internal:streamGenerateContent\?alt=sse/);
    const init = initOf(fetch, 0);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ya29.test');
    expect(headers['User-Agent']).toMatch(/^antigravity\//);
    const body = JSON.parse(String(init.body));
    expect(body.project).toBe('proj-1');
    expect(body.requestType).toBe('agent');
    expect(body.userAgent).toBe('antigravity');
    expect(body.request.tools).toEqual([{ googleSearch: {} }]);
    expect(typeof body.model).toBe('string');
    expect(body.requestId).toMatch(/^agent\//);
  });

  it('首个端点网络错误时 fallback 到下一端点；HTTP 错误不 fallback', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockImplementation(async () => agSse());
    const { outcome } = await webSearch(
      'node',
      { model: agModel, auth: agAuth },
      { fetch, unsupported: new Set() }
    );
    expect(outcome.source).toBe('antigravity');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(urlOf(fetch.mock.calls[0])).not.toBe(urlOf(fetch.mock.calls[1]));

    const httpFail = vi.fn(async (url: string) =>
      url.startsWith('https://mcp.exa.ai') ? exaReply() : json({ error: 'forbidden' }, 403)
    );
    const { outcome: fallback } = await webSearch(
      'node',
      { model: agModel, auth: agAuth },
      { fetch: httpFail, unsupported: new Set() }
    );
    expect(fallback.source).toBe('exa');
    // 403 不换端点（1 次 CCA 尝试）+ Exa 1 次
    expect(httpFail).toHaveBeenCalledTimes(2);
  });

  it('凭证过期/非法时该候选失败并下移', async () => {
    const expired = async () => ({
      apiKey: JSON.stringify({ access: 'a', refresh: 'r', expires: 1, projectId: 'p' }),
    });
    const fetch = vi.fn(async () => exaReply());
    const { outcome, notes } = await webSearch(
      'node',
      { model: agModel, auth: expired },
      { fetch, unsupported: new Set() }
    );
    expect(outcome.source).toBe('exa');
    expect(notes.join('\n')).toMatch(/过期|expired/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('registry 物化的 Antigravity 候选（api=google-antigravity-cca）被识别为原生搜索', async () => {
    // 回归：worker modelRegistry 里 Antigravity 模型经 pi composeModelProvider 盖戳后
    // api = 'google-antigravity-cca'（ANTIGRAVITY_API_ID），不是裸 'google-antigravity'。
    // 分类器认不出时候选被「no native web search support」跳过，请求根本发不出去。
    const registryModel: SearchModel = {
      provider: 'google-antigravity',
      api: 'google-antigravity-cca',
      baseUrl: 'https://daily-cloudcode-pa.googleapis.com/',
      id: 'gemini-3.8-flash-high',
    };
    const fetch = vi.fn(async () => agSse());
    const { outcome, notes } = await webSearch(
      'node',
      { candidates: [registryModel], auth: agAuth },
      { fetch, unsupported: new Set() }
    );
    expect(outcome).toMatchObject({ source: 'antigravity', answer: 'AG answer.' });
    expect(notes.join('\n')).not.toMatch(/no native web search support/);
    const url = urlOf(fetch.mock.calls[0]);
    expect(url).toMatch(/cloudcode-pa.*\/v1internal:streamGenerateContent\?alt=sse/);
  });
});
