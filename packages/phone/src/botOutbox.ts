import type { AttachedImage } from '@shared/types/agent';

/**
 * Bot 发送离线队列：断线或后台时先落 IndexedDB，恢复在线后按原 deliveryId 重发。
 * Main 按 deliveryId 去重（私聊看会话已开始的投递，群聊看时间线人类条目），故重放幂等。
 */
export type OutboxStatus = 'pending' | 'sending' | 'failed';

export interface OutboxItem {
  deliveryId: string;
  chatId: string;
  text: string;
  images?: AttachedImage[];
  createdAt: number;
  status: OutboxStatus;
  error?: string;
}

export interface OutboxStorage {
  load(pairId: string): Promise<unknown>;
  save(pairId: string, items: OutboxItem[]): Promise<void>;
  remove?(pairId: string): Promise<void>;
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isImage = (value: unknown): value is AttachedImage =>
  !!value &&
  typeof value === 'object' &&
  isText((value as AttachedImage).data) &&
  isText((value as AttachedImage).mimeType);

/** 读盘收窄：坏记录丢弃，在途的视为待发（结果未知，按原 id 重发由 Main 去重） */
export function parseOutbox(value: unknown): OutboxItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: OutboxItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const v = raw as Record<string, unknown>;
    if (!isText(v.deliveryId) || !isText(v.chatId) || typeof v.text !== 'string') continue;
    if (typeof v.createdAt !== 'number' || seen.has(v.deliveryId)) continue;
    if (v.images !== undefined && !(Array.isArray(v.images) && v.images.every(isImage))) continue;
    seen.add(v.deliveryId);
    const failed = v.status === 'failed';
    items.push({
      deliveryId: v.deliveryId,
      chatId: v.chatId,
      text: v.text,
      ...(v.images ? { images: v.images as AttachedImage[] } : {}),
      createdAt: v.createdAt,
      status: failed ? 'failed' : 'pending',
      ...(failed && typeof v.error === 'string' ? { error: v.error } : {}),
    });
  }
  return items;
}

export class BotOutbox {
  private items: OutboxItem[] = [];
  private listeners = new Set<(items: readonly OutboxItem[]) => void>();
  private writing: Promise<void> = Promise.resolve();
  private newId: () => string;
  private now: () => number;

  constructor(
    private storage: OutboxStorage,
    private pairId: string,
    options: { newId?: () => string; now?: () => number } = {}
  ) {
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.now = options.now ?? Date.now;
  }

  async restore(): Promise<void> {
    let stored: OutboxItem[] = [];
    try {
      stored = parseOutbox(await this.storage.load(this.pairId));
    } catch {}
    const known = new Set(this.items.map((item) => item.deliveryId));
    const restored = stored.filter((item) => !known.has(item.deliveryId));
    if (restored.length === 0) return;
    this.items = [...restored, ...this.items];
    this.changed();
  }

  list(chatId?: string): OutboxItem[] {
    return chatId ? this.items.filter((item) => item.chatId === chatId) : [...this.items];
  }

  subscribe(listener: (items: readonly OutboxItem[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  enqueue(input: { chatId: string; text: string; images?: AttachedImage[] }): OutboxItem {
    const item: OutboxItem = {
      deliveryId: this.newId(),
      chatId: input.chatId,
      text: input.text,
      ...(input.images?.length ? { images: input.images } : {}),
      createdAt: this.now(),
      status: 'pending',
    };
    this.items = [...this.items, item];
    this.changed();
    return item;
  }

  /** 在线时取出待发项并标记在途；调用方负责真正发出 */
  drain(): OutboxItem[] {
    const ready = this.items.filter((item) => item.status === 'pending');
    if (ready.length === 0) return [];
    this.update((item) => (item.status === 'pending' ? { ...item, status: 'sending' } : item));
    return ready;
  }

  /** 连接断开：在途的结果未知，退回待发 */
  interrupted(): void {
    if (!this.items.some((item) => item.status === 'sending')) return;
    this.update((item) => (item.status === 'sending' ? { ...item, status: 'pending' } : item));
  }

  settle(deliveryId: string, ok: boolean, error?: string): void {
    if (!this.items.some((item) => item.deliveryId === deliveryId)) return;
    if (ok) {
      this.items = this.items.filter((item) => item.deliveryId !== deliveryId);
      this.changed();
      return;
    }
    this.update((item) =>
      item.deliveryId === deliveryId
        ? { ...item, status: 'failed', ...(error ? { error } : {}) }
        : item
    );
  }

  retry(deliveryId: string): void {
    this.update((item) => {
      if (item.deliveryId !== deliveryId || item.status !== 'failed') return item;
      const { error: _error, ...rest } = item;
      return { ...rest, status: 'pending' };
    });
  }

  discard(deliveryId: string): void {
    this.items = this.items.filter((item) => item.deliveryId !== deliveryId);
    this.changed();
  }

  /** 等待已排队的持久化写完（测试与解绑清理用） */
  flushed(): Promise<void> {
    return this.writing;
  }

  private update(map: (item: OutboxItem) => OutboxItem): void {
    this.items = this.items.map(map);
    this.changed();
  }

  private changed(): void {
    const snapshot = [...this.items];
    for (const listener of this.listeners) listener(snapshot);
    this.writing = this.writing
      .then(() => this.storage.save(this.pairId, snapshot))
      .catch(() => {});
  }
}

const DB_NAME = 'enso-phone-outbox';
const STORE_NAME = 'outbox';

/** 独立库：不和会话缓存共用，免得被其按容量淘汰 */
export function indexedDbOutboxStorage(
  factory: IDBFactory | undefined = globalThis.indexedDB
): OutboxStorage {
  let opening: Promise<IDBDatabase> | null = null;
  const database = (): Promise<IDBDatabase> => {
    if (!factory) return Promise.reject(new Error('IndexedDB unavailable'));
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME))
          request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      opening = null;
      throw error;
    });
    return opening;
  };
  const run = async <T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest
  ): Promise<T> => {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const request = action(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
    });
  };
  return {
    load: (pairId) => run('readonly', (store) => store.get(pairId)),
    save: async (pairId, items) => {
      await run('readwrite', (store) =>
        items.length > 0 ? store.put(items, pairId) : store.delete(pairId)
      );
    },
    remove: async (pairId) => {
      await run('readwrite', (store) => store.delete(pairId));
    },
  };
}

export const phoneOutboxStorage = indexedDbOutboxStorage();
