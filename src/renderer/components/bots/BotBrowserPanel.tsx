import { botBrowserKey } from '@shared/bots/browser';
import { useMemo } from 'react';
import { type BrowserSurface, BrowserView } from '@/components/sidepanel/BrowserView';
import { botBrowserTabId, useBotsStore } from '@/stores/bots';

/** 聊天共享浏览器：私聊成员、群里所有成员及其委派子会话看到的是同一个页面 */
export function BotBrowserPanel({ chatId, visible }: { chatId: string; visible: boolean }) {
  const tabId = useBotsStore((s) => botBrowserTabId(s.browserTabs, chatId));
  const surface = useMemo<BrowserSurface>(
    () => ({
      id: tabId,
      isActive: true,
      isVisible: true,
      setTitle: () => {},
      getParameters: () => undefined,
      updateParameters: () => {},
    }),
    [tabId]
  );
  return (
    <BrowserView
      key={tabId}
      conversationId={botBrowserKey(chatId)}
      panelApi={surface}
      active={visible}
    />
  );
}
