import { describe, expect, it } from 'vitest';
import { normalizeBotMaxRunningTurns } from './concurrency';

describe('normalizeBotMaxRunningTurns', () => {
  it.each([undefined, null, '8', {}, [], true, NaN, Infinity, -Infinity, 1.5])(
    'falls back to four for invalid input %j',
    (value) => expect(normalizeBotMaxRunningTurns(value)).toBe(4)
  );
  it.each([
    [1, 1],
    [4, 4],
    [16, 16],
    [0, 1],
    [-2, 1],
    [17, 16],
  ])('clamps integer %i to %i', (value, expected) =>
    expect(normalizeBotMaxRunningTurns(value)).toBe(expected)
  );
});
