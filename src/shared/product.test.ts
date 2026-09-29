import { describe, expect, it } from 'vitest';
import { productFor, userDataDirectory } from './product';

describe('独立产品身份', () => {
  it('EnsoCode 默认构建保持原身份，EnsoBot 与其完全隔离', () => {
    expect(productFor(undefined)).toMatchObject({
      name: 'EnsoCode',
      appId: 'com.j3n5en.enso-code',
    });
    expect(productFor('ensobot')).toMatchObject({
      name: 'EnsoBot',
      appId: 'com.j3n5en.ensobot',
      slug: 'ensobot',
    });
    expect(userDataDirectory('ensobot', true)).toBe('ensobot');
    expect(userDataDirectory('ensobot', false)).toBe('ensobot-dev');
    expect(userDataDirectory(undefined, true)).toBe('enso-code');
    expect(userDataDirectory(undefined, false)).toBe('enso-code-dev');
  });
  it('错误的构建产品值不能悄悄产出 EnsoCode', () => {
    expect(() => productFor('EnsoBot')).toThrow();
  });
});
