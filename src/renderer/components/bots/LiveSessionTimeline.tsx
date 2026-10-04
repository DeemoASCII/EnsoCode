import { useEffect, useMemo, useRef } from 'react';
import { ChatHostContext } from '@/components/chat/chatHost';
import {
  CHAT_COL,
  MessageTimeline,
  type MessageTimelineHandle,
} from '@/components/chat/MessageTimeline';
import { RetryBar } from '@/components/chat/RetryBar';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useBotsStore } from '@/stores/bots';
import { buildTimeline } from '@/stores/sessions/timeline';

interface LiveSessionTimelineProps {
  conversationId: string;
  speaker: { name: string; color: string };
  emptyTitle: string;
}

/** 成员会话的实时投影（私聊正文、群里正在回复的成员） */
export function LiveSessionTimeline({
  conversationId,
  speaker,
  emptyTitle,
}: LiveSessionTimelineProps) {
  const projection = useBotsStore((s) => s.sessions[conversationId]);
  const historyLoading = useBotsStore((s) => Boolean(s.sessionHistoryLoading[conversationId]));
  const timelineRef = useRef<MessageTimelineHandle>(null);
  const running = projection?.status === 'running';
  const items = useMemo(
    () =>
      projection
        ? buildTimeline(projection.messages, running, projection.customEntries, undefined, {
            historyBaseIndex: projection.historyBaseIndex,
            toolOutputs: projection.toolOutputs,
            pendingApprovals: projection.pendingApprovals,
            toolStartedAt: projection.toolStartedAt,
          })
        : [],
    [projection, running]
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: items 是触发信号
  useEffect(() => {
    if (timelineRef.current?.isAtBottom()) timelineRef.current.pinToBottom();
  }, [items]);

  const { name, color } = speaker;
  const host = useMemo(
    () => ({
      sessionId: conversationId,
      canRewind: false,
      canRetry: false,
      speaker: { name, color },
    }),
    [conversationId, name, color]
  );
  const hasOlder = (projection?.historyBaseIndex ?? 0) > 0;

  return (
    <ChatHostContext.Provider value={host}>
      <div className="@container flex min-h-0 flex-1 flex-col">
        <MessageTimeline
          key={conversationId}
          ref={timelineRef}
          items={items}
          busy={running}
          loading={false}
          running={running}
          runStartedAt={projection?.runStartedAt}
          lastOutputAt={projection?.lastOutputAt}
          error={projection?.status === 'failed' ? projection.error : undefined}
          emptyTitle={emptyTitle}
          historyLoading={historyLoading}
          hasOlder={hasOlder}
          olderCursor={projection?.historyBaseIndex}
          onStartReached={
            hasOlder
              ? () => void useBotsStore.getState().loadOlderSession(conversationId)
              : undefined
          }
        />
        {projection?.retry && (
          <div className={CHAT_COL}>
            <RetryBar retry={projection.retry} />
          </div>
        )}
      </div>
    </ChatHostContext.Provider>
  );
}

interface LiveSessionDialogProps {
  /** null = 关闭 */
  conversationId: string | null;
  title: string;
  speaker: { name: string; color: string };
  /** 弹窗底部（该会话的审批 / 提问） */
  footer?: React.ReactNode;
  onClose: () => void;
}

/** 群里正在回复的成员：实时查看其群会话 */
export function LiveSessionDialog({
  conversationId,
  title,
  speaker,
  footer,
  onClose,
}: LiveSessionDialogProps) {
  return (
    <Dialog open={conversationId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[80vh] max-w-3xl flex-col">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col border-t">
          {conversationId && (
            <LiveSessionTimeline
              conversationId={conversationId}
              speaker={speaker}
              emptyTitle={title}
            />
          )}
        </div>
        {footer && <div className={CHAT_COL}>{footer}</div>}
      </DialogContent>
    </Dialog>
  );
}
