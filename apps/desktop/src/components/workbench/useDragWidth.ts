import { useCallback, useRef, useState } from 'react';

/**
 * Pointer/keyboard resizing for a panel whose width lives in a store.
 * `edge = 'right'` grows when dragging right (left panels); `'left'` grows
 * when dragging left (right-side panels). Returns props compatible with
 * `components/ui/ResizeHandle`.
 */
export function useDragWidth({
  width,
  setWidth,
  min,
  max,
  defaultWidth,
  edge,
}: {
  width: number;
  setWidth: (w: number) => void;
  min: number;
  max: number;
  defaultWidth: number;
  edge: 'left' | 'right';
}) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [live, setLive] = useState<number | null>(null);
  const clamp = useCallback((n: number) => Math.max(min, Math.min(max, n)), [min, max]);
  const sign = edge === 'right' ? 1 : -1;

  const handleProps = {
    role: 'separator' as const,
    'aria-orientation': 'vertical' as const,
    'aria-valuemin': min,
    'aria-valuemax': max,
    'aria-valuenow': Math.round(live ?? width),
    tabIndex: 0,
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      e.preventDefault();
      drag.current = { startX: e.clientX, startWidth: width };
      setDragging(true);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d) return;
      setLive(clamp(d.startWidth + sign * (e.clientX - d.startX)));
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      if (!drag.current) return;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      drag.current = null;
      setDragging(false);
      setLive((value) => {
        if (value !== null) setWidth(value);
        return null;
      });
    },
    onDoubleClick: () => setWidth(defaultWidth),
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const step = (e.shiftKey ? 32 : 8) * (e.key === 'ArrowRight' ? 1 : -1) * sign;
      setWidth(clamp(width + step));
    },
  };
  return { width: Math.min(max, live ?? width), dragging, handleProps };
}
