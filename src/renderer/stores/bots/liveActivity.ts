import type { ProjectedMessage } from '@shared/types/agent';
import type { SessionProjection } from '@/stores/sessions/reducer';
import { detailOf } from './groupTimeline';

export type LiveState = 'queued' | 'thinking' | 'typing' | 'tool' | 'retrying';

export interface LiveStep {
  id: string;
  name: string;
  detail: string;
  status: 'running' | 'done' | 'error' | 'denied';
  durationMs?: number;
  startedAt?: number;
}

export interface LiveActivity {
  state: LiveState;
  startedAt?: number;
  steps: LiveStep[];
  /** 未显示的更早步骤数 */
  more: number;
}

const SHOWN = 3;
const DETAIL_MAX = 80;
const DENIED = 'User denied this operation';

const clip = (text: string) =>
  text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text;

const textOf = (message: ProjectedMessage) =>
  message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

/** 成员当前轮的状态与最近工具步骤；空闲且未排队时为 undefined */
export function liveActivity(
  session:
    | (Pick<SessionProjection, 'status' | 'runStartedAt' | 'retry' | 'toolStartedAt'> & {
        messages: readonly ProjectedMessage[];
      })
    | undefined,
  queued: boolean
): LiveActivity | undefined {
  if (session?.status !== 'running')
    return queued ? { state: 'queued', steps: [], more: 0 } : undefined;
  const { messages } = session;
  let start = messages.length;
  while (start > 0 && messages[start - 1].role !== 'user') start--;
  const turn = messages.slice(start);
  const results = new Map(
    turn.flatMap((message) =>
      message.role === 'toolResult' && message.toolCallId ? [[message.toolCallId, message]] : []
    )
  );
  const steps: LiveStep[] = [];
  for (const message of turn) {
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type !== 'toolCall') continue;
      const done = results.get(part.id);
      const startedAt = session.toolStartedAt?.[part.id];
      steps.push({
        id: part.id,
        name: part.name,
        detail: clip(detailOf(part.arguments)),
        status: !done
          ? 'running'
          : !done.isError
            ? 'done'
            : textOf(done) === DENIED
              ? 'denied'
              : 'error',
        ...(done?.toolDurationMs !== undefined ? { durationMs: done.toolDurationMs } : {}),
        ...(!done && startedAt !== undefined ? { startedAt } : {}),
      });
    }
  }
  const last = turn.at(-1);
  const state: LiveState = session.retry
    ? 'retrying'
    : steps.some((step) => step.status === 'running')
      ? 'tool'
      : last?.role === 'assistant' && last.content.at(-1)?.type === 'text' && textOf(last)
        ? 'typing'
        : 'thinking';
  return {
    state,
    ...(session.runStartedAt !== undefined ? { startedAt: session.runStartedAt } : {}),
    steps: steps.slice(-SHOWN),
    more: Math.max(0, steps.length - SHOWN),
  };
}
