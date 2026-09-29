import type { NodeMessage } from '@shared/types/nodes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ activeNodeId: 'local' }));
vi.mock('@/stores/remoteNodes', () => ({ useRemoteNodesStore: { getState: () => state } }));

import { runCommand } from './useEnsobot';

let listeners: Set<(message: NodeMessage) => void>;
const emit = (nodeId: string, deliveryId?: string) => {
  for (const listener of listeners)
    listener({ nodeId, payload: { type: 'ensobot-result', ok: true, deliveryId } });
};
const send = vi.fn();
beforeEach(() => {
  listeners = new Set();
  state.activeNodeId = 'remote-a';
  send.mockReset().mockResolvedValue({ ok: true });
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    electronAPI: {
      nodes: {
        send,
        onMessage: (listener: (message: NodeMessage) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('EnsoBot 节点消息回执', () => {
  it('有独立 deliveryId 的聊天并行发送，不被其他会话回执阻塞', async () => {
    const a = runCommand(
      { type: 'ensobot-send', cardId: 'a', text: '一', deliveryId: 'a' },
      vi.fn(),
      'a'
    );
    const b = runCommand(
      { type: 'ensobot-send', cardId: 'b', text: '二', deliveryId: 'b' },
      vi.fn(),
      'b'
    );
    await Promise.resolve();
    await Promise.resolve();
    const sentBeforeReceipt = send.mock.calls.length;
    emit('remote-a', 'a');
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    emit('remote-a', 'b');
    await Promise.all([a, b]);
    expect(sentBeforeReceipt).toBe(2);
  });
  it('回执早于 transport 返回时仍能接收，不丢快速节点的回复', async () => {
    send.mockImplementation(async () => {
      emit('remote-a', 'd1');
      return { ok: true };
    });
    const result = await runCommand(
      { type: 'ensobot-send', cardId: 'a', text: '你好', deliveryId: 'd1' },
      vi.fn(),
      'd1'
    );
    expect(result.ok).toBe(true);
    expect(listeners.size).toBe(0);
  });
  it('不能把其他节点或其他消息的回执当成本次成功', async () => {
    let settled = false;
    const job = runCommand(
      { type: 'ensobot-send', cardId: 'a', text: '你好', deliveryId: 'd2' },
      vi.fn(),
      'd2'
    ).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    emit('remote-b', 'd2');
    emit('remote-a', 'other');
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    emit('remote-a', 'd2');
    expect((await job).ok).toBe(true);
  });
  it('本机拒绝不会卡住发送状态或转发到远端', async () => {
    state.activeNodeId = 'local';
    const result = await runCommand(
      { type: 'ensobot-room-create', name: '讨论', memberIds: ['a', 'b'] },
      async () => {
        throw new Error('offline');
      }
    );
    expect(result.ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
