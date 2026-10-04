import type {
  BotArtifact,
  BotArtifactOpenAction,
  BotArtifactReadResult,
  BotArtifactTarget,
} from '@shared/types/botIpc';
import { ExternalLink, FolderOpen, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Markdown } from '@/components/chat/Markdown';
import { ReadFileView } from '@/components/chat/ReadFileView';
import { fileTypeIcon, fileTypeIconClass } from '@/components/sidepanel/fileIcons';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

/** 只缓存非空结果：轮次刚结束时文件可能还没落盘，空结果下次挂载再问 */
const cache = new Map<string, BotArtifact[]>();
const PREVIEWABLE = new Set<BotArtifact['kind']>(['image', 'markdown', 'html', 'text']);

const sizeText = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1024 / 1024).toFixed(1)} MB`;

function useArtifacts(target: BotArtifactTarget): BotArtifact[] {
  const key = JSON.stringify(target);
  const [artifacts, setArtifacts] = useState<BotArtifact[]>(() => cache.get(key) ?? []);
  useEffect(() => {
    if (cache.has(key)) return;
    let alive = true;
    void window.electronAPI.bots.artifacts
      .list(JSON.parse(key) as BotArtifactTarget)
      .then((result) => {
        if (!alive || !result.ok) return;
        if (result.artifacts.length > 0) cache.set(key, result.artifacts);
        setArtifacts(result.artifacts);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [key]);
  return artifacts;
}

function useOpenArtifact(target: BotArtifactTarget) {
  const { t } = useI18n();
  return (artifact: BotArtifact, action: BotArtifactOpenAction) =>
    void window.electronAPI.bots.artifacts
      .open({ ...target, rel: artifact.rel, action })
      .then((result) => {
        if (result.ok) return;
        addToast({
          type: 'error',
          title:
            result.error === 'not-openable'
              ? t('This file type is only shown in Finder')
              : t('Could not open the file'),
        });
      });
}

/** 该轮产生或提到、且位于聊天工作区内的文件；路径由 Main 推导，这里只传标识 */
export function ArtifactCards({ target }: { target: BotArtifactTarget }) {
  const { t } = useI18n();
  const artifacts = useArtifacts(target);
  const open = useOpenArtifact(target);
  const [preview, setPreview] = useState<BotArtifact | null>(null);
  if (artifacts.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5" data-bot-artifacts="">
      {artifacts.map((artifact) => {
        const Icon = fileTypeIcon(artifact.name, false);
        const canPreview = PREVIEWABLE.has(artifact.kind) || artifact.kind === 'pdf';
        return (
          <div
            key={artifact.rel}
            className="group/artifact flex max-w-64 items-center gap-1 rounded-lg border bg-card py-1 pr-1 pl-2 text-xs"
          >
            <button
              type="button"
              title={artifact.rel}
              disabled={!canPreview}
              onClick={() =>
                artifact.kind === 'pdf' ? open(artifact, 'preview') : setPreview(artifact)
              }
              className="flex min-w-0 items-center gap-1.5 text-left enabled:hover:underline disabled:cursor-default"
            >
              <Icon
                className={cn('h-3.5 w-3.5 shrink-0', fileTypeIconClass(artifact.name, false))}
              />
              <span className="truncate">{artifact.name}</span>
              <span className="shrink-0 text-muted-foreground">{sizeText(artifact.size)}</span>
            </button>
            <button
              type="button"
              title={t('Show in Finder')}
              onClick={() => open(artifact, 'reveal')}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title={t('Open with default app')}
              onClick={() => open(artifact, 'open')}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
      <ArtifactPreviewDialog
        target={target}
        artifact={preview}
        onOpen={open}
        onClose={() => setPreview(null)}
      />
    </div>
  );
}

function ArtifactPreviewDialog({
  target,
  artifact,
  onOpen,
  onClose,
}: {
  target: BotArtifactTarget;
  artifact: BotArtifact | null;
  onOpen: (artifact: BotArtifact, action: BotArtifactOpenAction) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [content, setContent] = useState<BotArtifactReadResult | null>(null);
  const rel = artifact?.rel;
  const key = JSON.stringify(target);
  useEffect(() => {
    setContent(null);
    if (!rel) return;
    let alive = true;
    void window.electronAPI.bots.artifacts
      .read({ ...(JSON.parse(key) as BotArtifactTarget), rel })
      .then((result) => alive && setContent(result))
      .catch(() => alive && setContent({ ok: false, error: 'unavailable' }));
    return () => {
      alive = false;
    };
  }, [key, rel]);

  return (
    <Dialog open={artifact !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex h-[80vh] max-w-4xl flex-col">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2 pr-8">
            <span className="truncate">{artifact?.name}</span>
            <span className="truncate font-normal text-muted-foreground text-xs">
              {artifact?.rel}
            </span>
            <span className="flex-1" />
            {artifact && (
              <>
                <button
                  type="button"
                  title={t('Show in Finder')}
                  onClick={() => onOpen(artifact, 'reveal')}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <FolderOpen className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  title={t('Open with default app')}
                  onClick={() => onOpen(artifact, 'open')}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <ExternalLink className="h-4 w-4" />
                </button>
              </>
            )}
          </DialogTitle>
        </DialogHeader>
        <PreviewBody name={artifact?.name ?? ''} content={content} />
      </DialogContent>
    </Dialog>
  );
}

/** 预览正文：整宽滚动区（图片 / Markdown / 沙箱 HTML / 纯文本） */
function PreviewBody({ name, content }: { name: string; content: BotArtifactReadResult | null }) {
  const { t } = useI18n();
  return (
    <div className="min-h-0 flex-1 overflow-auto border-t" data-bot-artifact-preview="">
      {!content && (
        <div className="flex justify-center p-6 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      )}
      {content && !content.ok && (
        <p className="p-6 text-muted-foreground text-sm">
          {content.error === 'too-large'
            ? t('The file is too large to preview')
            : t('Could not open the file')}
        </p>
      )}
      {content?.ok && content.kind === 'image' && (
        <img
          src={content.dataUrl}
          alt={name}
          className="mx-auto max-h-full max-w-full object-contain p-4"
        />
      )}
      {content?.ok && content.kind === 'markdown' && (
        <div className="px-6 py-4 text-sm">
          <Markdown text={content.text} />
        </div>
      )}
      {content?.ok && content.kind === 'html' && (
        // 不给 allow-scripts / allow-same-origin：脚本不执行，也拿不到宿主
        <iframe title={name} sandbox="" srcDoc={content.text} className="h-full w-full bg-white" />
      )}
      {content?.ok && content.kind === 'text' && (
        <div className="p-2 text-xs">
          <ReadFileView path={name} contents={content.text} />
        </div>
      )}
    </div>
  );
}
