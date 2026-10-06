import { useSyncExternalStore } from 'react';

const matches = (query: string) =>
  typeof window.matchMedia === 'function' && window.matchMedia(query).matches;

/** matchMedia 订阅式读取；大屏横屏判定等响应式条件共用 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window.matchMedia !== 'function') return () => {};
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    () => matches(query),
    () => matches(query)
  );
}

/** iPad 横屏 / 宽窗口：会话列表停靠在左侧常驻，不再盖浮层抽屉 */
export const WIDE_LAYOUT_QUERY = '(min-width: 900px) and (orientation: landscape)';
