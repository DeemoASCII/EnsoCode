import type { EnsobotWorkReadRequest, EnsobotWorkReadResult } from '@shared/ensobot/evidence';

type Reader = (request: EnsobotWorkReadRequest) => Promise<EnsobotWorkReadResult>;

/** 每次展开固定节点与证据身份。中途切节点的回执不能拼进另一节点。 */
export function readWorkChunk(
  nodeId: string,
  request: EnsobotWorkReadRequest
): Promise<EnsobotWorkReadResult> {
  if (nodeId === 'local') return window.electronAPI.ensobot.workRead(request);
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    let finished = false;
    const finish = (result: EnsobotWorkReadResult | Error) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      off();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const off = window.electronAPI.nodes.onMessage((message) => {
      if (message.nodeId !== nodeId) return;
      const frame = message.payload as {
        type?: string;
        requestId?: string;
        result?: EnsobotWorkReadResult;
      } | null;
      if (frame?.type === 'ensobot-work-result' && frame.requestId === requestId && frame.result)
        finish(frame.result);
    });
    const timer = window.setTimeout(() => finish(new Error('timeout')), 10000);
    void window.electronAPI.nodes
      .send(nodeId, { type: 'ensobot-work-read', requestId, request })
      .then((result) => {
        if (!result.ok) finish(new Error(result.error ?? 'offline'));
      })
      .catch(() => finish(new Error('offline')));
  });
}

/** 分块不截断内容；版本改变时丢弃已读页，从头重读，持续变更则让用户重试。 */
export async function loadWorkField(
  read: Reader,
  evidenceId: string,
  field: 'parameters' | 'output'
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let offset = 0;
    let revision: string | undefined;
    const chunks: string[] = [];
    for (;;) {
      const result = await read({ evidenceId, field, offset, ...(revision ? { revision } : {}) });
      if (!result.ok) {
        if (result.error === 'stale') break;
        throw new Error(result.error);
      }
      if (
        !result.revision ||
        (revision && result.revision !== revision) ||
        typeof result.text !== 'string'
      )
        throw new Error('invalid evidence response');
      revision = result.revision;
      chunks.push(result.text);
      if (result.nextOffset === null) return chunks.join('');
      if (
        !Number.isSafeInteger(result.nextOffset) ||
        result.nextOffset <= offset ||
        result.nextOffset !== offset + result.text.length
      )
        throw new Error('invalid evidence cursor');
      offset = result.nextOffset;
    }
  }
  throw new Error('stale');
}
