import { describe, expect, it, vi } from 'vitest';
import { loadWorkField } from './ensobotWorkEvidence';

describe('EnsoBot 按需工具证据', () => {
  it('按同一 revision 连续读取，完整保留多字节文本与空白', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: '中文\n', nextOffset: 3, revision: 'r' })
      .mockResolvedValueOnce({ ok: true, text: ' 结果 ', nextOffset: null, revision: 'r' });
    expect(await loadWorkField(read, 'id', 'output')).toBe('中文\n 结果 ');
    expect(read.mock.calls[1][0]).toEqual({
      evidenceId: 'id',
      field: 'output',
      offset: 3,
      revision: 'r',
    });
  });
  it('内容改变时从头读，不能把旧页拼进新结果', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: '旧', nextOffset: 1, revision: 'r1' })
      .mockResolvedValueOnce({ ok: false, error: 'stale' })
      .mockResolvedValueOnce({ ok: true, text: '新的完整结果', nextOffset: null, revision: 'r2' });
    expect(await loadWorkField(read, 'id', 'output')).toBe('新的完整结果');
    expect(read.mock.calls[2][0].offset).toBe(0);
  });
  it('持续改变、不前进的游标或失败不能无限读取或冒充完整结果', async () => {
    await expect(
      loadWorkField(vi.fn().mockResolvedValue({ ok: false, error: 'stale' }), 'id', 'output')
    ).rejects.toThrow('stale');
    await expect(
      loadWorkField(
        vi.fn().mockResolvedValue({ ok: true, text: 'x', nextOffset: 0, revision: 'r' }),
        'id',
        'output'
      )
    ).rejects.toThrow('invalid');
    await expect(
      loadWorkField(vi.fn().mockResolvedValue({ ok: false, error: 'not-found' }), 'id', 'output')
    ).rejects.toThrow('not-found');
  });
});
