import { useEffect, useState } from 'react';
import { useOverlayGuard } from '@/hooks/useOverlayGuard';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';

interface ZoomableImageProps {
  src: string;
  className?: string;
  /** 点击区域；需要把图片限制在父级宽度内时传 `block w-full` */
  frameClassName?: string;
  onError?: () => void;
}

/** 消息里的图片：点击全屏预览，点遮罩或 Esc 关闭 */
export function ZoomableImage({ src, className, frameClassName, onError }: ZoomableImageProps) {
  const [open, setOpen] = useState(false);
  useOverlayGuard(open);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn('cursor-zoom-in', frameClassName)}
      >
        <img src={src} alt="" className={className} onError={onError} />
      </button>
      {open && (
        <button
          type="button"
          onClick={() => setOpen(false)}
          className={cn(
            'fixed inset-0 flex cursor-zoom-out items-center justify-center bg-black/75'
          )}
          style={{ zIndex: Z_INDEX.NESTED_MODAL_BACKDROP }}
          data-enso-float=""
        >
          <img src={src} alt="" className="max-h-[92vh] max-w-[92vw] rounded-lg object-contain" />
        </button>
      )}
    </>
  );
}
