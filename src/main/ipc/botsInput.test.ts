import { describe, expect, it } from 'vitest';
import {
  parseAbilitySuggestRequest,
  parseBotDraftInput,
  parseBotUpdateInput,
  parseChatCreateInput,
  parseChatUpdateInput,
  parseOpenWorkspaceInput,
  parsePersonaSuggestRequest,
  parseSendInput,
  parseSessionHistoryInput,
  parseTimelineInput,
} from './botsInput';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('parseBotDraftInput', () => {
  it('收窄合法草稿，engine:null 表示跟随全局默认', () => {
    expect(
      parseBotDraftInput({
        name: 'Alice',
        persona: 'p',
        approvalMode: 'supervised',
        tools: 'readonly',
        skillIds: ['s'],
        delegation: { canDelegateTo: 'any', acceptFrom: [A] },
        memory: { enabled: false },
        engine: null,
      })
    ).toEqual({
      name: 'Alice',
      persona: 'p',
      approvalMode: 'supervised',
      tools: 'readonly',
      skillIds: ['s'],
      delegation: { canDelegateTo: 'any', acceptFrom: [A] },
      memory: { enabled: false },
      engine: undefined,
    });
  });

  it('拒绝未知字段、错误类型与越界长度', () => {
    expect(parseBotDraftInput({ name: 'A', id: A })).toBeNull();
    expect(parseBotDraftInput({ tools: 'write' })).toBeNull();
    expect(parseBotDraftInput({ skillIds: [1] })).toBeNull();
    expect(parseBotDraftInput({ engine: { providerId: 'p' } })).toBeNull();
    expect(
      parseBotDraftInput({ delegation: { canDelegateTo: ['x'], acceptFrom: 'any' } })
    ).toBeNull();
    expect(parseBotDraftInput({ persona: 'x'.repeat(200_001) })).toBeNull();
    expect(parseBotDraftInput('Alice')).toBeNull();
  });

  it('更新请求带 botId 与可选 expectedVersion', () => {
    expect(parseBotUpdateInput({ botId: A, expectedVersion: 2, draft: { title: 't' } })).toEqual({
      botId: A,
      expectedVersion: 2,
      draft: { title: 't' },
    });
    expect(parseBotUpdateInput({ botId: 'x', draft: {} })).toBeNull();
  });
});

describe('chat inputs', () => {
  it('新建聊天：工作区只接受 member-home / chat-home / project+projectId', () => {
    expect(
      parseChatCreateInput({ kind: 'direct', members: [A], workspace: { kind: 'member-home' } })
    ).toEqual({
      kind: 'direct',
      title: '',
      members: [A],
      bossBotId: null,
      workspace: { kind: 'member-home' },
    });
    expect(
      parseChatCreateInput({
        kind: 'group',
        title: 'g',
        members: [A, B],
        bossBotId: A,
        workspace: { kind: 'chat-home' },
      })?.workspace
    ).toEqual({ kind: 'chat-home' });
    expect(
      parseChatCreateInput({ kind: 'group', members: [A, B], workspace: { kind: 'project' } })
    ).toBeNull();
    expect(
      parseChatCreateInput({
        kind: 'group',
        members: [A, B],
        workspace: { kind: 'chat-home', projectId: A },
      })
    ).toBeNull();
    expect(
      parseChatCreateInput({
        kind: 'direct',
        members: [A],
        workspace: { kind: 'member-home' },
        sessions: {},
      })
    ).toBeNull();
  });

  it('更新聊天：只收白名单字段', () => {
    expect(
      parseChatUpdateInput({ chatId: A, pinned: true, routing: { maxHops: 3 }, archived: false })
    ).toEqual({ chatId: A, pinned: true, routing: { maxHops: 3 }, archived: false });
    expect(parseChatUpdateInput({ chatId: A, sessions: {} })).toBeNull();
    expect(parseChatUpdateInput({ chatId: A, routing: { maxHops: 'x' } })).toBeNull();
  });

  it('routing.mode 只接受 boss / smart', () => {
    expect(parseChatUpdateInput({ chatId: A, routing: { mode: 'smart' } })).toEqual({
      chatId: A,
      routing: { mode: 'smart' },
    });
    expect(parseChatUpdateInput({ chatId: A, routing: { mode: 'boss' } })?.routing).toEqual({
      mode: 'boss',
    });
    expect(parseChatUpdateInput({ chatId: A, routing: { mode: 'auto' } })).toBeNull();
    expect(parseChatUpdateInput({ chatId: A, routing: { mode: 1 } })).toBeNull();
  });
});

describe('send / timeline / workspace / history inputs', () => {
  it('发送需要 deliveryId，文本或图片至少一个', () => {
    expect(parseSendInput({ chatId: A, text: 'hi', deliveryId: 'd' })).toEqual({
      chatId: A,
      text: 'hi',
      deliveryId: 'd',
    });
    expect(parseSendInput({ chatId: A, text: 'hi' })).toBeNull();
    expect(parseSendInput({ chatId: A, text: '', deliveryId: 'd' })).toBeNull();
    expect(
      parseSendInput({
        chatId: A,
        text: '',
        deliveryId: 'd',
        images: [{ data: 'x', mimeType: 'image/png' }],
      })?.images
    ).toHaveLength(1);
    expect(parseSendInput({ chatId: A, text: 'x', deliveryId: 'd', images: [{}] })).toBeNull();
  });

  it('时间线分页把 limit 收在 1..200', () => {
    expect(parseTimelineInput({ chatId: A })).toEqual({ chatId: A, limit: 100 });
    expect(parseTimelineInput({ chatId: A, beforeSeq: 5, limit: 999 })).toEqual({
      chatId: A,
      beforeSeq: 5,
      limit: 200,
    });
    expect(parseTimelineInput({ chatId: A, beforeSeq: -1 })).toBeNull();
  });

  it('打开工作区与会话历史只收标识符', () => {
    expect(parseOpenWorkspaceInput({ chatId: A })).toEqual({ chatId: A });
    expect(parseOpenWorkspaceInput({ botId: A })).toEqual({ botId: A });
    expect(parseOpenWorkspaceInput({ chatId: A, botId: A })).toBeNull();
    expect(parseOpenWorkspaceInput({ path: '/etc' })).toBeNull();
    expect(parseSessionHistoryInput({ conversationId: A, beforeIndex: 3 })).toEqual({
      conversationId: A,
      beforeIndex: 3,
    });
    expect(parseSessionHistoryInput({ conversationId: '../x' })).toBeNull();
  });
});

describe('parseAbilitySuggestRequest', () => {
  it('收窄成员描述，缺省字段补空串、语言缺省 en', () => {
    expect(parseAbilitySuggestRequest({ name: 'Rex', scope: 'Reviews', botId: A })).toEqual({
      profile: { name: 'Rex', title: '', scope: 'Reviews', persona: '' },
      language: 'en',
      botId: A,
    });
    expect(parseAbilitySuggestRequest({ name: 'Rex', language: 'zh' })?.language).toBe('zh');
  });

  it('拒绝多余字段、非法 id、超长文本和全空描述', () => {
    expect(parseAbilitySuggestRequest({ name: 'Rex', skills: [] })).toBeNull();
    expect(parseAbilitySuggestRequest({ name: 'Rex', botId: '../x' })).toBeNull();
    expect(parseAbilitySuggestRequest({ name: 'Rex', language: 'fr' })).toBeNull();
    expect(parseAbilitySuggestRequest({ name: 'x'.repeat(201) })).toBeNull();
    expect(parseAbilitySuggestRequest({ name: ' ', scope: '' })).toBeNull();
    expect(parseAbilitySuggestRequest(null)).toBeNull();
  });
});

describe('parsePersonaSuggestRequest', () => {
  it('名称和角色必填，其余缺省空串、语言缺省 en', () => {
    expect(parsePersonaSuggestRequest({ name: '阿运', title: '运维' })).toEqual({
      name: '阿运',
      title: '运维',
      scope: '',
      persona: '',
      language: 'en',
    });
    expect(
      parsePersonaSuggestRequest({
        name: 'a',
        title: 'b',
        scope: 's',
        persona: 'p',
        language: 'zh',
      })
    ).toMatchObject({ scope: 's', persona: 'p', language: 'zh' });
  });

  it('拒绝缺名称或角色、多余字段、超长和非法语言', () => {
    expect(parsePersonaSuggestRequest({ name: '阿运', title: ' ' })).toBeNull();
    expect(parsePersonaSuggestRequest({ title: '运维' })).toBeNull();
    expect(parsePersonaSuggestRequest({ name: 'a', title: 'b', botId: A })).toBeNull();
    expect(parsePersonaSuggestRequest({ name: 'a', title: 'x'.repeat(201) })).toBeNull();
    expect(parsePersonaSuggestRequest({ name: 'a', title: 'b', language: 'fr' })).toBeNull();
    expect(parsePersonaSuggestRequest(null)).toBeNull();
  });
});
