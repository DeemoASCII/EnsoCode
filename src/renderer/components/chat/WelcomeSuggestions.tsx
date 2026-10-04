import { Bug, Compass, FlaskConical, History, type LucideIcon } from 'lucide-react';
import { useI18n } from '@/i18n';

const SUGGESTIONS: { icon: LucideIcon; title: string; hint: string; prompt: string }[] = [
  {
    icon: Compass,
    title: 'Map the project',
    hint: 'Entry points, modules and key dependencies',
    prompt:
      "Walk me through this project's structure: entry points, module layout and key dependencies.",
  },
  {
    icon: Bug,
    title: 'Find potential issues',
    hint: 'Suspicious logic and unhandled edge cases',
    prompt:
      'Review this project for potential bugs, suspicious logic and unhandled edge cases, and list them by severity.',
  },
  {
    icon: FlaskConical,
    title: 'Add unit tests',
    hint: 'Cover the core modules with tests',
    prompt: 'Find the core modules that lack tests and add unit tests for them.',
  },
  {
    icon: History,
    title: 'Summarize recent changes',
    hint: 'A digest based on git log',
    prompt: 'Summarize the recent changes in this repository based on git log.',
  },
];

/** 空会话的建议卡片：点击把对应提示词填进输入框，由用户确认后发送 */
export function WelcomeSuggestions({ onPick }: { onPick: (prompt: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="mx-auto grid w-full max-w-[560px] grid-cols-1 gap-2.5 text-left @min-[36rem]:grid-cols-2">
      {SUGGESTIONS.map(({ icon: Icon, title, hint, prompt }) => (
        <button
          key={title}
          type="button"
          onClick={() => onPick(t(prompt))}
          data-slot="welcome-suggestion"
          className="group flex items-start gap-3 rounded-xl border bg-card px-3.5 py-3 text-left shadow-xs transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:border-brand/25 hover:shadow-float"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand/8 text-brand dark:bg-brand/14">
            <Icon className="size-3.5" />
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] font-medium">{t(title)}</span>
            <span className="block text-xs text-muted-foreground">{t(hint)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
