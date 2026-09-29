import type { CircleCrop } from '@shared/characterCard';
import type { EnsobotTaskStatus } from '@shared/ensobot/queue';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';

export function CirclePhoto({
  src,
  crop,
  width,
  height,
  size,
  alt,
}: {
  src: string;
  crop: CircleCrop | null;
  width: number;
  height: number;
  size: number;
  alt: string;
}) {
  const fitted =
    crop && crop.r > 0 && width > 0 && height > 0
      ? {
          width: (width * size) / (crop.r * 2),
          height: (height * size) / (crop.r * 2),
          marginLeft: -((crop.cx - crop.r) * size) / (crop.r * 2),
          marginTop: -((crop.cy - crop.r) * size) / (crop.r * 2),
          maxWidth: 'none' as const,
        }
      : undefined;
  return (
    <span
      data-slot="ensobot-avatar"
      className="inline-block shrink-0 overflow-hidden rounded-full bg-muted ring-1 ring-border/60"
      style={{ width: size, height: size }}
    >
      {src ? (
        <img
          alt={alt}
          src={src}
          className={fitted ? 'block' : 'h-full w-full object-cover'}
          style={fitted}
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center font-medium text-muted-foreground">
          {alt.slice(0, 1)}
        </span>
      )}
    </span>
  );
}

export function BotSelect({
  label,
  value,
  items,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  items: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Select
        value={value}
        items={items}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
        disabled={disabled}
      >
        <SelectTrigger aria-label={label} className="min-w-0">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col items-center rounded-2xl border border-dashed p-8 text-center">
      <span className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <Icon className="size-6" strokeWidth={1.5} />
      </span>
      <h3 className="text-base font-medium">{title}</h3>
      <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{description}</p>
      {children ? <div className="mt-5">{children}</div> : null}
    </div>
  );
}

export function SurfaceHeader({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b px-7 py-5">
      <div className="min-w-0">
        <p className="mb-1 text-[10px] font-medium tracking-[0.16em] text-muted-foreground">
          {eyebrow}
        </p>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      {children}
    </header>
  );
}

const STATUS: Record<EnsobotTaskStatus, string> = {
  queued: 'Queued',
  claimed: 'Claimed',
  doing: 'Working',
  'waiting-directory': 'Waiting for workspace',
  done: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function TaskStatus({ status }: { status: EnsobotTaskStatus }) {
  const { t } = useI18n();
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 text-[11px]',
        status === 'doing' || status === 'claimed'
          ? 'text-brand'
          : status === 'done'
            ? 'text-success'
            : status === 'failed'
              ? 'text-destructive'
              : 'text-muted-foreground'
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {t(STATUS[status])}
    </span>
  );
}
