import type { ApprovalRequestInfo, ProjectedMessage } from '@shared/types/agent';
import type { BotChat } from '@shared/types/bot';
import { describe, expect, it } from 'vitest';
import { emptyProjection } from '@/stores/sessions/reducer';
import { chatSummary, messagePreview, pendingItems, sessionOwners, sortChats } from './selectors';

const chat = (over: Partial<BotChat>): BotChat => ({
  id: 'c1',
  kind: 'direct',
  title: '',
  members: ['b1'],
  bossBotId: null,
  workspace: { kind: 'member-home' },
  routing: { maxHops: 4, maxTurnsPerBot: 2 },
  pinned: false,
  sessions: {},
  createdAt: 1,
  updatedAt: 1,
  version: 1,
  ...over,
});
const approval = { requestId: 'r1' } as ApprovalRequestInfo;
const msg = (role: string, text: string, timestamp: number): ProjectedMessage => ({
  role,
  content: [{ type: 'text', text }],
  timestamp,
});

describe('sessionOwners / pendingItems', () => {
  it('汇总当前会话的待审批，并可按聊天过滤', () => {
    const chats = [
      chat({ id: 'c1', sessions: { b1: { conversationId: 's1', cursor: 0 } } }),
      chat({ id: 'c2', sessions: { b2: { conversationId: 's2', cursor: 0 } } }),
    ];
    const sessions = {
      s1: { ...emptyProjection, pendingApprovals: [approval] },
      s2: { ...emptyProjection, pendingApprovals: [approval] },
    };
    const owners = sessionOwners(chats);
    expect(pendingItems(sessions, owners)).toHaveLength(2);
    expect(pendingItems(sessions, owners, 'c2')).toMatchObject([
      { kind: 'approval', chatId: 'c2', botId: 'b2', conversationId: 's2' },
    ]);
  });
});

describe('chatSummary', () => {
  it('Main 注入的用户输入用卡片内容作摘要，普通 assistant 内容不误解析', () => {
    const text = '<routine title="晨报">今天 &amp; 明天</routine>';
    expect(messagePreview(msg('user', text, 1))).toBe('晨报 · 今天 & 明天');
    expect(messagePreview(msg('assistant', text, 1))).toBe(text);
  });
  it('私聊取最后一条有文字的消息作摘要，按消息数作已读标记', () => {
    const summary = chatSummary(chat({ sessions: { b1: { conversationId: 's1', cursor: 0 } } }), {
      sessions: {
        s1: {
          ...emptyProjection,
          status: 'running',
          messages: [msg('user', 'hi', 5), msg('assistant', ' done \n now ', 9)],
        },
      },
      queue: [],
      names: {},
    });
    expect(summary).toMatchObject({
      key: 'c1:s1',
      marker: 2,
      preview: 'done now',
      activityAt: 9,
      running: true,
    });
  });

  it('群聊按时间线末条与 lastSeq 计算，并标记排队', () => {
    const summary = chatSummary(chat({ kind: 'group', members: ['b1', 'b2'] }), {
      sessions: {},
      timeline: {
        lastSeq: 7,
        entries: [
          {
            kind: 'bot',
            seq: 7,
            id: 'e',
            at: 50,
            botId: 'b1',
            text: 'ok',
            conversationId: 's',
            turnId: 't',
          },
        ],
      },
      queue: [{ chatId: 'c1', botId: 'b1', conversationId: 's', position: 0 }],
      names: { b1: 'Lin' },
    });
    expect(summary).toMatchObject({ key: 'c1', marker: 7, preview: 'Lin: ok', queued: true });
  });
});

describe('sortChats', () => {
  it('置顶在前，其余按活动时间倒序', () => {
    const row = (id: string, pinned: boolean, activityAt: number) => ({
      chat: chat({ id, pinned }),
      summary: { activityAt } as never,
    });
    expect(
      sortChats([row('a', false, 1), row('b', false, 3), row('c', true, 0)]).map((r) => r.chat.id)
    ).toEqual(['c', 'b', 'a']);
  });
});
