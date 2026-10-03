import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { type AppMode, useAppModeStore } from '@/stores/bots/mode';
import { useRemoteNodesStore } from '@/stores/remoteNodes';
import { useSettingsStore } from '@/stores/settings';

/** 侧栏顶部 Code | Bot 分段控件；实验开关关闭或在远程节点时不渲染 */
export function ModeSwitch({ className }: { className?: string }) {
  const { t } = useI18n();
  const enabled = useSettingsStore((s) => s.botModeEnabled);
  const local = useRemoteNodesStore((s) => s.activeNodeId === 'local');
  const mode = useAppModeStore((s) => s.mode);
  const setMode = useAppModeStore((s) => s.setMode);
  if (!enabled || !local) return null;
  const options: { value: AppMode; label: string }[] = [
    { value: 'code', label: 'Code' },
    { value: 'bot', label: 'Bot' },
  ];
  return (
    <div
      role="radiogroup"
      aria-label={t('Switch mode')}
      className={cn('flex shrink-0 rounded-lg bg-muted p-0.5 text-xs', className)}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={mode === option.value}
          onClick={() => setMode(option.value)}
          className={cn(
            'rounded-md px-2 py-0.5 transition-colors',
            mode === option.value
              ? 'bg-background font-semibold text-foreground shadow-xs'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
