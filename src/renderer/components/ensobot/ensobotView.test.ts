import { cropInsideImage, EMPTY_ROLE } from '@shared/characterCard';
import type { EnsobotActivity } from '@shared/ensobot/activity';
import type { EnsobotInteraction } from '@shared/ensobot/interaction';
import type { EnsobotSnapshot } from '@shared/ensobot/snapshot';
import { describe, expect, it } from 'vitest';
import {
  inlineInteractionIds,
  lastPreview,
  memberStatus,
  mentionSegments,
  mergeNodeSnapshot,
  normalizeRole,
  parseWorkspaceSessions,
  placeCrop,
  reconcileChat,
  roomActivityCounts,
  surfaceActivity,
} from './ensobotView';

const cards: EnsobotSnapshot['cards'] = [
  {
    id: 'a',
    name: '阿宁',
    coordinator: false,
    bare: false,
    previewUrl: '',
    width: 80,
    height: 120,
    crop: null,
  },
];

describe('EnsoBot 会话选择', () => {
  it('各节点 seq 分开比较，本机的大序号不能覆盖远程节点的新快照', () => {
    const base: EnsobotSnapshot = {
      seq: 500,
      cards,
      groups: [],
      bubbles: [],
      board: [],
      roomMessages: [],
      tasks: [],
      notices: [],
      workspace: { projectId: null, projectName: null, sessionId: null },
    };
    const remote = { ...base, seq: 2, cards: [] };
    const merged = mergeNodeSnapshot({ local: base }, 'remote', remote);
    expect(merged.remote).toEqual(remote);
    expect(merged.local).toBe(base);
    expect(mergeNodeSnapshot(merged, 'remote', { ...remote, seq: 1, cards }).remote).toBe(
      merged.remote
    );
  });
  it('群被删除后退回有效私聊，不留空白的失效房间', () => {
    expect(reconcileChat({ kind: 'room', roomId: 'deleted' }, { cards, groups: [] })).toEqual({
      kind: 'dm',
      cardId: 'a',
    });
  });
  it('没有成员也没有群时清空失效选择', () => {
    expect(
      reconcileChat({ kind: 'room', roomId: 'deleted' }, { cards: [], groups: [] })
    ).toBeNull();
  });
  it('仍存在的私聊不会被新的快照切走', () => {
    expect(reconcileChat({ kind: 'dm', cardId: 'a' }, { cards, groups: [] })).toEqual({
      kind: 'dm',
      cardId: 'a',
    });
  });
});

function snap(patch: Partial<EnsobotSnapshot>): EnsobotSnapshot {
  return {
    seq: 1,
    cards,
    groups: [],
    bubbles: [],
    board: [],
    roomMessages: [],
    tasks: [],
    notices: [],
    workspace: { projectId: null, projectName: null, sessionId: null },
    ...patch,
  };
}

it('群列表区分等待人工、排队和工作，不把等待审批计为工作', () => {
  const state = snap({
    activity: [
      { cardId: 'a', surface: 'room', roomId: 'r', state: 'tool', queued: 0, steps: [] },
      { cardId: 'b', surface: 'room', roomId: 'r', state: 'queued', queued: 1, steps: [] },
      { cardId: 'c', surface: 'room', roomId: 'other', state: 'thinking', queued: 0, steps: [] },
    ],
    interactions: [
      {
        id: 'i',
        cardId: 'a',
        kind: 'ask',
        responding: false,
        request: { requestId: 'i', question: '继续？' },
      },
    ],
  });
  expect(roomActivityCounts(state, 'r')).toEqual({ waiting: 1, working: 0, queued: 1 });
  expect(roomActivityCounts(state, 'other')).toEqual({ waiting: 0, working: 1, queued: 0 });
  expect(roomActivityCounts(state, 'missing')).toEqual({ waiting: 0, working: 0, queued: 0 });
});

const inRoom: EnsobotActivity = {
  cardId: 'a',
  state: 'tool',
  surface: 'room',
  roomId: 'r1',
  queued: 1,
  steps: [
    { id: 't0', name: 'ls', summary: '.', status: 'done' },
    { id: 't1', name: 'read', summary: 'a.txt', status: 'running' },
  ],
};

const approval: EnsobotInteraction = {
  id: 'token',
  cardId: 'a',
  responding: false,
  kind: 'approval',
  request: { requestId: 'apr', tool: 'powershell', kind: 'command', summary: 'Write-Output' },
};

describe('EnsoBot 工作可见', () => {
  it('成员状态：待审批/提问优先，其次活轮，再是后台任务，最后空闲', () => {
    expect(memberStatus(snap({ activity: [inRoom] }), 'a')).toMatchObject({
      kind: 'tool',
      tool: 'read',
      detail: 'a.txt',
      queued: 1,
    });
    expect(memberStatus(snap({ activity: [inRoom], interactions: [approval] }), 'a').kind).toBe(
      'approval'
    );
    expect(
      memberStatus(
        snap({
          tasks: [
            {
              id: 't',
              cardId: 'a',
              title: '写测试',
              check: 'PASS',
              workspaceKey: 'k',
              status: 'doing',
            },
          ],
        }),
        'a'
      )
    ).toMatchObject({ kind: 'task', detail: '写测试' });
    expect(memberStatus(snap({}), 'a').kind).toBe('idle');
    expect(memberStatus(snap({ activity: undefined, interactions: undefined }), 'a').kind).toBe(
      'idle'
    );
  });

  it('当前聊天面的活动：群只看这个群，私聊只看私聊面', () => {
    const chat: EnsobotActivity = { ...inRoom, cardId: 'b', surface: 'chat', roomId: undefined };
    const snapshot = snap({ activity: [inRoom, chat] });
    expect(
      surfaceActivity(snapshot, { kind: 'room', roomId: 'r1' }).map((item) => item.cardId)
    ).toEqual(['a']);
    expect(surfaceActivity(snapshot, { kind: 'room', roomId: 'other' })).toEqual([]);
    expect(
      surfaceActivity(snapshot, { kind: 'dm', cardId: 'b' }).map((item) => item.cardId)
    ).toEqual(['b']);
    expect(surfaceActivity(snapshot, { kind: 'dm', cardId: 'a' })).toEqual([]);
  });

  it('在当前聊天面工作的成员，其审批就地显示；其它的留在顶部', () => {
    const snapshot = snap({ activity: [inRoom], interactions: [approval] });
    expect(inlineInteractionIds(snapshot, { kind: 'room', roomId: 'r1' })).toEqual(
      new Set(['token'])
    );
    expect(inlineInteractionIds(snapshot, { kind: 'room', roomId: 'other' })).toEqual(new Set());
    expect(inlineInteractionIds(snapshot, null)).toEqual(new Set());
  });

  it('正文按 @名字 切段：只有认得的成员名被标出，其余原样保留', () => {
    const members = [
      { id: 'a', name: '阿宁' },
      { id: 'b', name: '北北' },
    ];
    expect(mentionSegments('好的 @北北 看下 @陌生人', members)).toEqual([
      { text: '好的 ', mention: false },
      { text: '@北北', mention: true },
      { text: ' 看下 @陌生人', mention: false },
    ]);
    expect(mentionSegments('没有点名', members)).toEqual([{ text: '没有点名', mention: false }]);
    expect(mentionSegments('@阿宁', [])).toEqual([{ text: '@阿宁', mention: false }]);
    expect(mentionSegments('', members)).toEqual([]);
  });
});

describe('人物卡与消息显示', () => {
  it('公共工作区只读有效的顶层会话目录，坏数据不阻断列表', () => {
    const data = {
      'enso-conversations': {
        state: {
          conversations: {
            valid: { id: 'valid', title: '方案讨论', projectId: 'p' },
            child: { id: 'child', title: '子会话', projectId: 'p', parentId: 'valid' },
            archived: { id: 'archived', title: '已归档', projectId: 'p', archived: true },
            broken: null,
          },
        },
      },
    };
    expect(parseWorkspaceSessions(data)).toEqual([
      { id: 'valid', title: '方案讨论', projectId: 'p' },
    ]);
    expect(parseWorkspaceSessions(null)).toEqual([]);
    expect(parseWorkspaceSessions({ 'enso-conversations': { state: [] } })).toEqual([]);
  });
  it('消息预览按 seq 而非数组位置取最新，不改变原始数组', () => {
    const messages = [
      { text: '新的\n消息', seq: 9 },
      { text: '旧消息', seq: 2 },
    ];
    expect(lastPreview(messages)).toBe('新的 消息');
    expect(messages[0].seq).toBe(9);
  });
  it('侧栏预览去掉 Markdown 记号，只留读得懂的字', () => {
    expect(
      lastPreview([
        { text: '## 结论\n汇总：**可以继续**，见 `a.ts` 和 [文档](https://x.y)', seq: 1 },
      ])
    ).toBe('结论 汇总：可以继续，见 a.ts 和 文档');
    expect(lastPreview([{ text: '> 引用\n- 第一条\n1. 第二条', seq: 1 }])).toBe(
      '引用 第一条 第二条'
    );
    expect(lastPreview([{ text: '@saki_酱 看 2*3', seq: 1 }])).toBe('@saki_酱 看 2*3');
  });
  it('裁切在横图竖图的四角和放大时都不越出原图', () => {
    for (const [width, height] of [
      [80, 120],
      [120, 80],
    ]) {
      for (const cx of [-100, width + 100]) {
        for (const cy of [-100, height + 100]) {
          const crop = placeCrop(null, width, height, { cx, cy, r: 999 });
          expect(cropInsideImage(crop, width, height)).toBe(true);
        }
      }
    }
  });
  it('并发数被归一但不能丢掉权限和模型配置', () => {
    const role = {
      ...EMPTY_ROLE,
      concurrency: 2.6,
      providerId: 'p',
      modelId: 'm',
      toolIds: ['read'],
    };
    expect(normalizeRole(role)).toEqual({ ...role, concurrency: 3 });
    expect(normalizeRole({ ...role, concurrency: Number.NaN }).concurrency).toBe(1);
  });
});
