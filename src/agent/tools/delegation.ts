import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { MemoryInvoker } from './memory';

export type DelegationOp = 'delegate' | 'check_delegation';

export function normalizeDelegationParams(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const params = { ...raw } as Record<string, unknown>;
  for (const key of ['id', 'context', 'cancel']) if (params[key] === null) delete params[key];
  if (params.cancel === 'true') params.cancel = true;
  if (params.cancel === 'false') params.cancel = false;
  return params;
}

export function createDelegationTools(invoker: MemoryInvoker<DelegationOp>): ToolDefinition[] {
  const define = (
    name: DelegationOp,
    description: string,
    properties: Record<string, unknown>,
    required: string[]
  ): ToolDefinition => ({
    name,
    label: name,
    description,
    parameters: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    } as unknown as ToolDefinition['parameters'],
    prepareArguments: normalizeDelegationParams as ToolDefinition['prepareArguments'],
    async execute(_id, params, signal) {
      try {
        const result = await invoker.invoke(name, normalizeDelegationParams(params), signal);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: undefined };
      } catch (error) {
        return {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          details: undefined,
          isError: true,
        };
      }
    },
  });
  return [
    define(
      'delegate',
      'Delegate a task to another member by name or id. Returns immediately; results arrive asynchronously. Context is truncated to 8000 characters.',
      {
        to: { type: 'string', minLength: 1 },
        task: { type: 'string', minLength: 1 },
        context: { type: 'string' },
      },
      ['to', 'task']
    ),
    define(
      'check_delegation',
      'List your delegations, inspect one by id, or cancel it (id required for cancel).',
      { id: { type: 'string', minLength: 1 }, cancel: { type: 'boolean' } },
      []
    ),
  ];
}
