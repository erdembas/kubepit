import { useCallback, useRef, useState, type PointerEvent } from 'react';
import { DEFAULT_W, MAX_W, MIN_W } from './dnd';

const WIDTH_KEY = 'kubepit.sidebar.width';

function initialWidth() {
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= MIN_W && saved <= MAX_W) return saved;
  } catch {
    /* Storage can be blocked. */
  }
  return DEFAULT_W;
}

export function useSidebarRailResize() {
  const [width, setWidth] = useState(initialWidth);
  const resizing = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);
  const latest = useRef(width);

  const onResizeStart = useCallback(
    (e: PointerEvent) => {
      e.preventDefault();
      resizing.current = true;
      startX.current = e.clientX;
      startW.current = width;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [width],
  );

  const onResizeMove = useCallback((e: PointerEvent) => {
    if (!resizing.current) return;
    const delta = e.clientX - startX.current;
    latest.current = Math.max(MIN_W, Math.min(MAX_W, startW.current + delta));
    setWidth(latest.current);
  }, []);

  const onResizeEnd = useCallback(() => {
    if (!resizing.current) return;
    resizing.current = false;
    try {
      localStorage.setItem(WIDTH_KEY, String(latest.current));
    } catch {
      /* ignore */
    }
  }, []);

  return { width, onResizeStart, onResizeMove, onResizeEnd };
}
