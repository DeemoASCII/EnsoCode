import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
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
const NEWLINE = 0x0a;
/** `{"seq":N,"id":"…"` 是 appendEntry 写出的固定前缀；建索引时免整行解析 */
const ENTRY_HEAD = /^\{"seq":(\d+),"id":("(?:[^"\\]|\\.)*")/u;

interface IndexedEntry {
  seq: number;
  offset: number;
  length: number;
}

function parseLine(line: Buffer): GroupEntry | undefined {
  if (line.length === 0) return undefined;
  try {
    return parseGroupEntry(JSON.parse(line.toString('utf8')));
  } catch {
    return undefined;
  }
}

/** 按块切出完整行；返回剩余的不完整尾部 */
function* splitLines(
  data: Buffer,
  base: number
): Generator<{ line: Buffer; offset: number }, Buffer> {
  let start = 0;
  for (let i = data.indexOf(NEWLINE); i >= 0; i = data.indexOf(NEWLINE, start)) {
    yield { line: data.subarray(start, i), offset: base + start };
    start = i + 1;
  }
  return data.subarray(start);
}

/** userData/bot-chats/<chatId>/{chat.json, timeline.jsonl, workspace/} */
export class BotChatStore {
  private chats = new Map<string, BotChat>();
  private seqs = new Map<string, number>();
  /** id → 行位置；按需构建，append 时增量维护 */
  private indexes = new Map<string, Map<string, IndexedEntry>>();
  private readonly chunkSize: number;

  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
    options: { chunkSize?: number } = {}
  ) {
    this.chunkSize = Math.max(1, options.chunkSize ?? 64 * 1024);
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
      // 解析缺省为 boss（旧数据不变）；新建群缺省智能选人
      routing: { ...(draft.kind === 'group' ? { mode: 'smart' } : {}), ...draft.routing },
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
    this.indexes.delete(id);
    return true;
  }

  lastSeq(chatId: string): number {
    const cached = this.seqs.get(chatId);
    if (cached !== undefined) return cached;
    let last = 0;
    for (const entry of this.backward(chatId)) {
      last = entry.seq;
      break;
    }
    this.seqs.set(chatId, last);
    return last;
  }

  appendEntry(chatId: string, input: GroupEntryInput): GroupEntry | undefined {
    if (!this.chats.has(chatId)) return undefined;
    const entry = parseGroupEntry({ ...input, seq: this.lastSeq(chatId) + 1 });
    if (!entry) return undefined;
    mkdirSync(this.dir(chatId), { recursive: true });
    const json = JSON.stringify(entry);
    const fd = openSync(this.file(chatId), 'a+', 0o600);
    let offset: number;
    try {
      const size = fstatSync(fd).size;
      const last = Buffer.alloc(1);
      const torn = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== NEWLINE;
      writeSync(fd, `${torn ? '\n' : ''}${json}\n`);
      offset = size + (torn ? 1 : 0);
    } finally {
      closeSync(fd);
    }
    this.seqs.set(chatId, entry.seq);
    this.indexes
      .get(chatId)
      ?.set(entry.id, { seq: entry.seq, offset, length: Buffer.byteLength(json) });
    return entry;
  }

  /** 升序返回 seq < beforeSeq 的最后 limit 条；从文件尾按块倒读 */
  readEntries(chatId: string, options: { beforeSeq?: number; limit?: number } = {}): GroupEntry[] {
    const { beforeSeq = Number.POSITIVE_INFINITY, limit = 100 } = options;
    const entries: GroupEntry[] = [];
    if (limit <= 0) return entries;
    for (const entry of this.backward(chatId)) {
      if (entry.seq >= beforeSeq) continue;
      entries.push(entry);
      if (entries.length >= limit) break;
    }
    return entries.reverse();
  }

  /** 升序返回 seq > afterSeq 的全部条目（倒读到 afterSeq 为止） */
  readAfter(chatId: string, afterSeq: number): GroupEntry[] {
    const entries: GroupEntry[] = [];
    for (const entry of this.backward(chatId)) {
      if (entry.seq <= afterSeq) break;
      entries.push(entry);
    }
    return entries.reverse();
  }

  /** 从新到旧逐条产出；提前 break 即停止读盘 */
  *backward(chatId: string): Generator<GroupEntry> {
    if (!isBotChatId(chatId)) return;
    let fd: number;
    try {
      fd = openSync(this.file(chatId), 'r');
    } catch {
      return;
    }
    try {
      let position = fstatSync(fd).size;
      let carry = Buffer.alloc(0);
      let floor = Number.POSITIVE_INFINITY;
      const emit = (line: Buffer) => {
        const entry = parseLine(line);
        if (!entry || entry.seq >= floor) return undefined;
        floor = entry.seq;
        return entry;
      };
      while (position > 0) {
        const size = Math.min(this.chunkSize, position);
        position -= size;
        const chunk = Buffer.allocUnsafe(size);
        readSync(fd, chunk, 0, size, position);
        const data = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
        let end = data.length;
        while (end > 0) {
          const at = data.lastIndexOf(NEWLINE, end - 1);
          if (at < 0) break;
          const entry = emit(data.subarray(at + 1, end));
          if (entry) yield entry;
          end = at;
        }
        carry = Buffer.from(data.subarray(0, end));
      }
      const entry = emit(carry);
      if (entry) yield entry;
    } finally {
      closeSync(fd);
    }
  }

  /** 全量顺序扫描（异步分块，不长时间占用主线程）；每块产出一批 */
  async *scanEntries(chatId: string): AsyncGenerator<GroupEntry[]> {
    if (!isBotChatId(chatId)) return;
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.file(chatId), 'r');
    } catch {
      return;
    }
    try {
      let carry = Buffer.alloc(0);
      let last = 0;
      const size = Math.max(this.chunkSize, 256 * 1024);
      for (;;) {
        const chunk = Buffer.allocUnsafe(size);
        const { bytesRead } = await handle.read(chunk, 0, size, null);
        const data = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
        const batch: GroupEntry[] = [];
        const take = (line: Buffer) => {
          const entry = parseLine(line);
          if (!entry || entry.seq <= last) return;
          last = entry.seq;
          batch.push(entry);
        };
        const lines = splitLines(data, 0);
        let step = lines.next();
        for (; !step.done; step = lines.next()) take(step.value.line);
        carry = Buffer.from(step.value);
        if (bytesRead === 0) take(carry);
        if (batch.length > 0) yield batch;
        if (bytesRead === 0) return;
      }
    } finally {
      await handle.close();
    }
  }

  hasEntry(chatId: string, id: string): boolean {
    return this.index(chatId).has(id);
  }

  findEntry(chatId: string, id: string): GroupEntry | undefined {
    const hit = this.index(chatId).get(id);
    if (!hit) return undefined;
    let fd: number;
    try {
      fd = openSync(this.file(chatId), 'r');
    } catch {
      return undefined;
    }
    try {
      const line = Buffer.allocUnsafe(hit.length);
      readSync(fd, line, 0, hit.length, hit.offset);
      const entry = parseLine(line);
      return entry?.id === id ? entry : undefined;
    } finally {
      closeSync(fd);
    }
  }

  /** 首次使用时顺序扫一遍建 id 索引（只取行首 seq/id，不整行解析） */
  private index(chatId: string): Map<string, IndexedEntry> {
    const cached = this.indexes.get(chatId);
    if (cached) return cached;
    const index = new Map<string, IndexedEntry>();
    if (!isBotChatId(chatId)) return index;
    let fd: number;
    try {
      fd = openSync(this.file(chatId), 'r');
    } catch {
      this.indexes.set(chatId, index);
      return index;
    }
    try {
      let last = 0;
      let carry = Buffer.alloc(0);
      let base = 0;
      const size = Math.max(this.chunkSize, 256 * 1024);
      const add = (line: Buffer, offset: number) => {
        const head = indexHead(line);
        if (!head || head.seq <= last) return;
        last = head.seq;
        index.set(head.id, { seq: head.seq, offset, length: line.length });
      };
      for (;;) {
        const chunk = Buffer.allocUnsafe(size);
        const bytesRead = readSync(fd, chunk, 0, size, null);
        const data = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
        const lines = splitLines(data, base);
        let step = lines.next();
        for (; !step.done; step = lines.next()) add(step.value.line, step.value.offset);
        const consumed = data.length - step.value.length;
        if (bytesRead === 0) {
          add(step.value, base + consumed);
          break;
        }
        carry = Buffer.from(step.value);
        base += consumed;
      }
    } finally {
      closeSync(fd);
    }
    this.indexes.set(chatId, index);
    return index;
  }

  private file(chatId: string): string {
    return join(this.dir(chatId), TIMELINE);
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

function indexHead(line: Buffer): { seq: number; id: string } | undefined {
  if (line.length === 0 || line[line.length - 1] !== 0x7d) return undefined;
  const match = ENTRY_HEAD.exec(line.toString('utf8', 0, Math.min(line.length, 256)));
  if (match) {
    try {
      const id = JSON.parse(match[2]) as string;
      const seq = Number(match[1]);
      if (id && Number.isSafeInteger(seq)) return { seq, id };
    } catch {
      /* fall through */
    }
  }
  const entry = parseLine(line);
  return entry && { seq: entry.seq, id: entry.id };
}
