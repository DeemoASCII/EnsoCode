import { describe, expect, it } from 'vitest';
import { parseCharacterCard, sanitizeBotName } from './characterCard';

describe('sanitizeBotName', () => {
  it('空白转下划线、去掉非法字符并截断到 24 字', () => {
    expect(sanitizeBotName(' Dr. Who ')).toBe('Dr_Who');
    expect(sanitizeBotName('林 经理!')).toBe('林_经理');
    expect([...sanitizeBotName('a'.repeat(40))]).toHaveLength(24);
    expect(sanitizeBotName('!!!')).toBe('');
  });
});

describe('parseCharacterCard', () => {
  it('解析 SillyTavern V2 的 data 字段生成草稿', () => {
    const card = JSON.stringify({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Aria Stone',
        description: '{{char}} is a careful reviewer. Loves tests.',
        personality: 'Calm, precise',
        scenario: 'Helps {{user}} ship releases',
      },
    });
    const result = parseCharacterCard(card);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.name).toBe('Aria_Stone');
    expect(result.draft.scope).toBe('Aria Stone is a careful reviewer.');
    expect(result.draft.persona).toContain('Aria Stone is a careful reviewer. Loves tests.');
    expect(result.draft.persona).toContain('Calm, precise');
    expect(result.draft.persona).toContain('Helps the user ship releases');
  });

  it('兼容 V1 顶层字段', () => {
    const result = parseCharacterCard(JSON.stringify({ name: 'Bob', description: 'Ops guy' }));
    expect(result.ok && result.draft.name).toBe('Bob');
  });

  it('坏 JSON 与非人物卡分别报错', () => {
    expect(parseCharacterCard('{')).toEqual({ ok: false, error: 'invalid-json' });
    expect(parseCharacterCard('[1]')).toEqual({ ok: false, error: 'not-a-card' });
    expect(parseCharacterCard(JSON.stringify({ data: { description: 'x' } }))).toEqual({
      ok: false,
      error: 'not-a-card',
    });
  });
});
