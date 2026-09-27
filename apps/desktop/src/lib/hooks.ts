import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const POPOVER_W = 260;
const GAP = 6;

export function usePopoverPosition(open: boolean, triggerRef: React.RefObject<HTMLElement | null>) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const compute = () => {
      const btn = triggerRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const left = Math.min(Math.max(8, rect.right - POPOVER_W), viewportW - POPOVER_W - 8);
      let top = rect.bottom + GAP;
      const popH = popoverRef.current?.offsetHeight ?? 280;
      if (top + popH > viewportH - 8) {
        top = Math.max(8, rect.top - GAP - popH);
      }
      setPos({ top, left });
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open, triggerRef]);
  return { popoverRef, pos };
}

export function useClickOutsideClose(
  open: boolean,
  refs: Array<React.RefObject<HTMLElement | null>>,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      for (const r of refs) {
        if (r.current?.contains(target)) return;
      }
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- click-outside; `refs` and `onClose` are stable refs
  }, [open]);
}
