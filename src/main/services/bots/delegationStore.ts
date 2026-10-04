import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Delegation, parseDelegation } from '../../../shared/types/bot';
import { writeAtomic } from './files';

const DAY = 86_400_000;
const TERMINAL = new Set<Delegation['state']>(['completed', 'failed', 'canceled']);

export interface DelegationStoreOptions {
  now?: () => number;
  /** 已投递的终态记录保留时长（按 deliveredAt），超出后移入 delegations.archive.jsonl */
  retentionMs?: number;
  /** 冗余行（被后写覆盖的旧快照、坏行）达到 max(此值, 记录数) 时重写为最新快照 */
  minRedundant?: number;
}

/** delegations.jsonl：append-only 整条快照，后写覆盖；加载与追加时按冗余度原子压缩 */
export class DelegationStore {
  private readonly records = new Map<string, Delegation>();
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly minRedundant: number;
  private lines = 0;

  constructor(
    private readonly file: string,
    options: DelegationStoreOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? 30 * DAY;
    this.minRedundant = options.minRedundant ?? 500;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      this.lines++;
      try {
        const record = parseDelegation(JSON.parse(line));
        if (record) this.records.set(record.id, record);
      } catch {
        /* torn or invalid line */
      }
    }
    const cutoff = this.now() - this.retentionMs;
    const expired = [...this.records.values()].filter(
      (record) =>
        TERMINAL.has(record.state) &&
        record.deliveredAt !== undefined &&
        record.deliveredAt < cutoff
    );
    if (expired.length > 0 || this.redundant()) this.compact(expired);
  }
  list(chatId?: string): Delegation[] {
    return [...this.records.values()]
      .filter((record) => chatId === undefined || record.chatId === chatId)
      .map((record) => ({ ...record }));
  }
  get(id: string): Delegation | undefined {
    const record = this.records.get(id);
    return record && { ...record };
  }
  save(record: Delegation): void {
    const parsed = parseDelegation(record);
    if (!parsed) throw new Error('Invalid delegation record');
    mkdirSync(dirname(this.file), { recursive: true });
    // Leading newline also isolates any torn last line from the next valid record.
    appendFileSync(this.file, `\n${JSON.stringify(parsed)}\n`, 'utf8');
    this.records.set(parsed.id, parsed);
    this.lines++;
    if (this.redundant()) this.compact([]);
  }

  private redundant(): boolean {
    return this.lines - this.records.size >= Math.max(this.minRedundant, this.records.size);
  }

  /** 先追加归档、再原子替换主文件；任一步失败都保留原文件，下次再试 */
  private compact(expired: readonly Delegation[]): void {
    try {
      if (expired.length > 0)
        appendFileSync(
          join(dirname(this.file), 'delegations.archive.jsonl'),
          `${expired.map((record) => JSON.stringify(record)).join('\n')}\n`,
          { encoding: 'utf8', mode: 0o600 }
        );
      const kept = [...this.records.values()].filter((record) => !expired.includes(record));
      const snapshot = kept.map((record) => JSON.stringify(record));
      writeAtomic(this.file, snapshot.length > 0 ? `${snapshot.join('\n')}\n` : '');
      for (const record of expired) this.records.delete(record.id);
      this.lines = snapshot.length;
    } catch (error) {
      console.warn('[bots] delegations compaction failed', error);
    }
  }
}
