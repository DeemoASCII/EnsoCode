import type { EnsobotActivity, EnsobotWorkStep } from '@shared/ensobot/activity';
import type { EnsobotCardFace } from '@shared/ensobot/snapshot';
import {
  Check,
  ChevronRight,
  LoaderCircle,
  MessageCircleQuestion,
  ShieldAlert,
  X,
} from 'lucide-react';
import type { Root, RootContent, Text } from 'mdast';
import { Fragment, type ReactNode, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { visit } from 'unist-util-visit';
import {
  markdownComponents,
  markdownUrlTransform,
  REMARK_PLUGINS,
} from '@/components/chat/Markdown';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useRemoteNodesStore } from '@/stores/remoteNodes';
import { CirclePhoto } from './EnsobotPrimitives';
import { type MemberStatus, type MemberStatusKind, mentionSegments } from './ensobotView';
import { loadWorkField, readWorkChunk } from './ensobotWorkEvidence';

const WORKING = new Set<MemberStatusKind>(['tool', 'typing', 'thinking', 'retrying', 'task']);
const WAITING_HUMAN = new Set<MemberStatusKind>(['approval', 'ask']);

export function StatusDot({ kind, className }: { kind: MemberStatusKind; className?: string }) {
  if (kind === 'idle') return null;
  return (
    <span
      data-slot="ensobot-status-dot"
      data-status={kind}
      className={cn(
        'block size-2.5 rounded-full border-2 border-background',
        WAITING_HUMAN.has(kind)
          ? 'bg-warning'
          : WORKING.has(kind)
            ? 'animate-pulse bg-brand'
            : 'bg-muted-foreground/60',
        className
      )}
    />
  );
}

export function useStatusLabel(): (status: MemberStatus) => string {
  const { t } = useI18n();
  return (status) => {
    switch (status.kind) {
      case 'approval':
        return t('Waiting for your approval');
      case 'ask':
        return t('Waiting for your answer');
      case 'retrying':
        return t('Retrying…');
      case 'tool':
        return status.tool ? t('Running {{tool}}', { tool: status.tool }) : t('Running a tool');
      case 'typing':
        return t('Typing…');
      case 'thinking':
        return t('Thinking…');
      case 'queued':
        return t('Queued ({{count}})', { count: status.queued });
      case 'task':
        return t('Running a background task');
      default:
        return t('Idle');
    }
  };
}

function StepIcon({ status }: { status: EnsobotWorkStep['status'] }) {
  if (status === 'running')
    return <LoaderCircle className="size-3 shrink-0 animate-spin text-brand" aria-hidden />;
  if (status === 'denied')
    return <ShieldAlert className="size-3 shrink-0 text-warning" aria-hidden />;
  if (status === 'error') return <X className="size-3 shrink-0 text-destructive" aria-hidden />;
  return <Check className="size-3 shrink-0 text-muted-foreground" aria-hidden />;
}

function StepList({ steps }: { steps: readonly EnsobotWorkStep[] }) {
  return (
    <ol data-slot="ensobot-work-steps" className="space-y-1">
      {steps.map((step) => (
        <StepRow key={step.evidenceId ?? step.id} step={step} />
      ))}
    </ol>
  );
}

function StepRow({ step }: { step: EnsobotWorkStep }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <li data-status={step.status} className="min-w-0 text-[11px] leading-5">
      <details
        data-slot="ensobot-work-detail"
        className="group/work"
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded px-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
          <ChevronRight className="size-3 shrink-0 group-open/work:rotate-90" aria-hidden />
          <StepIcon status={step.status} />
          <span className="shrink-0 font-mono text-foreground/80">{step.name}</span>
          {step.summary ? (
            <span className="min-w-0 truncate text-muted-foreground" title={step.summary}>
              {step.summary}
            </span>
          ) : null}
          {step.status === 'error' ? (
            <span className="shrink-0 text-destructive">{t('Failed')}</span>
          ) : null}
          {step.status === 'denied' ? (
            <span className="shrink-0 text-warning">{t('Denied by user')}</span>
          ) : null}
          {step.durationMs !== undefined ? (
            <span className="ml-auto shrink-0 text-muted-foreground">
              {(step.durationMs / 1000).toFixed(1)}s
            </span>
          ) : null}
        </summary>
        {open ? <WorkEvidence step={step} /> : null}
      </details>
    </li>
  );
}

function WorkEvidence({ step }: { step: EnsobotWorkStep }) {
  const { t } = useI18n();
  const nodeId = useRemoteNodesStore((state) => state.activeNodeId);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    loading: boolean;
    parameters?: string;
    output?: string;
    error?: string;
  }>({ loading: true });
  const { evidenceId, hasParameters, hasOutput } = step;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 轮次终态和手动刷新必须重新读取，不能只按是否有输出缓存。
  useEffect(() => {
    let disposed = false;
    setState({ loading: !!evidenceId });
    if (!evidenceId) return;
    const read = (request: Parameters<typeof readWorkChunk>[1]) => {
      if (disposed) return Promise.reject(new Error('cancelled'));
      return readWorkChunk(nodeId, request);
    };
    void Promise.all([
      hasParameters ? loadWorkField(read, evidenceId, 'parameters') : undefined,
      hasOutput ? loadWorkField(read, evidenceId, 'output') : undefined,
    ])
      .then(([parameters, output]) => {
        if (!disposed) setState({ loading: false, parameters, output });
      })
      .catch((error) => {
        if (!disposed) setState({ loading: false, error: String(error) });
      });
    return () => {
      disposed = true;
    };
  }, [nodeId, evidenceId, hasParameters, hasOutput, step.status, attempt]);
  return (
    <div className="ml-4 mt-1 space-y-2 border-l pl-3" aria-busy={state.loading}>
      {state.loading ? <p role="status">{t('Loading…')}</p> : null}
      {state.error ? (
        <p role="alert" className="text-destructive">
          {t('Failed to read work evidence')}: {state.error}
        </p>
      ) : null}
      <div>
        <p className="text-muted-foreground">{t('Arguments')}</p>
        <pre
          data-slot="ensobot-work-parameters"
          className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono"
        >
          {state.parameters ?? (state.loading ? '' : t('Details unavailable for older records'))}
        </pre>
      </div>
      <div>
        <p className="text-muted-foreground">{t('Result')}</p>
        <pre
          data-slot="ensobot-work-output"
          className="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono"
        >
          {state.output === undefined
            ? state.loading
              ? ''
              : t(
                  step.status === 'running'
                    ? '(no output yet)'
                    : 'Details unavailable for older records'
                )
            : state.output || t('(empty output)')}
        </pre>
      </div>
      {step.evidenceId ? (
        <button
          type="button"
          disabled={state.loading}
          onClick={() => setAttempt((value) => value + 1)}
          className="text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {t('Refresh')}
        </button>
      ) : null}
    </div>
  );
}

/** 回复下面的工作记录：默认收起，展开能看到这一轮调用了哪些工具、成败如何。 */
export function WorkLog({ steps }: { steps: readonly EnsobotWorkStep[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;
  const failed = steps.some((step) => step.status === 'error');
  return (
    <div data-slot="ensobot-work-log" className="mt-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 rounded-md px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        {t('Work log · {{count}} steps', { count: steps.length })}
        {failed ? <X className="size-3 text-destructive" aria-label={t('Failed')} /> : null}
      </button>
      {open ? (
        <div className="mt-1 rounded-lg border bg-muted/20 px-2.5 py-2">
          <StepList steps={steps} />
        </div>
      ) : null}
    </div>
  );
}

/** 正在当前聊天面干活的成员：头像、状态、最近几步，以及要人拍板的审批/提问。 */
export function LiveRow({
  card,
  activity,
  status,
  children,
}: {
  card: EnsobotCardFace | undefined;
  activity: EnsobotActivity;
  status: MemberStatus;
  children?: ReactNode;
}) {
  const label = useStatusLabel();
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  const steps = all ? activity.steps : activity.steps.slice(-3);
  const name = card?.name ?? activity.cardId.slice(0, 8);
  return (
    <li
      data-slot="ensobot-live-row"
      data-card={activity.cardId}
      data-status={status.kind}
      className="flex max-w-[88%] items-start gap-2.5 self-start"
    >
      <span className="relative shrink-0">
        {card ? (
          <CirclePhoto
            src={card.previewUrl}
            crop={card.crop}
            width={card.width}
            height={card.height}
            size={28}
            alt={name}
          />
        ) : (
          <span className="block size-7 rounded-full bg-muted" />
        )}
        <StatusDot kind={status.kind} className="absolute -right-0.5 -bottom-0.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="mb-1.5 text-[10px] text-muted-foreground">{name}</p>
        <div className="rounded-2xl rounded-tl-sm border border-dashed bg-muted/25 px-4 py-2.5">
          <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            {status.kind === 'approval' ? (
              <ShieldAlert className="size-3.5 text-warning" aria-hidden />
            ) : status.kind === 'ask' ? (
              <MessageCircleQuestion className="size-3.5 text-warning" aria-hidden />
            ) : WORKING.has(status.kind) ? (
              <LoaderCircle className="size-3.5 animate-spin text-brand" aria-hidden />
            ) : null}
            <span>{label(status)}</span>
            {status.kind === 'tool' && status.detail ? (
              <span className="min-w-0 truncate font-mono text-[11px]">{status.detail}</span>
            ) : null}
          </p>
          {activity.steps.length ? (
            <div className="mt-2 border-t border-dashed pt-2">
              <StepList steps={steps} />
              {activity.steps.length > 3 ? (
                <button
                  type="button"
                  className="mt-1 text-[10px] text-muted-foreground hover:text-foreground"
                  onClick={() => setAll((value) => !value)}
                >
                  {all
                    ? t('Show fewer steps')
                    : t('Show all {{count}} steps', { count: activity.steps.length })}
                </button>
              ) : null}
            </div>
          ) : null}
          {status.queued > 0 && status.kind !== 'queued' ? (
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              {t('Queued ({{count}})', { count: status.queued })}
            </p>
          ) : null}
        </div>
        {children}
      </div>
    </li>
  );
}

/** 正文里的 @名字 高亮出来，一眼看清谁被点了名。 */
export function MentionText({
  text,
  members,
}: {
  text: string;
  members: readonly { id: string; name: string }[];
}) {
  const segments = mentionSegments(text, members);
  if (!segments.some((segment) => segment.mention)) return <>{text}</>;
  // 片段首尾相接：用它在原文里的起点当 key，稳定且唯一。
  let offset = 0;
  const keyed = segments.map((segment) => {
    const start = offset;
    offset += segment.text.length;
    return { ...segment, start };
  });
  return (
    <>
      {keyed.map((segment) =>
        segment.mention ? (
          <span key={segment.start} data-slot="ensobot-mention" className="font-medium text-brand">
            {segment.text}
          </span>
        ) : (
          <Fragment key={segment.start}>{segment.text}</Fragment>
        )
      )}
    </>
  );
}

const MENTION_PROPERTIES = {
  dataSlot: 'ensobot-mention',
  className: ['font-medium', 'text-brand'],
};

/** Markdown 文本节点里的 @名字 包成高亮 span；代码、链接地址不动。 */
function remarkMentions(members: readonly { id: string; name: string }[]) {
  return () => (tree: Root) => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || index === undefined) return;
      const segments = mentionSegments(node.value, members);
      if (!segments.some((segment) => segment.mention)) return;
      const replaced: RootContent[] = segments.map((segment) =>
        segment.mention
          ? ({
              type: 'text',
              value: segment.text,
              data: { hName: 'span', hProperties: MENTION_PROPERTIES },
            } as Text)
          : ({ type: 'text', value: segment.text } as Text)
      );
      parent.children.splice(index, 1, ...(replaced as typeof parent.children));
      return index + replaced.length;
    });
  };
}

/** bot 的回复按 Markdown 渲染（与工作台同一套组件），同时保留 @ 点名高亮。 */
export function EnsobotMarkdown({
  text,
  members,
}: {
  text: string;
  members: readonly { id: string; name: string }[];
}) {
  const membersKey = members.map((member) => `${member.id}:${member.name}`).join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: 成员按 id+名字比较，数组引用每次快照都会换
  const plugins = useMemo(() => [...REMARK_PLUGINS, remarkMentions(members)], [membersKey]);
  const urlTransform = useMemo(
    () => (value: string, key: string) => markdownUrlTransform(value, key, false),
    []
  );
  return (
    <div data-slot="ensobot-markdown" className="min-w-0 break-words">
      <ReactMarkdown
        remarkPlugins={plugins}
        components={markdownComponents}
        urlTransform={urlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
