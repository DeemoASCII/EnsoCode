import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolveSpaceIds } from '../memory/space';
import { BotMemoryService } from './botMemory';
import { BotStore } from './botStore';
import { BotChatStore } from './chatStore';

let root: string;
let bots: BotStore;
let chats: BotChatStore;
let botId: string;
let chatId: string;
const schedule = vi.fn(async () => 'entry-2');
let memory: BotMemoryService;
const conversation = () => ({
  conversationId: 'session',
  projectId: 'project',
  bot: { botId, chatId },
  sessionFile: 'session.jsonl',
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bot-memory-'));
  bots = new BotStore(join(root, 'bots'));
  chats = new BotChatStore(join(root, 'chats'));
  const bot = bots.create({ name: 'Alice' }, []);
  if (!bot.ok) throw new Error('fixture');
  botId = bot.bot.id;
  chatId = chats.create({
    kind: 'direct',
    title: '',
    members: [botId],
    bossBotId: null,
    workspace: { kind: 'member-home' },
  })!.id;
  chats.update(chatId, (c) => ({
    ...c,
    sessions: { [botId]: { conversationId: 'session', cursor: 0, distilledTo: 'entry-1' } },
  }));
  schedule.mockClear();
  memory = new BotMemoryService({ bots, chats, isCodeProject: (id) => id !== 'home', schedule });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('resolves direct/group authority to bot/chat/code spaces without leaking home projects', () => {
  expect(resolveSpaceIds('all', memory.context(conversation()).context)).toEqual([
    `bot:${botId}`,
    'proj:project',
    'global',
  ]);
  expect(
    resolveSpaceIds('all', memory.context({ ...conversation(), projectId: 'home' }).context)
  ).toEqual([`bot:${botId}`, 'global']);
  const bob = bots.create({ name: 'Bob' }, []);
  if (!bob.ok) throw new Error('fixture');
  const group = chats.create({
    kind: 'group',
    title: 'Team',
    members: [botId, bob.bot.id],
    bossBotId: botId,
    workspace: { kind: 'project', projectId: 'project' },
  })!;
  expect(
    resolveSpaceIds(
      'all',
      memory.context({ ...conversation(), bot: { botId, chatId: group.id } }).context
    )
  ).toEqual([`bot:${botId}`, `chat:${group.id}`, 'proj:project', 'global']);
});

it('persists incremental watermarks and does not distill disabled members', async () => {
  await memory.distill(conversation());
  expect(schedule).toHaveBeenCalledWith(expect.objectContaining({ botId, fromEntryId: 'entry-1' }));
  expect(new BotChatStore(join(root, 'chats')).get(chatId)!.sessions[botId].distilledTo).toBe(
    'entry-2'
  );
  await memory.distill(conversation());
  expect(schedule).toHaveBeenLastCalledWith(expect.objectContaining({ fromEntryId: 'entry-2' }));
  bots.update(botId, { memory: { enabled: false } }, []);
  expect(memory.context(conversation()).enabled).toBe(false);
  await memory.distill(conversation());
  expect(schedule).toHaveBeenCalledTimes(2);
});

it('does not overwrite a replacement session watermark', async () => {
  schedule.mockImplementationOnce(async () => {
    chats.update(chatId, (c) => ({
      ...c,
      sessions: { [botId]: { conversationId: 'new', cursor: 0 } },
    }));
    return 'old';
  });
  await memory.distill(conversation());
  expect(chats.get(chatId)!.sessions[botId]).toEqual({ conversationId: 'new', cursor: 0 });
});
