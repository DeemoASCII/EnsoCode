import type { ProjectedMessage } from '@shared/types/agent';
import { useEffect, useMemo, useState } from 'react';
import { ChatHostContext } from '@/components/chat/chatHost';
import { MessageTimeline } from '@/components/chat/MessageTimeline';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/i18n';
import { buildTimeline } from '@/stores/sessions/timeline';

interface SessionHistoryDialogProps {
  /** null = 关闭 */
  conversationId: string | null;
  title: string;
  onClose: () => void;
}

/** 成员旧会话 / 群消息所在会话的只读查看 */
export function SessionHistoryDialog({
  conversationId,
  title,
  onClose,
}: SessionHistoryDialogProps) {
  const { t } = useI18n();
  const [page, setPage] = useState<{ messages: ProjectedMessage[]; baseIndex: number } | null>(
    null
  );
  const [error, setError] = useState<string | undefined>();
  const [loadingOlder, setLoadingOlder] = useState(false);

  useEffect(() => {
    setPage(null);
    setError(undefined);
    if (!conversationId) return;
    let alive = true;
    void window.electronAPI.bots.sessionHistory({ conversationId }).then((result) => {
      if (!alive) return;
      if (result.ok) setPage({ messages: result.messages, baseIndex: result.baseIndex });
      else
        setError(
          result.code === 'not-found' ? t('This conversation has no history yet.') : result.error
        );
    });
    return () => {
      alive = false;
    };
  }, [conversationId, t]);

  const loadOlder = async () => {
    if (!conversationId || !page || page.baseIndex <= 0 || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const result = await window.electronAPI.bots.sessionHistory({
        conversationId,
        beforeIndex: page.baseIndex,
      });
      if (result.ok && result.baseIndex + result.messages.length === page.baseIndex) {
        setPage({ messages: [...result.messages, ...page.messages], baseIndex: result.baseIndex });
      }
    } finally {
      setLoadingOlder(false);
    }
  };

  const items = useMemo(
    () =>
      page
        ? buildTimeline(page.messages, false, [], undefined, { historyBaseIndex: page.baseIndex })
        : [],
    [page]
  );
  const host = useMemo(
    () => ({ sessionId: conversationId, canRewind: false, canRetry: false }),
    [conversationId]
  );

  return (
    <Dialog open={conversationId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[80vh] max-w-3xl flex-col">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <ChatHostContext.Provider value={host}>
          <div className="@container flex min-h-0 flex-1 flex-col border-t">
            {error ? (
              <p className="p-6 text-muted-foreground text-sm">{error}</p>
            ) : (
              <MessageTimeline
                items={items}
                busy={page === null}
                loading={page === null}
                running={false}
                emptyTitle={title}
                hasOlder={Boolean(page && page.baseIndex > 0)}
                historyLoading={loadingOlder}
                olderCursor={page?.baseIndex}
                onStartReached={page && page.baseIndex > 0 ? () => void loadOlder() : undefined}
              />
            )}
          </div>
        </ChatHostContext.Provider>
      </DialogContent>
    </Dialog>
  );
}
