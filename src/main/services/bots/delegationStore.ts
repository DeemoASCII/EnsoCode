import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Delegation, parseDelegation } from '../../../shared/types/bot';

export class DelegationStore {
  private readonly records = new Map<string, Delegation>();
  constructor(private readonly file: string) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      try {
        const record = parseDelegation(JSON.parse(line));
        if (record) this.records.set(record.id, record);
      } catch {
        /* torn or invalid line */
      }
    }
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
  }
}
