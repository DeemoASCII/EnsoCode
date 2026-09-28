import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { normalizeSpeakParams } from '@shared/ensobot/speak';

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', description: 'Bubble text. Trimmed before it is checked.' },
    message: {
      type: 'string',
      description: 'Same as text, used when text was left blank.',
    },
    deliveryId: {
      type: 'string',
      description: 'Optional idempotency id, at most 128 characters.',
    },
  },
} as const;

/** 说话工具只抛出气泡事件然后返回。它不选车道，也不结束这一轮。 */
export function createEnsobotSayTool(
  emit: (text: string, deliveryId: string) => void
): ToolDefinition {
  return {
    name: 'ensobot_say',
    label: 'Say',
    description:
      'Post one short chat bubble, then keep working. Do not use this to end the turn, approve anything, or decide whose message goes first.',
    promptSnippet: 'ensobot_say: post a short bubble and continue the current task',
    parameters: PARAMETERS as unknown as ToolDefinition['parameters'],
    async execute(_toolCallId, params) {
      const normalized = normalizeSpeakParams(params, randomUUID);
      if (!normalized.ok) {
        throw new Error(
          normalized.error === 'empty'
            ? 'text is empty'
            : normalized.error === 'too-long'
              ? 'text is too long'
              : 'text must be a string'
        );
      }
      emit(normalized.text, normalized.deliveryId);
      return {
        content: [{ type: 'text' as const, text: 'Bubble posted. Continue the task.' }],
        details: { deliveryId: normalized.deliveryId },
      };
    },
  };
}
