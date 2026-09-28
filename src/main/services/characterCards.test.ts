import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CharacterCardData } from '@shared/characterCard';
import { encodeRgbPng, readCharacterImage, writeCharacterCardPng } from '@shared/characterCardPng';
import { describe, expect, it } from 'vitest';
import { createCharacterCardStore } from './characterCards';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function card(id: string): CharacterCardData {
  return {
    id,
    persona: { name: '阿宁', personality: '话少', setting: '坐在窗边' },
    role: {
      callableBy: [],
      toolIds: ['todo'],
      approvalScope: 'supervised',
      duty: '只负责分派',
      providerId: 'openai',
      modelId: 'gpt',
      concurrency: 2,
      coordinator: true,
    },
    crop: { cx: 2, cy: 2, r: 1 },
  };
}

describe('createCharacterCardStore', () => {
  it('导入生成本地新 id，原路径不进文件，坏文件不挡列表', () => {
    const root = path.join(tmpdir(), `ensobot-cards-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const source = path.join(tmpdir(), `ensobot-src-${Date.now()}.png`);
    const png = writeCharacterCardPng(encodeRgbPng(4, 4, [1, 2, 3]), card(OTHER));
    expect(png.ok).toBe(true);
    if (!png.ok) return;
    writeFileSync(source, png.png);
    writeFileSync(
      path.join(root, '44444444-4444-4444-8444-444444444444.png'),
      Buffer.from('not-a-png')
    );
    symlinkSync(
      path.join(root, 'escape'),
      path.join(root, '33333333-3333-4333-8333-333333333333.png')
    );

    const store = createCharacterCardStore(root, {
      uuid: () => ID,
      jpegToPng: () => encodeRgbPng(4, 4, [9, 9, 9]),
    });
    const imported = store.importBytes(png.png);
    expect(imported).toEqual({ ok: true, cardId: ID });
    const saved = store.readPng(ID);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const text = Buffer.from(saved.png).toString('latin1');
    expect(text).not.toContain(source);
    expect(text).not.toContain(root);
    const read = readCharacterImage(saved.png);
    expect(read.ok && read.format === 'png' && read.card?.id).toBe(ID);
    expect(read.ok && read.format === 'png' && read.card?.originId).toBe(OTHER);
    expect(read.ok && read.format === 'png' && read.card?.persona.name).toBe('阿宁');
    expect(read.ok && read.format === 'png' && read.card?.role.duty).toBe('只负责分派');

    const listed = store.list();
    expect(listed.cards.map((item) => item.id)).toContain(ID);
    expect(listed.errors.map((item) => item.error).sort()).toEqual(['corrupt', 'rejected']);
    expect(store.update(`../${ID}`, card(ID))).toEqual({ ok: false, error: 'invalid-id' });
    expect(store.remove('33333333-3333-4333-8333-333333333333')).toEqual({
      ok: false,
      error: 'rejected',
    });
  });

  it('jpg 只借注入的转换器收成 PNG，裁到图外的更新会被拒绝', () => {
    const root = path.join(tmpdir(), `ensobot-cards-jpg-${Date.now()}`);
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0x00);
    let seen = false;
    const store = createCharacterCardStore(root, {
      uuid: () => ID,
      jpegToPng: (bytes) => {
        seen = bytes[0] === 0xff;
        return encodeRgbPng(4, 4, [4, 5, 6]);
      },
    });
    expect(store.importBytes(jpeg)).toEqual({ ok: true, cardId: ID });
    expect(seen).toBe(true);
    const outside = card(ID);
    outside.crop = { cx: 1, cy: 1, r: 3 };
    expect(store.update(ID, outside).ok).toBe(false);
    const current = store.get(ID);
    expect(current?.bare).toBe(true);
    expect(current?.previewUrl).toBe(`ensobot-card://card/${ID}`);
  });
});
