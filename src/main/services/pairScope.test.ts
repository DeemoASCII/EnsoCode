import { PHONE_COMMAND_TYPES } from '@enso/pair';
import { describe, expect, it } from 'vitest';
import { commandAllowedForScope, deviceScope, setScopeInList } from './pairScope';

const device = (pairId: string, scope?: 'read' | 'operate') => ({
  pairId,
  token: 't',
  contentKey: 'k',
  deviceName: pairId,
  relayUrl: 'https://relay',
  pairedAt: 1,
  ...(scope ? { scope } : {}),
});

const READ_ONLY_ALLOWED = [
  'snapshot',
  'subscribe',
  'history',
  'push-subscribe',
  'push-unsubscribe',
  'presence',
  'direct-offer',
  'direct-ice',
  'direct-close',
  'probe',
  'bot-catalog-request',
  'bot-chat-open',
  'bot-timeline',
];

describe('配对作用域', () => {
  it('旧记录缺省为 operate，脏值也按 operate', () => {
    expect(deviceScope(device('a'))).toBe('operate');
    expect(deviceScope({ ...device('a'), scope: 'admin' as never })).toBe('operate');
    expect(deviceScope(device('a', 'read'))).toBe('read');
  });

  it('operate 放行全部手机命令', () => {
    for (const type of PHONE_COMMAND_TYPES)
      expect(commandAllowedForScope('operate', type), type).toBe(true);
  });

  it('read 只放行查看类命令，发送/审批/停止/排队/改配置全部拦截', () => {
    const allowed = PHONE_COMMAND_TYPES.filter((type) => commandAllowedForScope('read', type));
    expect([...allowed].sort()).toEqual([...READ_ONLY_ALLOWED].sort());
    for (const type of [
      'prompt',
      'steer',
      'abort',
      'approval-respond',
      'ask-respond',
      'spawn',
      'enqueue',
      'queue-send-now',
      'goal-set',
      'task-stop',
      'subagent-stop',
      'voice-chunk',
      'bot-send',
      'bot-stop',
    ] as const)
      expect(commandAllowedForScope('read', type), type).toBe(false);
  });

  it('未来新增的未知命令在只读下默认拦截', () => {
    expect(commandAllowedForScope('read', 'bot-delegation-cancel')).toBe(false);
  });

  it('setScopeInList 只改目标设备，未知设备原样返回', () => {
    const list = [device('a'), device('b', 'read')];
    expect(setScopeInList(list, 'a', 'read').map(deviceScope)).toEqual(['read', 'read']);
    expect(setScopeInList(list, 'b', 'operate').map(deviceScope)).toEqual(['operate', 'operate']);
    expect(setScopeInList(list, 'x', 'read')).toEqual(list);
  });
});
