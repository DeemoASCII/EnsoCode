import { expect, it } from 'vitest';
import { createDelegationTools, normalizeDelegationParams } from './delegation';
import { MemoryInvoker } from './memory';

it('normalizes optional nulls and boolean text before full typed schema validation', () => {
  expect(normalizeDelegationParams({ id: null, cancel: 'false' })).toEqual({ cancel: false });
  const tools = createDelegationTools(
    new MemoryInvoker({ sessionId: 's', generation: 'g' }, () => {})
  );
  expect(tools.map((tool) => tool.name)).toEqual(['delegate', 'check_delegation']);
  for (const tool of tools) {
    const schema = tool.parameters as unknown as {
      type: string;
      properties: Record<string, unknown>;
    };
    expect(schema.type).toBe('object');
    expect(tool.prepareArguments).toBeDefined();
    for (const property of Object.values(schema.properties))
      expect(property).toHaveProperty('type');
  }
});
