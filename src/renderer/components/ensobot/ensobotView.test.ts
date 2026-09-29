import { cropInsideImage, EMPTY_ROLE } from '@shared/characterCard';
import type { EnsobotSnapshot } from '@shared/ensobot/snapshot';
import { describe, expect, it } from 'vitest';
import {
  lastPreview,
  mergeNodeSnapshot,
  normalizeRole,
  parseWorkspaceSessions,
  placeCrop,
  reconcileChat,
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
