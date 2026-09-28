import { describe, expect, it } from 'vitest';
import { normalizeSpeakParams } from './speak';

const nextId = () => '11111111-1111-4111-8111-111111111111';

describe('normalizeSpeakParams', () => {
  it('先去掉空格，再用 message 补上没写的 text', () => {
    expect(normalizeSpeakParams({ text: '  你好  ', deliveryId: '  bubble-1  ' }, nextId)).toEqual({
      ok: true,
      text: '你好',
      deliveryId: 'bubble-1',
    });
    expect(normalizeSpeakParams({ message: '转一句' }, nextId)).toEqual({
      ok: true,
      text: '转一句',
      deliveryId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('空的、超长的、不是文本的，在收下之前就拒绝', () => {
    expect(normalizeSpeakParams({ text: '   ' }, nextId)).toEqual({ ok: false, error: 'empty' });
    expect(normalizeSpeakParams({ text: 'a'.repeat(8_001) }, nextId)).toEqual({
      ok: false,
      error: 'too-long',
    });
    expect(normalizeSpeakParams({ text: 1 }, nextId)).toEqual({ ok: false, error: 'bad-params' });
    expect(normalizeSpeakParams({ text: 'hi', deliveryId: 'x'.repeat(129) }, nextId)).toEqual({
      ok: false,
      error: 'bad-params',
    });
  });
});
