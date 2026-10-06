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

// iPad 横屏 / 宽窗口：会话列表停靠在左侧常驻，不再盖浮层抽屉。
// 只用宽度阈值：orientation 在 iPad standalone PWA 启动时会先报 portrait 再纠正，
// 会造成常驻栏闪一下又消失；手机/平板竖屏宽都 <900px，不会误命中
export const WIDE_LAYOUT_QUERY = '(min-width: 900px)';
