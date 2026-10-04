import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * EnsoBot 前端自动化测试用的假模型（anthropic-messages 兼容，SSE 流式）。
 *
 * 行为按 prompt 里宿主写入的上下文决定，模拟一支按主持人模式工作的团队：
 * - 没点名交给主持人 → 主持人 @ 另一位成员分工
 * - bot 转来的点名 → 先调一次只读工具（产生工作记录），再回复
 * - 汇总提醒 → 主持人给结论
 * - 私聊 → 自我介绍；带 E2E_APPROVAL → 调一条需要审批的命令
 *
 * 故意分段、延迟输出，让界面上的“正在思考/调用工具”状态真的出现一会儿。
 */

export interface FakeModelRequest {
  at: number;
  persona: string;
  prompt: string;
  afterTool: boolean;
}

export interface FakeModel {
  url: string;
  requests: FakeModelRequest[];
  close(): Promise<void>;
}

type Block = { type?: string; text?: string; content?: unknown; name?: string };
type Message = { role?: string; content?: string | Block[] };
type Reply =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: Record<string, unknown> };

const BOT_RELAY = '不是用户本人';
const SHELL_TOOL = process.platform === 'win32' ? 'powershell' : 'bash';

function blocks(message: Message | undefined): Block[] {
  if (!message) return [];
  return typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : (message.content ?? []);
}

function textOf(message: Message | undefined): string {
  return blocks(message)
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .join('\n');
}

function resultText(block: Block): string {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return (block.content as Block[]).map((item) => item.text ?? '').join('\n');
  }
  return '';
}

/** 群上下文里的成员名单：「- 名字（你，主持人）：职能」。 */
function rosterOthers(prompt: string): string[] {
  const names: string[] = [];
  const lines = prompt.split('\n');
  const start = lines.indexOf('成员：');
  if (start < 0) return names;
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('- ')) break;
    const match = /^- ([^（：\n]+?)(（([^）]*)）)?(：|$)/.exec(line);
    if (!match || match[3]?.split('，').includes('你')) continue;
    names.push(match[1].trim());
  }
  return names;
}

export function decideReply(messages: Message[]): Reply {
  const last = messages.at(-1);
  const all = messages.map(textOf).join('\n');
  const persona = /人设\n([^\n]+)/.exec(all)?.[1]?.trim() || 'Bot';
  const results = blocks(last).filter((block) => block.type === 'tool_result');
  if (results.length) {
    const output = results.map(resultText).join('\n').trim();
    if (all.includes('E2E_APPROVAL'))
      return { kind: 'text', text: `命令跑完了：${output.split('\n').at(-1)}` };
    return { kind: 'text', text: '我看过了，没有问题。' };
  }
  const prompt = textOf(last);
  if (prompt.includes('E2E_APPROVAL')) {
    return {
      kind: 'tool',
      name: SHELL_TOOL,
      input: {
        command:
          process.platform === 'win32'
            ? "Write-Output ('x' * 20000); Write-Output E2E_APPROVED"
            : "printf '%020000d\\n' 0; echo E2E_APPROVED",
      },
    };
  }
  if (prompt.includes('你分派的成员都回复了')) {
    return { kind: 'text', text: '汇总：成员都核对过了，**结论是可以继续**。' };
  }
  if (prompt.includes('[群聊「')) {
    if (prompt.includes('没有点名，先交给主持人')) {
      const other = rosterOthers(prompt)[0];
      return {
        kind: 'text',
        text: other ? `好的，我来分工。@${other} 请你先核对一下。` : '好的，我来处理。',
      };
    }
    if (prompt.includes(BOT_RELAY)) return { kind: 'tool', name: 'ls', input: { path: '.' } };
    return { kind: 'text', text: `收到，我是${persona}。` };
  }
  return { kind: 'text', text: `你好，我是${persona}。` };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function event(res: ServerResponse, data: Record<string, unknown>): void {
  res.write(`event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function stream(res: ServerResponse, reply: Reply, delayMs: number): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  event(res, {
    type: 'message_start',
    message: {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: 'fake-model-1',
      content: [],
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  await sleep(delayMs);
  if (reply.kind === 'tool') {
    event(res, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: `toolu_${Date.now()}`, name: reply.name, input: {} },
    });
    event(res, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.input) },
    });
    event(res, { type: 'content_block_stop', index: 0 });
    event(res, {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 5 },
    });
  } else {
    event(res, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    const half = Math.ceil(reply.text.length / 2);
    for (const piece of [reply.text.slice(0, half), reply.text.slice(half)]) {
      event(res, {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: piece },
      });
      await sleep(delayMs / 2);
    }
    event(res, { type: 'content_block_stop', index: 0 });
    event(res, {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 5 },
    });
  }
  event(res, { type: 'message_stop' });
  res.end();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startFakeModel(options?: { delayMs?: number }): Promise<FakeModel> {
  const delayMs = options?.delayMs ?? 500;
  const requests: FakeModelRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      if ((req.url ?? '').includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'fake-model-1' }] }));
        return;
      }
      let parsed: { messages?: Message[] } = {};
      try {
        parsed = JSON.parse(body) as { messages?: Message[] };
      } catch {
        res.writeHead(400).end('bad json');
        return;
      }
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const all = messages.map(textOf).join('\n');
      requests.push({
        at: Date.now(),
        persona: /人设\n([^\n]+)/.exec(all)?.[1]?.trim() ?? '',
        prompt: textOf(messages.at(-1)),
        afterTool: blocks(messages.at(-1)).some((block) => block.type === 'tool_result'),
      });
      await stream(res, decideReply(messages), delayMs);
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
