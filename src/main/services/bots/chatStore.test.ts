import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotChatStore } from './chatStore';

const BOT_A = '11111111-1111-4111-8111-111111111111';
const BOT_B = '22222222-2222-4222-8222-222222222222';

let root: string;
let store: BotChatStore;
let clock = 1000;
const now = () => ++clock;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bot-chats-'));
  store = new BotChatStore(root, now);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function group() {
  const created = store.create({
    kind: 'group',
    title: '发布小组',
    members: [BOT_A, BOT_B],
    bossBotId: BOT_A,
    workspace: { kind: 'project', projectId: 'p1' },
  });
  if (!created) throw new Error('create failed');
  return created;
}

describe('BotChatStore chats', () => {
  it('creates, reloads and rejects invalid chats', () => {
    const chat = group();
    expect(chat).toMatchObject({
      routing: { maxHops: 4, maxTurnsPerBot: 2 },
      sessions: {},
      version: 1,
    });
    expect(new BotChatStore(root, now).get(chat.id)).toEqual(chat);
    expect(
      store.create({
        kind: 'group',
        title: 'x',
        members: [BOT_A],
        bossBotId: BOT_A,
        workspace: { kind: 'project', projectId: 'p' },
      })
    ).toBeUndefined();
  });

  it('updates through a validated mutation and bumps version', () => {
    const chat = group();
    const updated = store.update(chat.id, (draft) => ({
      ...draft,
      sessions: { [BOT_A]: { conversationId: 'c1', cursor: 2 } },
    }));
    expect(updated).toMatchObject({
      version: 2,
      sessions: { [BOT_A]: { conversationId: 'c1', cursor: 2 } },
    });
    expect(store.update(chat.id, (draft) => ({ ...draft, members: [BOT_A] }))).toBeUndefined();
    expect(store.get(chat.id)?.members).toEqual([BOT_A, BOT_B]);
    expect(store.update(chat.id, (draft) => ({ ...draft, id: 'other' }))).toBeUndefined();
  });

  it('removes the chat directory', () => {
    const chat = group();
    store.appendEntry(chat.id, { id: 'e1', at: 1, kind: 'system', text: 'hi' });
    expect(store.remove(chat.id)).toBe(true);
    expect(store.get(chat.id)).toBeUndefined();
    expect(store.readEntries(chat.id)).toEqual([]);
  });
});

describe('BotChatStore timeline', () => {
  it('assigns increasing seq that survives restart', () => {
    const chat = group();
    const first = store.appendEntry(chat.id, {
      id: 'e1',
      at: 1,
      kind: 'human',
      text: 'hi',
      mentions: [],
    });
    const second = store.appendEntry(chat.id, { id: 'e2', at: 2, kind: 'system', text: 'x' });
    expect([first?.seq, second?.seq]).toEqual([1, 2]);

    const reloaded = new BotChatStore(root, now);
    expect(reloaded.lastSeq(chat.id)).toBe(2);
    expect(reloaded.appendEntry(chat.id, { id: 'e3', at: 3, kind: 'system', text: 'y' })?.seq).toBe(
      3
    );
  });

  it('rejects invalid entries and unknown chats', () => {
    const chat = group();
    expect(
      store.appendEntry(chat.id, { id: '', at: 1, kind: 'system', text: 'x' })
    ).toBeUndefined();
    expect(
      store.appendEntry('77777777-7777-4777-8777-777777777777', {
        id: 'e',
        at: 1,
        kind: 'system',
        text: 'x',
      })
    ).toBeUndefined();
    expect(store.lastSeq(chat.id)).toBe(0);
  });

  it('tolerates corrupt and truncated lines', () => {
    const chat = group();
    store.appendEntry(chat.id, { id: 'e1', at: 1, kind: 'system', text: 'a' });
    appendFileSync(
      join(root, chat.id, 'timeline.jsonl'),
      'garbage\n{"seq":2,"id":"e2","at":2,"kind":"sys'
    );

    const reloaded = new BotChatStore(root, now);
    expect(reloaded.lastSeq(chat.id)).toBe(1);
    expect(reloaded.appendEntry(chat.id, { id: 'e3', at: 3, kind: 'system', text: 'c' })?.seq).toBe(
      2
    );
    expect(reloaded.readEntries(chat.id).map((entry) => entry.id)).toEqual(['e1', 'e3']);
  });

  it('pages backwards by seq', () => {
    const chat = group();
    for (let i = 1; i <= 5; i++)
      store.appendEntry(chat.id, { id: `e${i}`, at: i, kind: 'system', text: String(i) });
    expect(store.readEntries(chat.id, { limit: 2 }).map((entry) => entry.seq)).toEqual([4, 5]);
    expect(
      store.readEntries(chat.id, { beforeSeq: 4, limit: 2 }).map((entry) => entry.seq)
    ).toEqual([2, 3]);
    expect(
      store.readEntries(chat.id, { beforeSeq: 2, limit: 10 }).map((entry) => entry.seq)
    ).toEqual([1]);
  });
});
