import { describe, expect, it } from 'vitest';
import { focusStep, messageItemKey, snippetParts } from './focus';

describe('messageItemKey', () => {
  const items = [{ key: '0' }, { key: '1-0' }, { key: '1-2' }, { key: '3' }, { key: '13-0' }];
  it('用户消息取下标本身，助手消息取首个「下标-part」', () => {
    expect(messageItemKey(items, 0)).toBe('0');
    expect(messageItemKey(items, 1)).toBe('1-0');
    expect(messageItemKey(items, 13)).toBe('13-0');
  });
  it('不把 13 误认成 1，找不到返回 undefined', () => {
    expect(messageItemKey([{ key: '13-0' }], 1)).toBeUndefined();
    expect(messageItemKey(items, 2)).toBeUndefined();
  });
});

describe('focusStep', () => {
  it('目标比已加载最早一条还早：有更早历史就继续加载，否则放弃', () => {
    expect(focusStep({ target: 5, earliest: 20, hasOlder: true, loading: false })).toBe('load');
    expect(focusStep({ target: 5, earliest: 20, hasOlder: true, loading: true })).toBe('wait');
    expect(focusStep({ target: 5, earliest: 20, hasOlder: false, loading: false })).toBe('give-up');
  });
  it('已加载到目标就滚动；尚无任何数据时等待', () => {
    expect(focusStep({ target: 20, earliest: 20, hasOlder: true, loading: false })).toBe('scroll');
    expect(focusStep({ target: 30, earliest: 0, hasOlder: false, loading: false })).toBe('scroll');
    expect(focusStep({ target: 3, earliest: undefined, hasOlder: false, loading: false })).toBe(
      'wait'
    );
  });
});

describe('snippetParts', () => {
  it('按命中区间切分，越界与重叠区间被忽略', () => {
    expect(
      snippetParts('abcdef', [
        [1, 3],
        [2, 4],
        [5, 9],
      ])
    ).toEqual([
      { text: 'a', match: false },
      { text: 'bc', match: true },
      { text: 'def', match: false },
    ]);
    expect(snippetParts('abc', [])).toEqual([{ text: 'abc', match: false }]);
  });
});
