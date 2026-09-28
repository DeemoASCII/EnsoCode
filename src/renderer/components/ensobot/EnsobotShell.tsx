import { MessageSquare, MessagesSquare, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BackgroundLayer } from '@/components/app/BackgroundLayer';
import { TitleBar } from '@/components/app/TitleBar';
import { EnsobotFace } from '@/components/ensobot/EnsobotPanels';
import { OauthCredentialBootstrap } from '@/components/oauth/OauthCredentialBootstrap';
import { useBackgroundImage } from '@/hooks/useBackgroundImage';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useRemoteNodesStore } from '@/stores/remoteNodes';

type FaceId = 'chat' | 'board' | 'workspace';

const FACES: readonly { id: FaceId; icon: typeof MessageSquare }[] = [
  { id: 'chat', icon: MessageSquare },
  { id: 'board', icon: MessagesSquare },
  { id: 'workspace', icon: Users },
];

/**
 * EnsoBot 窗口壳：背景和设置沿用主界面那套，三个面这一版只把空状态说清楚。
 * 不挂主窗口钉住的工作台，也不在这里做设置页。
 */
export function EnsobotShell() {
  const { t } = useI18n();
  const [face, setFace] = useState<FaceId>('chat');
  useBackgroundImage();

  useEffect(() => useRemoteNodesStore.getState().bind(), []);

  return (
    <div className="relative isolate flex h-screen flex-col overflow-hidden">
      <BackgroundLayer />
      <OauthCredentialBootstrap />
      <TitleBar title={t('EnsoBot')} />
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={t('EnsoBot')}
          className="flex w-48 shrink-0 flex-col gap-1 border-r bg-background/80 p-2"
        >
          {FACES.map((item) => {
            const Icon = item.icon;
            const selected = face === item.id;
            return (
              <button
                key={item.id}
                type="button"
                data-slot="ensobot-face"
                data-face={item.id}
                aria-pressed={selected}
                onClick={() => setFace(item.id)}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                  selected
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{t(faceLabelKey(item.id))}</span>
              </button>
            );
          })}
        </nav>
        <main className="min-h-0 flex-1 overflow-auto bg-background/60 p-8">
          <EnsobotFace face={face} />
        </main>
      </div>
    </div>
  );
}

function faceLabelKey(face: FaceId): string {
  if (face === 'chat') return 'Private chat';
  if (face === 'board') return 'Message board';
  return 'Shared workspace';
}
