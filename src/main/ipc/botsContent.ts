import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ProjectedMessage } from '@shared/types/agent';
import type {
  BotActionResult,
  BotArtifact,
  BotArtifactOpenAction,
  BotArtifactReadResult,
  BotArtifactsResult,
  BotSearchResult,
} from '@shared/types/botIpc';
import { app, BrowserWindow, shell } from 'electron';
import {
  artifactCandidates,
  isOpenableArtifact,
  parseArtifactTarget,
  resolveArtifactFile,
  resolveArtifacts,
  turnBounds,
  turnOfReply,
} from '../services/bots/artifacts';
import type { BotSessionHost } from '../services/bots/botSessionHost';
import { parseChatSearchQuery, searchBotChats } from '../services/bots/chatSearch';
import type { BotChatStore } from '../services/bots/chatStore';
import { readBotSessionMessages } from '../services/bots/sessionMessages';
import { getSourceAuthorityRegistry } from './agent';

interface ContentServices {
  chats: BotChatStore;
  host: BotSessionHost;
}

const INVALID = { ok: false as const, error: 'invalid' };
const IMAGE_MAX = 20 * 1024 * 1024;
const TEXT_MAX = 2 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};
const ACTIONS: readonly BotArtifactOpenAction[] = ['reveal', 'open', 'preview'];

const sessionDir = () => path.join(app.getPath('userData'), 'agent', 'sessions');
const readMessages = (sessionFile: string | undefined) =>
  readBotSessionMessages(sessionDir(), sessionFile);

export async function searchChats(
  { chats, host }: ContentServices,
  request: unknown
): Promise<BotSearchResult> {
  const input = parseChatSearchQuery(request);
  if (!input) return INVALID;
  const authority = getSourceAuthorityRegistry();
  const result = await searchBotChats(
    {
      chats: () => chats.list(),
      timeline: (chatId) => chats.readEntries(chatId, { limit: Number.MAX_SAFE_INTEGER }),
      sessions: (chatId) =>
        host.sessionsOf(chatId).map((session) => ({
          ...session,
          sessionFile: authority?.conversation(session.conversationId)?.sessionFile,
        })),
      readMessages,
    },
    input
  );
  return { ok: true, ...result };
}

/** 由聊天 + 条目 / 会话消息标识推导该轮消息与工作区根；会话必须属于该聊天 */
async function artifactsOf(
  { chats }: ContentServices,
  request: unknown
): Promise<{ root: string; artifacts: BotArtifact[] } | null> {
  const target = parseArtifactTarget(request);
  const chat = target ? chats.get(target.chatId) : undefined;
  if (!target || !chat) return null;
  let conversationId: string;
  let locate: (messages: readonly ProjectedMessage[]) => { start: number; end: number } | null;
  let fallback: readonly ProjectedMessage[] = [];
  if ('entryId' in target) {
    if (chat.kind !== 'group') return null;
    const entry = chats
      .readEntries(chat.id, { limit: Number.MAX_SAFE_INTEGER })
      .find((item) => item.id === target.entryId);
    if (entry?.kind !== 'bot') return null;
    conversationId = entry.conversationId;
    locate = (messages) => turnOfReply(messages, entry.text);
    fallback = [{ role: 'assistant', content: [{ type: 'text', text: entry.text }] }];
  } else {
    if (chat.kind !== 'direct') return null;
    conversationId = target.conversationId;
    locate = (messages) => turnBounds(messages, target.messageIndex);
  }
  const authority = getSourceAuthorityRegistry();
  const conversation = authority?.conversation(conversationId);
  if (conversation?.bot?.chatId !== chat.id) return null;
  const project = authority?.project(conversation.projectId);
  if (!project || project.kind === 'ssh') return null;
  let turn = fallback;
  try {
    const messages = await readMessages(conversation.sessionFile);
    const range = locate(messages);
    if (range) turn = messages.slice(range.start, range.end);
  } catch {
    // 会话文件缺失 / 损坏：群条目仍可按回复正文提到的路径出卡片
  }
  return {
    root: project.canonicalPath,
    artifacts: resolveArtifacts(project.canonicalPath, artifactCandidates(turn)),
  };
}

export async function listArtifacts(
  services: ContentServices,
  request: unknown
): Promise<BotArtifactsResult> {
  const found = await artifactsOf(services, request);
  return found ? { ok: true, artifacts: found.artifacts } : INVALID;
}

/** rel 必须出现在 Main 重新推导的该条产物清单里，再按工作区根二次校验 */
async function artifactFile(
  services: ContentServices,
  request: unknown
): Promise<{ file: string; artifact: BotArtifact } | null> {
  const rel =
    request && typeof request === 'object' ? (request as Record<string, unknown>).rel : undefined;
  if (typeof rel !== 'string' || !rel) return null;
  const found = await artifactsOf(services, request);
  const artifact = found?.artifacts.find((item) => item.rel === rel);
  const file = artifact && found ? resolveArtifactFile(found.root, artifact.rel) : null;
  return file && artifact ? { file, artifact } : null;
}

export async function readArtifact(
  services: ContentServices,
  request: unknown
): Promise<BotArtifactReadResult> {
  const target = await artifactFile(services, request);
  if (!target) return INVALID;
  const { file, artifact } = target;
  const size = statSync(file).size;
  if (artifact.kind === 'image') {
    if (size > IMAGE_MAX) return { ok: false, error: 'too-large' };
    const mime = IMAGE_MIME[path.extname(file).slice(1).toLowerCase()] ?? 'image/png';
    return {
      ok: true,
      kind: 'image',
      dataUrl: `data:${mime};base64,${readFileSync(file).toString('base64')}`,
    };
  }
  if (artifact.kind === 'markdown' || artifact.kind === 'html' || artifact.kind === 'text') {
    if (size > TEXT_MAX) return { ok: false, error: 'too-large' };
    return { ok: true, kind: artifact.kind, text: readFileSync(file, 'utf8') };
  }
  return { ok: false, error: 'unsupported' };
}

/** PDF 走独立窗口的内置查看器：无 preload、沙箱、禁止新窗口与跳转 */
function openPdfWindow(file: string, title: string): void {
  const win = new BrowserWindow({
    width: 900,
    height: 1100,
    title,
    autoHideMenuBar: true,
    webPreferences: {
      plugins: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  void win.loadFile(file);
}

export async function openArtifact(
  services: ContentServices,
  request: unknown
): Promise<BotActionResult> {
  const action =
    request && typeof request === 'object'
      ? (request as Record<string, unknown>).action
      : undefined;
  if (!ACTIONS.includes(action as BotArtifactOpenAction)) return INVALID;
  const target = await artifactFile(services, request);
  if (!target) return INVALID;
  const { file, artifact } = target;
  if (action === 'reveal') {
    shell.showItemInFolder(file);
    return { ok: true };
  }
  if (action === 'preview') {
    if (artifact.kind !== 'pdf') return { ok: false, error: 'unsupported' };
    openPdfWindow(file, artifact.name);
    return { ok: true };
  }
  if (!isOpenableArtifact(artifact.name, statSync(file).mode)) {
    return { ok: false, error: 'not-openable' };
  }
  const failure = await shell.openPath(file);
  return failure ? { ok: false, error: failure } : { ok: true };
}
