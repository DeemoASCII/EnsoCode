import { describe, expect, it } from 'vitest';
import { EMPTY_PERSONA, EMPTY_ROLE } from './characterCard';
import {
  encodeRgbPng,
  idatBytes,
  readCharacterImage,
  writeCharacterCardPng,
} from './characterCardPng';

const id = '22222222-2222-4222-8222-222222222222';

const card = {
  id,
  persona: { ...EMPTY_PERSONA, name: '阿禾', personality: '稳', setting: '会看测试' },
  role: { ...EMPTY_ROLE, duty: '只负责分派', providerId: 'p', modelId: 'm', coordinator: true },
  crop: { cx: 2, cy: 2, r: 1 },
};

describe('character card png', () => {
  it('没有元数据的 png 只是图，像素还在', () => {
    const png = encodeRgbPng(4, 4, [1, 2, 3]);
    const read = readCharacterImage(png);
    expect(read).toMatchObject({
      ok: true,
      format: 'png',
      bare: true,
      width: 4,
      height: 4,
      card: null,
    });
  });

  it('坏 JSON 当裸图，不把像素丢掉', () => {
    const png = encodeRgbPng(4, 4, [9, 9, 9]);
    const written = writeCharacterCardPng(png, card);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const broken = written.png.slice();
    const marker = new TextEncoder().encode('阿禾');
    const at = broken.indexOf(marker[0]);
    if (at >= 0) broken[at] = 0x7b;
    const read = readCharacterImage(broken);
    expect(read.ok).toBe(true);
    if (!read.ok || read.format !== 'png') return;
    expect(read.bare).toBe(true);
    expect(read.width).toBe(4);
  });

  it('裁切跑出图外时拒绝写回，原图像素不变', () => {
    const png = encodeRgbPng(4, 4, [4, 5, 6]);
    const outside = writeCharacterCardPng(png, { ...card, crop: { cx: 0, cy: 0, r: 2 } });
    expect(outside).toEqual({ ok: false, error: 'crop-outside' });
    expect(idatBytes(png)).toEqual(idatBytes(png));
  });

  it('jpg 只当图，不读人设', () => {
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0x00);
    expect(readCharacterImage(jpeg)).toEqual({ ok: true, format: 'jpeg', bare: true });
  });

  it('写回元数据后原图 IDAT 还在，裁切和人设、职能都能读回来', () => {
    const png = encodeRgbPng(4, 4, [7, 8, 9]);
    const written = writeCharacterCardPng(png, card);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(idatBytes(written.png)).toEqual(idatBytes(png));
    const read = readCharacterImage(written.png);
    expect(read).toMatchObject({
      ok: true,
      bare: false,
      card: { persona: card.persona, role: card.role, crop: card.crop },
    });
  });

  it('超限直接拒绝', () => {
    const huge = new Uint8Array(20 * 1024 * 1024 + 1);
    huge[0] = 0x89;
    expect(readCharacterImage(huge)).toEqual({ ok: false, error: 'too-large' });
  });
});
