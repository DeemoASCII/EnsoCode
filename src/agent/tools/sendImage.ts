import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  SEND_IMAGE_CAPTION_MAX,
  SEND_IMAGE_PER_REPLY,
  sendImageItems,
} from '@shared/bots/sendImage';
import type { DelegationOp } from './delegation';
import type { MemoryInvoker } from './memory';

const PATH_ALIASES = [
  'file',
  'file_path',
  'filePath',
  'image',
  'image_path',
  'imagePath',
  'filename',
];
const CAPTION_ALIASES = ['text', 'description', 'message', 'alt', 'title'];
const LATEST = new Set(['latest', 'last', 'recent', 'newest']);

function screenshotIndex(value: unknown): unknown {
  if (value === true) return 1;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : value;
  if (typeof value !== 'string') return value;
  const text = value.trim().toLowerCase();
  if (LATEST.has(text)) return 1;
  return /^\d+$/.test(text) ? Number(text) : value;
}

/** schema 校验前归一化：别名键、截图简写 → 序号、工作区内绝对路径 → 相对路径、空值删除 */
export function normalizeSendImageParams(raw: unknown, cwd: string): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const params = { ...raw } as Record<string, unknown>;
  for (const [aliases, key] of [
    [PATH_ALIASES, 'path'],
    [CAPTION_ALIASES, 'caption'],
  ] as const) {
    for (const alias of aliases) {
      if (!(alias in params)) continue;
      if (params[key] === undefined || params[key] === null) params[key] = params[alias];
      delete params[alias];
    }
  }
  if (params.screenshot === false || params.screenshot === null) delete params.screenshot;
  else if (params.screenshot !== undefined) params.screenshot = screenshotIndex(params.screenshot);
  if (typeof params.path === 'string') {
    const file = params.path.trim();
    const rel = path.isAbsolute(file) ? path.relative(cwd, file) : file;
    params.path = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
  }
  if (typeof params.caption === 'string') params.caption = params.caption.trim();
  for (const key of ['path', 'caption'])
    if (params[key] === null || params[key] === undefined || params[key] === '') delete params[key];
  return params;
}

interface BranchEntry {
  type?: string;
  message?: { role: string; toolName?: string; content: unknown };
}

/** 本条回复（最后一条 user 消息之后）已发出的图片数 */
function sentThisReply(branch: readonly BranchEntry[]): number {
  const messages: NonNullable<BranchEntry['message']>[] = [];
  for (let i = branch.length - 1; i >= 0; i--) {
    const message = branch[i].type === 'message' ? branch[i].message : undefined;
    if (!message) continue;
    if (message.role === 'user') break;
    messages.unshift(message);
  }
  return sendImageItems(messages).length;
}

const errorResult = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  details: undefined,
  isError: true,
});

export function createSendImageTool(
  invoker: MemoryInvoker<DelegationOp>,
  cwd: string
): ToolDefinition {
  const normalize = (raw: unknown) => normalizeSendImageParams(raw, cwd);
  let inflight = 0;
  return {
    name: 'send_image',
    label: 'send_image',
    description: `Post an image into this chat under your reply, so the user sees it inline (they cannot see your tool screenshots otherwise). Pass exactly one of: path = an image file inside the workspace (relative path; PNG/JPEG/GIF/WebP), or screenshot = 1|2|3 to send one of your 3 most recent browser_screenshot/computer screenshots (1 = most recent). Optional caption. At most ${SEND_IMAGE_PER_REPLY} images per reply; only send what the user asked for or clearly needs. Desktop (computer) screenshots may show other windows: check before sending. Call it directly, not from a codemode script. Do not paste the returned mediaId into your reply text.`,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          maxLength: 1024,
          description: 'Workspace-relative image path',
        },
        screenshot: {
          type: 'integer',
          minimum: 1,
          maximum: 3,
          description: '1 = most recent screenshot',
        },
        caption: { type: 'string', maxLength: SEND_IMAGE_CAPTION_MAX },
      },
      required: [],
      additionalProperties: false,
    } as unknown as ToolDefinition['parameters'],
    prepareArguments: normalize as ToolDefinition['prepareArguments'],
    async execute(_id, raw, signal, _onUpdate, ctx) {
      const params = normalize(raw) as Record<string, unknown>;
      if ((params.path === undefined) === (params.screenshot === undefined))
        return errorResult('Pass exactly one of path or screenshot.');
      const branch = (ctx?.sessionManager?.getBranch?.() ?? []) as BranchEntry[];
      if (sentThisReply(branch) + inflight >= SEND_IMAGE_PER_REPLY)
        return errorResult(
          `At most ${SEND_IMAGE_PER_REPLY} images per reply; this one was not sent.`
        );
      inflight++;
      try {
        const result = await invoker.invoke('send_image', params, signal);
        const ok = Boolean(result && typeof result === 'object' && (result as { ok?: unknown }).ok);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: undefined,
          ...(ok ? {} : { isError: true }),
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      } finally {
        inflight--;
      }
    },
  };
}
