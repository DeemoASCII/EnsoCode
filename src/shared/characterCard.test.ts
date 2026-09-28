import { describe, expect, it } from 'vitest';
import {
  type CharacterCardData,
  characterCardPreviewUrl,
  cropInsideImage,
  EMPTY_PERSONA,
  EMPTY_ROLE,
  parseCharacterCardData,
  previewUrlCardId,
} from './characterCard';

const id = '11111111-1111-4111-8111-111111111111';

function card(overrides: Partial<CharacterCardData> = {}): CharacterCardData {
  return {
    id,
    persona: { ...EMPTY_PERSONA, name: '小满' },
    role: { ...EMPTY_ROLE, duty: '写测试', providerId: 'p', modelId: 'm' },
    crop: { cx: 4, cy: 4, r: 2 },
    ...overrides,
  };
}

describe('character card crop and preview', () => {
  it('圆形必须整块落在图里', () => {
    expect(cropInsideImage({ cx: 4, cy: 4, r: 2 }, 8, 8)).toBe(true);
    expect(cropInsideImage({ cx: 1, cy: 1, r: 2 }, 8, 8)).toBe(false);
    expect(cropInsideImage({ cx: 4, cy: 4, r: 0 }, 8, 8)).toBe(false);
  });

  it('预览地址只有卡 id，路径和越界 id 都组不出来', () => {
    expect(characterCardPreviewUrl(id)).toBe(`ensobot-card://card/${id}`);
    expect(characterCardPreviewUrl('../etc/passwd')).toBeNull();
    expect(previewUrlCardId(`ensobot-card://card/${id}`)).toBe(id);
    expect(previewUrlCardId('ensobot-card://card/../secret')).toBeNull();
    expect(previewUrlCardId('local-image://posix/tmp/a.png')).toBeNull();
  });

  it('坏 JSON 形状读不成卡', () => {
    expect(parseCharacterCardData({ v: 1 }, 8, 8)).toBeNull();
    expect(parseCharacterCardData({ v: 2, id }, 8, 8)).toBeNull();
  });

  it('裁切跑出图外时整份元数据不当成卡', () => {
    const raw = {
      v: 1,
      id,
      persona: card().persona,
      role: card().role,
      crop: { cx: 1, cy: 1, r: 4 },
    };
    expect(parseCharacterCardData(raw, 8, 8)).toBeNull();
  });

  it('人设和职能分开读回来', () => {
    const value = card();
    const raw = { v: 1, ...value };
    expect(parseCharacterCardData(raw, 8, 8)).toEqual(value);
  });
});
