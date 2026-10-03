import { mentionCandidates } from '@shared/bots/mentions';
import type { AttachedImage } from '@shared/types/agent';
import { BOT_MENTION_ALL, type BotProfile } from '@shared/types/bot';
import { ArrowUp, ImagePlus, Square, X } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { BotAvatar } from './BotAvatar';

/** 草稿按聊天缓存（键带 bot: 前缀，与 Code 侧 focusKey 不冲突） */
const drafts = new Map<string, string>();

type Candidate = { kind: 'bot'; bot: BotProfile } | { kind: 'all' };

interface BotComposerProps {
  draftKey: string;
  placeholder: string;
  /** 群聊成员：有值时启用 @ 补全 */
  members?: BotProfile[];
  running: boolean;
  disabled?: boolean;
  toolbar?: ReactNode;
  hint?: ReactNode;
  /** 返回 false = 发送失败，输入回滚 */
  onSend: (text: string, images: AttachedImage[]) => Promise<boolean>;
  onStop?: () => void;
}

export function BotComposer({
  draftKey,
  placeholder,
  members,
  running,
  disabled = false,
  toolbar,
  hint,
  onSend,
  onStop,
}: BotComposerProps) {
  const { t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const [text, setText] = useState(() => drafts.get(draftKey) ?? '');
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setText(drafts.get(draftKey) ?? '');
    setImages([]);
    setMention(null);
    textareaRef.current?.focus();
  }, [draftKey]);

  useEffect(() => {
    if (text) drafts.set(draftKey, text);
    else drafts.delete(draftKey);
  }, [draftKey, text]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: text 变化触发重新测高
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const candidates: Candidate[] = (() => {
    if (!mention || !members) return [];
    const list: Candidate[] = mentionCandidates(mention.query, members).map((bot) => ({
      kind: 'bot',
      bot,
    }));
    const query = mention.query.toLowerCase();
    if (BOT_MENTION_ALL.some((word) => word.startsWith(query))) list.push({ kind: 'all' });
    return list;
  })();

  const detectMention = (value: string, caret: number) => {
    if (!members?.length) return setMention(null);
    const match = /(^|[^A-Za-z0-9._%+-])@([^\s@]*)$/u.exec(value.slice(0, caret));
    if (!match) return setMention(null);
    setMention({ start: caret - match[2].length - 1, query: match[2] });
    setActiveIndex(0);
  };

  const insertMention = (candidate: Candidate) => {
    if (!mention) return;
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? text.length;
    const name = candidate.kind === 'all' ? t('everyone') : candidate.bot.name;
    const next = `${text.slice(0, mention.start)}@${name} ${text.slice(caret)}`;
    const position = mention.start + name.length + 2;
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(position, position);
    });
  };

  const ingest = (files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const url = reader.result as string;
        setImages((list) => [
          ...list,
          { data: url.slice(url.indexOf(',') + 1), mimeType: file.type },
        ]);
      };
      reader.readAsDataURL(file);
    }
  };

  const canSend = !disabled && !sending && (text.trim().length > 0 || images.length > 0);

  const submit = async () => {
    if (!canSend) return;
    const sentText = text.trim();
    const sentImages = images;
    setText('');
    setImages([]);
    setMention(null);
    setSending(true);
    try {
      const ok = await onSend(sentText, sentImages);
      if (!ok) {
        setText((current) => (current ? current : sentText));
        setImages((current) => (current.length ? current : sentImages));
      }
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = event.nativeEvent.isComposing || composingRef.current;
    if (mention && candidates.length > 0 && !composing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((index) => (index + delta + candidates.length) % candidates.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        insertMention(candidates[Math.min(activeIndex, candidates.length - 1)]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !composing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div
      data-slot="composer"
      className="relative rounded-2xl border bg-background shadow-float"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        ingest([...event.dataTransfer.files]);
      }}
    >
      {mention && candidates.length > 0 && (
        <div className="absolute bottom-full left-3 z-10 mb-1.5 w-72 rounded-xl border bg-popover p-1 shadow-lg">
          <div className="px-2 py-1 text-[11px] text-muted-foreground">{t('Mention a member')}</div>
          {candidates.map((candidate, index) => (
            <button
              key={candidate.kind === 'all' ? '@all' : candidate.bot.id}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                insertMention(candidate);
              }}
              onMouseEnter={() => setActiveIndex(index)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                index === activeIndex && 'bg-muted'
              )}
            >
              {candidate.kind === 'all' ? (
                <>
                  <span className="grid h-6 w-6 place-items-center rounded-full bg-muted text-[11px]">
                    @
                  </span>
                  <span>{t('everyone')}</span>
                </>
              ) : (
                <>
                  <BotAvatar bot={candidate.bot} size="sm" />
                  <span className="min-w-0 truncate">{candidate.bot.name}</span>
                  <span className="min-w-0 truncate text-muted-foreground text-xs">
                    {candidate.bot.title}
                  </span>
                </>
              )}
            </button>
          ))}
        </div>
      )}

      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {images.map((image, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: 附件无稳定 id
              key={index}
              className="group relative h-14 w-14 overflow-hidden rounded-lg border"
            >
              <img
                src={`data:${image.mimeType};base64,${image.data}`}
                alt=""
                className="h-full w-full object-cover"
              />
              <button
                type="button"
                aria-label={t('Remove')}
                onClick={() => setImages((list) => list.filter((_, i) => i !== index))}
                className="absolute top-0.5 right-0.5 hidden rounded-full bg-background/90 p-0.5 group-hover:block"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={text}
        rows={1}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => {
          setText(event.target.value);
          detectMention(event.target.value, event.target.selectionStart);
        }}
        onSelect={(event) =>
          detectMention(event.currentTarget.value, event.currentTarget.selectionStart)
        }
        onBlur={() => setMention(null)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        onPaste={(event) => {
          const files = [...event.clipboardData.files].filter((file) =>
            file.type.startsWith('image/')
          );
          if (files.length === 0) return;
          event.preventDefault();
          ingest(files);
        }}
        className="block max-h-56 min-h-12 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
      />

      <div className="flex items-center gap-1.5 px-2.5 pb-2">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          title={t('Attach image')}
          aria-label={t('Attach image')}
        >
          <ImagePlus className="h-4 w-4" />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            ingest([...(event.target.files ?? [])]);
            event.target.value = '';
          }}
        />
        {toolbar}
        <div className="min-w-0 flex-1 truncate text-muted-foreground text-xs">{hint}</div>
        {running && onStop && !canSend ? (
          <button
            type="button"
            onClick={onStop}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"
            title={t('Stop')}
            aria-label={t('Stop')}
          >
            <Square className="h-3 w-3 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            disabled={!canSend}
            onClick={() => void submit()}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-40"
            title={t('Send')}
            aria-label={t('Send')}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
