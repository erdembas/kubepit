import * as i18n from '@/i18n';
import { useRef, useState } from 'react';
import { cn } from '@/lib/cn';

interface Props {
  height: number;
  clamp: (height: number) => number;
  /** Live height while dragging (null when the drag ends). */
  onDrag: (height: number | null) => void;
  onCommit: (height: number) => void;
  onReset: () => void;
}

/**
 * Horizontal splitter on the dock's top edge — RunHQ `ResizeHandle` turned
 * sideways: invisible 6px hit area, 1px accent line on hover / drag,
 * double-click resets, arrow keys nudge.
 */
export function DockResizeHandle({ height, clamp, onDrag, onCommit, onReset }: Props) {
  i18n.useLocale();
  const drag = useRef<{ startY: number; startHeight: number; last: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-valuenow={Math.round(height)}
      tabIndex={0}
      title={i18n.t('Drag to resize · double-click to reset')}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { startY: e.clientY, startHeight: height, last: height };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.last = clamp(d.startHeight + (d.startY - e.clientY));
        onDrag(d.last);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (!d) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        drag.current = null;
        setDragging(false);
        onDrag(null);
        onCommit(d.last);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
        onDrag(null);
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          onCommit(clamp(height + (e.key === 'ArrowUp' ? 24 : -24)));
        }
      }}
      className="group absolute inset-x-0 -top-[3px] z-20 h-1.5 cursor-row-resize select-none focus:outline-none"
    >
      <span
        className={cn(
          'pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 transition-colors',
          dragging
            ? 'bg-accent'
            : 'group-hover:bg-accent/60 group-focus-visible:bg-accent/60 bg-transparent',
        )}
      />
    </div>
  );
}
