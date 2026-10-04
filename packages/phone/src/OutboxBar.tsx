import { RotateCw, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { OutboxItem } from './botOutbox';

interface Props {
  items: readonly OutboxItem[];
  onRetry(deliveryId: string): void;
  onDiscard(deliveryId: string): void;
}

const STATUS_TEXT = { pending: '待发送', sending: '发送中…', failed: '发送失败' } as const;

/** Bot 聊天的离线待发队列：连上后按原 deliveryId 自动重发，失败的需手动重试 */
export function OutboxBar({ items, onRetry, onDiscard }: Props) {
  if (items.length === 0) return null;
  return (
    <div className="mb-1 space-y-1">
      {items.map((item) => (
        <div
          key={item.deliveryId}
          className={cn(
            'flex items-center gap-2 rounded-xl border px-2.5 py-1.5 text-xs',
            item.status === 'failed' ? 'border-destructive/40 bg-destructive/5' : 'bg-muted/40'
          )}
        >
          <span className="min-w-0 flex-1 truncate">
            {item.text || (item.images?.length ? `[${item.images.length} 张图片]` : '')}
          </span>
          <span
            className={cn(
              'shrink-0',
              item.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {STATUS_TEXT[item.status]}
            {item.status === 'failed' && item.error ? `：${item.error}` : ''}
          </span>
          {item.status === 'failed' && (
            <button
              type="button"
              aria-label="重试"
              onClick={() => onRetry(item.deliveryId)}
              className="shrink-0 rounded p-0.5 text-foreground hover:bg-accent"
            >
              <RotateCw className="h-3.5 w-3.5" />
            </button>
          )}
          {item.status !== 'sending' && (
            <button
              type="button"
              aria-label="删除"
              onClick={() => onDiscard(item.deliveryId)}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
