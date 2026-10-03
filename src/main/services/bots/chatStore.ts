import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type BotChat,
  type BotChatWorkspace,
  type GroupEntry,
  type GroupEntryInput,
  isBotChatId,
  parseBotChat,
  parseGroupEntry,
} from '../../../shared/types/bot';
import { readJson, writeJsonAtomic } from './files';

export interface BotChatDraft {
  kind: BotChat['kind'];
  title: string;
  members: string[];
  bossBotId: string | null;
  workspace: BotChatWorkspace;
  routing?: Partial<BotChat['routing']>;
}

const TIMELINE = 'timeline.jsonl';

/** userData/bot-chats/<chatId>/{chat.json, timeline.jsonl, workspace/} */
export class BotChatStore {
  private chats = new Map<string, BotChat>();
  private seqs = new Map<string, number>();

  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now
  ) {
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      return;
    }
    for (const name of names) {
      if (!isBotChatId(name)) continue;
      const chat = parseBotChat(readJson(join(root, name, 'chat.json')));
      if (chat?.id === name) this.chats.set(name, chat);
    }
  }

  list(): BotChat[] {
    return [...this.chats.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): BotChat | undefined {
    return this.chats.get(id);
  }

  workspaceDir(id: string): string {
    return join(this.dir(id), 'workspace');
  }

  create(draft: BotChatDraft, id: string = randomUUID()): BotChat | undefined {
    const at = this.now();
    const chat = parseBotChat({
      ...draft,
      id,
      pinned: false,
      sessions: {},
      createdAt: at,
      updatedAt: at,
      version: 1,
    });
    if (!chat) return undefined;
    this.persist(chat);
    return chat;
  }

  /** mutate 的结果整体重新校验；id、createdAt 不可改 */
  update(id: string, mutate: (draft: BotChat) => BotChat): BotChat | undefined {
    const current = this.chats.get(id);
    if (!current) return undefined;
    const next = mutate(structuredClone(current));
    if (next.id !== id) return undefined;
    const chat = parseBotChat({
      ...next,
      createdAt: current.createdAt,
      updatedAt: this.now(),
      version: current.version + 1,
    });
    if (!chat) return undefined;
    this.persist(chat);
    return chat;
  }

  remove(id: string): boolean {
    if (!isBotChatId(id) || !this.chats.has(id)) return false;
    rmSync(this.dir(id), { recursive: true, force: true });
    this.chats.delete(id);
    this.seqs.delete(id);
    return true;
  }

  lastSeq(chatId: string): number {
    const cached = this.seqs.get(chatId);
    if (cached !== undefined) return cached;
    const last = this.readAll(chatId).at(-1)?.seq ?? 0;
    this.seqs.set(chatId, last);
    return last;
  }

  appendEntry(chatId: string, input: GroupEntryInput): GroupEntry | undefined {
    if (!this.chats.has(chatId)) return undefined;
    const entry = parseGroupEntry({ ...input, seq: this.lastSeq(chatId) + 1 });
    if (!entry) return undefined;
    const file = join(this.dir(chatId), TIMELINE);
    mkdirSync(this.dir(chatId), { recursive: true });
    appendFileSync(file, `${this.needsNewline(file) ? '\n' : ''}${JSON.stringify(entry)}\n`, {
      mode: 0o600,
    });
    this.seqs.set(chatId, entry.seq);
    return entry;
  }

  /** 升序返回 seq < beforeSeq 的最后 limit 条 */
  readEntries(chatId: string, options: { beforeSeq?: number; limit?: number } = {}): GroupEntry[] {
    const { beforeSeq = Number.POSITIVE_INFINITY, limit = 100 } = options;
    const entries = this.readAll(chatId).filter((entry) => entry.seq < beforeSeq);
    return entries.slice(Math.max(0, entries.length - limit));
  }

  private readAll(chatId: string): GroupEntry[] {
    if (!isBotChatId(chatId)) return [];
    let raw = '';
    try {
      raw = readFileSync(join(this.dir(chatId), TIMELINE), 'utf8');
    } catch {
      return [];
    }
    const entries: GroupEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let parsed: GroupEntry | undefined;
      try {
        parsed = parseGroupEntry(JSON.parse(line));
      } catch {
        continue;
      }
      if (parsed && parsed.seq > (entries.at(-1)?.seq ?? 0)) entries.push(parsed);
    }
    return entries;
  }

  private needsNewline(file: string): boolean {
    let fd: number | undefined;
    try {
      fd = openSync(file, 'r');
      const size = fstatSync(fd).size;
      if (size === 0) return false;
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      return last[0] !== 0x0a;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private persist(chat: BotChat): void {
    writeJsonAtomic(join(this.dir(chat.id), 'chat.json'), chat);
    this.chats.set(chat.id, chat);
  }

  private dir(id: string): string {
    if (!isBotChatId(id)) throw new Error('Invalid chat id');
    return join(this.root, id);
  }
}
