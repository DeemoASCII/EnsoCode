import { create } from 'zustand';
import { useRemoteNodesStore } from '@/stores/remoteNodes';
import { useSettingsStore } from '@/stores/settings';

export type AppMode = 'code' | 'bot';

const MODE_KEY = 'enso-mode';

interface AppModeState {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
}

export const useAppModeStore = create<AppModeState>()((set) => ({
  mode: localStorage.getItem(MODE_KEY) === 'bot' ? 'bot' : 'code',
  setMode: (mode) => {
    localStorage.setItem(MODE_KEY, mode);
    set({ mode });
  },
}));

/** 实际处于 Bot 模式：开关打开、停在本机、且选了 Bot */
export function isBotModeActive(): boolean {
  return (
    useSettingsStore.getState().botModeEnabled &&
    useRemoteNodesStore.getState().activeNodeId === 'local' &&
    useAppModeStore.getState().mode === 'bot'
  );
}

export function useBotModeActive(): boolean {
  const enabled = useSettingsStore((s) => s.botModeEnabled);
  const local = useRemoteNodesStore((s) => s.activeNodeId === 'local');
  const mode = useAppModeStore((s) => s.mode);
  return enabled && local && mode === 'bot';
}
