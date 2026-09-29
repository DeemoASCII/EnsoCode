import { describe, expect, it } from 'vitest';
import { applyInjectedDraft } from './injectedDraft';

describe('applyInjectedDraft', () => {
  const image = { data: 'image', mimeType: 'image/png' };
  const current = {
    segments: [{ type: 'text' as const, text: 'editing' }],
    images: [image],
    slash: null,
  };

  it('撤回追加文字和附件，不覆盖当前编辑内容', () => {
    const result = applyInjectedDraft(current, { text: 'continue', images: [image] }, true);
    expect(result).toEqual({
      ...current,
      segments: [...current.segments, { type: 'text', text: '\n\ncontinue' }],
      images: [image, image],
    });
    expect(current.images).toEqual([image]);
  });

  it('保留 mention 和已有 slash，撤回文本不转换成新指令', () => {
    const segments = [{ type: 'file' as const, path: '/file' }];
    expect(
      applyInjectedDraft({ ...current, segments, slash: 'plan' }, { text: '/help' }, true)
    ).toEqual({
      segments: [...segments, { type: 'text', text: '\n\n/help' }],
      slash: 'plan',
      images: [image],
    });
  });

  it('纯图片撤回保留已有文字；空输入框恢复 slash', () => {
    expect(applyInjectedDraft(current, { images: [image] }, true).segments).toEqual(
      current.segments
    );
    expect(
      applyInjectedDraft({ segments: [], images: [], slash: null }, { text: '/help' }, true)
    ).toMatchObject({ slash: '/help', segments: [] });
  });

  it('历史回退仍然替换内容并清除旧附件', () => {
    expect(applyInjectedDraft(current, { text: 'rewound' })).toEqual({
      segments: [{ type: 'text', text: 'rewound' }],
      images: [],
      slash: null,
    });
  });
});
