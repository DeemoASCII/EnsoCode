import { Settings } from 'lucide-react';
import { useEffect } from 'react';
import { BackgroundLayer } from '@/components/app/BackgroundLayer';
import { TitleBar } from '@/components/app/TitleBar';
import { EnsobotDesk } from '@/components/ensobot/EnsobotPanels';
import { OauthCredentialBootstrap } from '@/components/oauth/OauthCredentialBootstrap';
import { useBackgroundImage } from '@/hooks/useBackgroundImage';
import { useI18n } from '@/i18n';
import { useRemoteNodesStore } from '@/stores/remoteNodes';

/**
 * EnsoBot 窗口：和主窗口同级，以私聊/群聊为主，成员与公共协作独立呈现。
 * 设置、背景、节点投影沿用现有窗口，不在这里再做一页设置。
 */
export function EnsobotShell() {
  const { t } = useI18n();
  useBackgroundImage();

  useEffect(() => useRemoteNodesStore.getState().bind(), []);

  return (
    <div className="relative isolate flex h-screen flex-col overflow-hidden">
      <BackgroundLayer />
      <OauthCredentialBootstrap />
      <TitleBar
        title={t('EnsoBot')}
        actions={
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => window.electronAPI.window.openSettings()}
            aria-label={t('Settings')}
            title={t('Settings')}
          >
            <Settings className="h-3.5 w-3.5" />
            <span>{t('Settings')}</span>
          </button>
        }
      />
      <EnsobotDesk />
    </div>
  );
}
