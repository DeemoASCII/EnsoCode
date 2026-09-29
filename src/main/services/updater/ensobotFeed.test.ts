import { describe, expect, it } from 'vitest';
import { selectEnsobotFeed } from './ensobotFeed';

const release = (tag: string, extra = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: true,
  ...extra,
});

describe('EnsoBot 独立升级源', () => {
  it('只选择 EnsoBot 已发布 tag，忽略正式 EnsoCode、草稿及坏输入，按数值比较版本', () => {
    expect(
      selectEnsobotFeed([
        null,
        release('v99.0.0', { prerelease: false }),
        release('ensobot-v1.0.0', { draft: true }),
        release('ensobot-v0.0.9'),
        release('ensobot-v0.0.10'),
        release('ensobot-v0.0.2'),
        release('ensobot-v0.01.99'),
        release('ensobot-v0.0.11/../latest'),
      ])
    ).toEqual({
      provider: 'generic',
      channel: 'ensobot',
      url: 'https://github.com/J3n5en/EnsoCode/releases/download/ensobot-v0.0.10/',
      useMultipleRangeRequest: false,
    });
  });
  it('没有发布时显式失败，不回退 latest 或 EnsoCode', () => {
    expect(() => selectEnsobotFeed([release('v0.2.1')])).toThrow();
    expect(() => selectEnsobotFeed({ message: 'API rate limit exceeded' })).toThrow();
  });
});
