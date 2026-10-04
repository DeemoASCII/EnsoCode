import { describe, expect, it } from 'vitest';
import { BotOutbox, type OutboxStorage, parseOutbox } from './botOutbox';

const memory = (initial: Record<string, unknown> = {}) => {
  const data: Record<string, unknown> = { ...initial };
  const storage: OutboxStorage = {
    load: async (pairId) => data[pairId],
    save: async (pairId, items) => {
      data[pairId] = structuredClone(items);
    },
  };
  return { data, storage };
};

const make = (storage: OutboxStorage) => {
  let id = 0;
  return new BotOutbox(storage, 'pair-1', {
    newId: () => `d-${++id}`,
    now: () => 1000,
  });
};

describe('BotOutbox', () => {
  it('queues while offline and drains once with the original deliveryId', async () => {
    const { storage } = memory();
    const box = make(storage);
    const item = box.enqueue({ chatId: 'c1', text: 'hi' });
    expect(item.status).toBe('pending');
    expect(box.drain().map((x) => x.deliveryId)).toEqual(['d-1']);
    // 已在途的不再重复发出
    expect(box.drain()).toEqual([]);
    expect(box.list('c1')[0].status).toBe('sending');
  });

  it('replays in-flight items after reconnect without changing deliveryId', async () => {
    const { storage } = memory();
    const box = make(storage);
    box.enqueue({ chatId: 'c1', text: 'a' });
    box.enqueue({ chatId: 'c1', text: 'b' });
    expect(box.drain()).toHaveLength(2);
    box.interrupted();
    expect(box.drain().map((x) => x.deliveryId)).toEqual(['d-1', 'd-2']);
    box.settle('d-1', true);
    box.settle('d-1', true);
    expect(box.list().map((x) => x.deliveryId)).toEqual(['d-2']);
  });

  it('ignores results for unknown deliveries', () => {
    const box = make(memory().storage);
    box.settle('other', false, 'x');
    expect(box.list()).toEqual([]);
  });

  it('failure waits for manual retry, which reuses the same deliveryId', () => {
    const box = make(memory().storage);
    box.enqueue({ chatId: 'c1', text: 'a' });
    box.drain();
    box.settle('d-1', false, 'chat-stopping');
    expect(box.list()[0]).toMatchObject({ status: 'failed', error: 'chat-stopping' });
    expect(box.drain()).toEqual([]);
    box.interrupted();
    expect(box.list()[0].status).toBe('failed');
    box.retry('d-1');
    expect(box.drain().map((x) => x.deliveryId)).toEqual(['d-1']);
    box.discard('d-1');
    expect(box.list()).toEqual([]);
  });

  it('persists across restarts; in-flight items come back as pending', async () => {
    const { storage, data } = memory();
    const first = make(storage);
    first.enqueue({ chatId: 'c1', text: 'a', images: [{ data: 'AAA', mimeType: 'image/png' }] });
    first.drain();
    await first.flushed();
    expect(data['pair-1']).toHaveLength(1);

    const second = make(storage);
    await second.restore();
    expect(second.list()).toEqual([
      {
        deliveryId: 'd-1',
        chatId: 'c1',
        text: 'a',
        images: [{ data: 'AAA', mimeType: 'image/png' }],
        createdAt: 1000,
        status: 'pending',
      },
    ]);
    expect(second.drain().map((x) => x.deliveryId)).toEqual(['d-1']);
  });

  it('restore merges with items enqueued before the load finished', async () => {
    const { storage } = memory({
      'pair-1': [{ deliveryId: 'old', chatId: 'c1', text: 'x', createdAt: 1, status: 'failed' }],
    });
    const box = make(storage);
    box.enqueue({ chatId: 'c1', text: 'new' });
    await box.restore();
    expect(box.list().map((x) => x.deliveryId)).toEqual(['old', 'd-1']);
  });

  it('notifies listeners on every change', () => {
    const box = make(memory().storage);
    const seen: number[] = [];
    box.subscribe((items) => seen.push(items.length));
    box.enqueue({ chatId: 'c1', text: 'a' });
    box.discard('d-1');
    expect(seen).toEqual([1, 0]);
  });
});

describe('parseOutbox', () => {
  it('drops malformed records and dedupes by deliveryId', () => {
    expect(
      parseOutbox([
        null,
        { deliveryId: 'a', chatId: 'c', text: 't', createdAt: 1, status: 'sending' },
        { deliveryId: 'a', chatId: 'c', text: 'dup', createdAt: 2, status: 'pending' },
        { deliveryId: '', chatId: 'c', text: 't', createdAt: 1, status: 'pending' },
        { deliveryId: 'b', chatId: 'c', text: 't', createdAt: 1, status: 'weird' },
        { deliveryId: 'c', chatId: 'c', text: 't', createdAt: 1, status: 'failed', images: [1] },
        { deliveryId: 'd', chatId: 'c', text: 't', createdAt: 1, status: 'failed', error: 'x' },
      ])
    ).toEqual([
      { deliveryId: 'a', chatId: 'c', text: 't', createdAt: 1, status: 'pending' },
      { deliveryId: 'b', chatId: 'c', text: 't', createdAt: 1, status: 'pending' },
      { deliveryId: 'd', chatId: 'c', text: 't', createdAt: 1, status: 'failed', error: 'x' },
    ]);
    expect(parseOutbox('garbage')).toEqual([]);
  });
});
