import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { AgentWorkerEvent } from '../../../shared/types/agent';
import { SourceAuthorityRegistry } from '../sourceAuthorityRegistry';
import { BotSessionHost } from './botSessionHost';
import { BotStore } from './botStore';
import { BotChatStore } from './chatStore';
import { DelegationService } from './delegationService';
import { DelegationStore } from './delegationStore';
import { GroupChatService } from './groupChat';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'group-delegation-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function fixture() {
  const bots = new BotStore(join(root, 'bots'));
  const lin = bots.create({ name: '林经理', tools: 'readonly' }, []);
  const hou = bots.create({ name: '阿后' }, []);
  if (!lin.ok || !hou.ok) throw new Error('bots');
  const chats = new BotChatStore(join(root, 'bot-chats'));
  const chat = chats.create({
    kind: 'group',
    title: '发布小组',
    members: [lin.bot.id, hou.bot.id],
    bossBotId: lin.bot.id,
    workspace: { kind: 'chat-home', projectId: 'home' },
  })!;
  const authority = new SourceAuthorityRegistry({ registryFile: join(root, 'authority.json') });
  const prompts: Array<{ id: string; text: string; deliveryId?: string }> = [];
  const host = new BotSessionHost({
    bots,
    chats,
    authority,
    emit: () => {},
    runtime: {
      spawn: async () => ({ ok: true }),
      prompt: (id, text, _images, deliveryId) => {
        prompts.push({ id, text, deliveryId });
        return { ok: true };
      },
      steer: (id, text, _images, deliveryId) => {
        prompts.push({ id, text, deliveryId });
        return { ok: true };
      },
      release: async () => {},
      abort: () => {},
      removeSessionFiles: () => {},
    },
  });
  const groups = new GroupChatService({ bots, chats, host, emit: () => {} });
  const delegations = new DelegationService({
    bots,
    chats,
    authority,
    host,
    store: new DelegationStore(join(root, 'bot-chats', 'delegations.jsonl')),
    emit: () => {},
    deliverGroupResult: async (record, text, deliveryId) =>
      record.chatId &&
      chats.get(record.chatId)?.sessions[record.parentBotId]?.conversationId ===
        record.parentConversationId
        ? groups.runAs(record.chatId, record.parentBotId, text, undefined, {
            onlyIfIdle: true,
            deliveryId,
          })
        : { ok: false, error: 'parent-session-changed' },
  });
  let index = 0;
  const observe = (sessionId: string, event: Record<string, unknown>) =>
    host.observe({
      seq: 1,
      identity: { sessionId, generation: 'g' },
      ...event,
    } as AgentWorkerEvent);
  const start = (id: string) => {
    observe(id, { type: 'status', status: 'running' });
    delegations.observeRunning(id);
  };
  const reply = (id: string, text: string) => {
    observe(id, {
      type: 'message-upsert',
      index: ++index,
      message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' },
    });
    observe(id, { type: 'status', status: 'idle' });
    observe(id, { type: 'turn-completed', turnId: `turn-${index}` });
  };
  const conversation = (botId: string) => chats.get(chat.id)!.sessions[botId].conversationId;
  const to = (id: string) => prompts.filter((prompt) => prompt.id === id);
  const child = (id: string) =>
    delegations.list().find((record) => record.id === id)!.childConversationId;
  return {
    lin: lin.bot.id,
    hou: hou.bot.id,
    chat,
    host,
    groups,
    delegations,
    observe,
    start,
    reply,
    conversation,
    to,
    child,
  };
}

it('relays to a member who delegated earlier in the round and delivers both delegation results', async () => {
  const { host, groups, delegations, start, reply, to, child, conversation, ...f } = fixture();

  // 人类消息（带 renderer 生成的 deliveryId）→ 群主林经理
  await groups.send(f.chat.id, '请让阿后把 hello.txt 改成 hello world', { deliveryId: 'human-1' });
  await settle();
  const lin = conversation(f.lin);
  expect(to(lin)).toHaveLength(1);
  start(lin);
  // 林经理轮次中委派阿后
  const d1 = delegations.delegate(lin, { to: '阿后', task: '改文件' });
  if (!d1.ok) throw new Error(d1.error);
  await settle();
  const child1 = child(d1.delegationId);
  expect(to(child1)).toHaveLength(1);
  start(child1);
  reply(lin, '我已经让 @阿后 改了');
  await settle();
  const hou = conversation(f.hou);
  expect(to(hou)).toHaveLength(1);
  start(hou);
  // 阿后轮次中委派林经理确认
  const d2 = delegations.delegate(hou, { to: '林经理', task: '确认' });
  if (!d2.ok) throw new Error(d2.error);
  await settle();
  const child2 = child(d2.delegationId);
  start(child2);
  reply(hou, '改好了，等 @林经理 确认');
  await settle();
  // 接力给刚空闲的林经理：必须真正发出
  expect(to(lin)).toHaveLength(2);
  start(lin);
  // 委派 2 在林经理接力进行中完成（父会话阿后空闲，但群这一轮未结束）
  reply(child2, '确认过了');
  await settle();
  reply(lin, '好的，我看一下');
  await settle();
  expect(to(hou).at(-1)?.text).toContain(`<delegation-result id="${d2.delegationId}"`);
  start(hou);
  await settle();
  expect(delegations.list().find((r) => r.id === d2.delegationId)?.deliveredAt).toBeDefined();
  // 委派 1 在阿后处理结果时完成（父会话林经理空闲）
  reply(child1, 'done');
  await settle();
  reply(hou, '收到确认');
  await settle();
  expect(to(lin).at(-1)?.text).toContain(`<delegation-result id="${d1.delegationId}"`);
  start(lin);
  reply(lin, '全部完成');
  await settle();
  expect(delegations.list().every((record) => record.deliveredAt !== undefined)).toBe(true);
  expect(groups.state(f.chat.id)).toMatchObject({ current: null });
  expect(host.queueState()).toEqual([]);
  expect(host.runningCount()).toBe(0);
  delegations.dispose();
  groups.dispose();
});
