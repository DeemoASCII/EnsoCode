import { expect, it } from 'vitest';
import { parseEnsobotResponse } from './interaction';

const base = { cardId: '11111111-1111-4111-8111-111111111111', id: 'opaque-token' };
it('只接受明确人类审批决策或非空回答，丢弃调用方伪造会话身份', () => {
  const valid = { ...base, kind: 'approval', decision: 'allowSession' };
  expect(parseEnsobotResponse({ ...valid, sessionId: 'forged', generation: 'forged' })).toEqual(
    valid
  );
  expect(parseEnsobotResponse({ ...base, kind: 'ask', answer: ' yes ' })).toEqual({
    ...base,
    kind: 'ask',
    answer: 'yes',
  });
  for (const input of [
    null,
    {},
    { ...valid, decision: 'full' },
    { ...valid, cardId: '../' },
    { ...valid, id: '' },
    { ...base, kind: 'ask', answer: '  ' },
    { ...base, kind: 'ask', answer: 'a'.repeat(8001) },
  ]) {
    expect(parseEnsobotResponse(input)).toBeNull();
  }
});
