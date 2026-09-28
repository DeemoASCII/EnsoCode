export type EnsobotLane = 'human' | 'bot' | 'background';

export interface LaneDelivery {
  deliveryId: string;
  lane: EnsobotLane;
  cardId: string;
  text: string;
}

const RANK: Record<EnsobotLane, number> = { human: 0, bot: 1, background: 2 };

/** 同一个人身上排队：人的话，再是 bot 的话，最后才是后台任务。同车道保持原顺序。 */
export function orderDeliveries<T extends LaneDelivery>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => RANK[a.item.lane] - RANK[b.item.lane] || a.index - b.index)
    .map((entry) => entry.item);
}

export type DeliveryAccept =
  | { ok: true }
  | { ok: false; reason: 'empty-id' | 'duplicate' | 'worker-offline' };

/**
 * 同一条 deliveryId 只收下一次。worker 不在线时拒绝，不能把「已入队」当成「已送到」。
 * 已经见过的 id 优先算重复，避免离线重试把旧回执说成新的失败原因。
 */
export function acceptDelivery(input: {
  deliveryId: string;
  seen: ReadonlySet<string>;
  workerReady: boolean;
}): DeliveryAccept {
  if (!input.deliveryId) return { ok: false, reason: 'empty-id' };
  if (input.seen.has(input.deliveryId)) return { ok: false, reason: 'duplicate' };
  if (!input.workerReady) return { ok: false, reason: 'worker-offline' };
  return { ok: true };
}
