import { describe, expect, it } from 'vitest';
import { applyEnsobotSnapshot, type EnsobotSnapshot } from './snapshot';

function snap(seq: number, deliveryIds: string[]): EnsobotSnapshot {
  return {
    seq,
    cards: [],
    bubbles: deliveryIds.map((deliveryId, index) => ({
      seq: index + 1,
      deliveryId,
      cardId: '11111111-1111-4111-8111-111111111111',
      lane: 'human',
      text: deliveryId,
      authorKind: 'human',
    })),
    board: [],
    groups: [],
    roomMessages: [],
    tasks: [],
    workspace: { projectId: null, projectName: null, sessionId: null },
    notices: [],
  };
}

describe('applyEnsobotSnapshot', () => {
  it('更旧或相同的 seq 留着现在这份，重复的气泡只算一次', () => {
    const current = snap(2, ['a']);
    expect(
      applyEnsobotSnapshot(current, snap(2, ['b'])).bubbles.map((item) => item.deliveryId)
    ).toEqual(['a']);
    expect(applyEnsobotSnapshot(current, snap(1, ['b']))).toBe(current);
    const next = applyEnsobotSnapshot(current, snap(3, ['a', 'a', 'b']));
    expect(next.bubbles.map((item) => item.deliveryId)).toEqual(['a', 'b']);
    expect(next.seq).toBe(3);
  });
});
