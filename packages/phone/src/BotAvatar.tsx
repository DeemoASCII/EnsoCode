import type { PairBotMember } from '@enso/pair';
import { cn } from '@/lib/utils';

/** 头像：成员色 + 名字首字；运行中加脉冲环 */
export function BotAvatar({
  bot,
  size = 'md',
  busy,
}: {
  bot: Pick<PairBotMember, 'name' | 'avatarColor'> | undefined;
  size?: 'sm' | 'md';
  busy?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full font-medium text-white',
        size === 'sm' ? 'h-7 w-7 text-xs' : 'h-9 w-9 text-sm',
        busy && 'ring-2 ring-brand/60 ring-offset-1 ring-offset-background animate-pulse'
      )}
      style={{ backgroundColor: bot?.avatarColor ?? '#888' }}
    >
      {[...(bot?.name ?? '?')][0]}
    </span>
  );
}
