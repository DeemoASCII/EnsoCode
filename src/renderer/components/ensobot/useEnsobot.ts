import type { PhoneToHost } from '@enso/pair';
import type { EnsobotActionResult, EnsobotSnapshot } from '@shared/ensobot/snapshot';
import { useEffect, useState } from 'react';
import { useRemoteNodesStore } from '@/stores/remoteNodes';
import { mergeNodeSnapshot } from './ensobotView';

export type CardDetails = Awaited<ReturnType<typeof window.electronAPI.ensobot.listCards>>;

export function useEnsobotSnapshot() {
  const [snapshots, setSnapshots] = useState<Record<string, EnsobotSnapshot>>({});
  const [error, setError] = useState('');
  const nodeId = useRemoteNodesStore((state) => state.activeNodeId);
  useEffect(() => {
    let disposed = false;
    const apply = (source: string, next: EnsobotSnapshot) => {
      if (disposed) return;
      setSnapshots((current) => mergeNodeSnapshot(current, source, next));
    };
    const offLocal = window.electronAPI.ensobot.onChanged((next) => apply('local', next));
    const offRemote = window.electronAPI.nodes.onMessage((message) => {
      const frame = message.payload as { type?: string; snapshot?: EnsobotSnapshot } | null;
      if (frame?.type === 'ensobot-snapshot' && frame.snapshot)
        apply(message.nodeId, frame.snapshot);
    });
    void window.electronAPI.ensobot
      .getState()
      .then((next) => apply('local', next))
      .catch((reason: unknown) => {
        if (!disposed) setError(String(reason));
      });
    return () => {
      disposed = true;
      offLocal();
      offRemote();
    };
  }, []);
  return { snapshot: snapshots[nodeId] ?? null, error };
}

/** 同一节点无 deliveryId 的旧协议操作必须串行，避免多个弹窗共享一张回执。 */
const pendingByNode = new Map<string, Promise<unknown>>();
export function runCommand(
  command: PhoneToHost,
  local: () => Promise<EnsobotActionResult>,
  deliveryId?: string
): Promise<EnsobotActionResult> {
  const nodeId = useRemoteNodesStore.getState().activeNodeId;
  if (nodeId === 'local')
    return local().catch((reason: unknown) => ({ ok: false, error: String(reason) }));
  const pending = deliveryId ? Promise.resolve() : (pendingByNode.get(nodeId) ?? Promise.resolve());
  const job = pending.then(
    () =>
      new Promise<EnsobotActionResult>((resolve) => {
        let finished = false;
        const finish = (result: EnsobotActionResult) => {
          if (finished) return;
          finished = true;
          window.clearTimeout(timer);
          off();
          resolve(result);
        };
        const off = window.electronAPI.nodes.onMessage((message) => {
          if (message.nodeId !== nodeId) return;
          const frame = message.payload as
            | ({ type?: string; deliveryId?: string } & EnsobotActionResult)
            | null;
          if (frame?.type !== 'ensobot-result' || frame.deliveryId !== deliveryId) return;
          finish(frame);
        });
        const timer = window.setTimeout(() => finish({ ok: false, error: 'timeout' }), 10_000);
        void window.electronAPI.nodes
          .send(nodeId, command)
          .then((result) => {
            if (!result.ok) finish(result);
          })
          .catch((reason: unknown) => finish({ ok: false, error: String(reason) }));
      })
  );
  if (!deliveryId) {
    pendingByNode.set(nodeId, job);
    void job.finally(() => {
      if (pendingByNode.get(nodeId) === job) pendingByNode.delete(nodeId);
    });
  }
  return job;
}
