import { describe, expect, it } from 'vitest';
import { acceptDelivery, orderDeliveries } from './lane';

const item = (deliveryId: string, lane: 'human' | 'bot' | 'background') => ({
  deliveryId,
  lane,
  cardId: 'card',
  text: deliveryId,
});

describe('ensobot lanes', () => {
  it('人的话先于 bot，bot 先于后台，同车道不换顺序', () => {
    const ordered = orderDeliveries([
      item('bg', 'background'),
      item('bot-2', 'bot'),
      item('human-2', 'human'),
      item('bot-1', 'bot'),
      item('human-1', 'human'),
    ]);
    expect(ordered.map((entry) => entry.deliveryId)).toEqual([
      'human-2',
      'human-1',
      'bot-2',
      'bot-1',
      'bg',
    ]);
  });

  it('同一条 deliveryId 再送一次只算重复', () => {
    const seen = new Set(['d1']);
    expect(acceptDelivery({ deliveryId: 'd1', seen, workerReady: true })).toEqual({
      ok: false,
      reason: 'duplicate',
    });
  });

  it('worker 不在线时拒绝，不当成已经送到', () => {
    expect(acceptDelivery({ deliveryId: 'd2', seen: new Set(), workerReady: false })).toEqual({
      ok: false,
      reason: 'worker-offline',
    });
  });
});
