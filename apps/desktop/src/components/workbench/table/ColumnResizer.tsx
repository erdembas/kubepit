import * as i18n from '@/i18n';
import { useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { clampWidth } from './tableModel';

const NUDGE = 8;

/**
 * Grip on a header cell's right edge. Dragging reports live widths
 * (`done = false`) and the final one (`done = true`); double-click resets
 * the column to its default track; ←/→ nudge it from the keyboard.
 */
export function ColumnResizer({
  label,
  onResize,
  onReset,
}: {
  label: string;
  onResize: (width: number, done: boolean) => void;
  onReset: () => void;
}) {
  i18n.useLocale();
  const drag = useRef<{ startX: number; startWidth: number; last: number; moved: boolean } | null>(
    null,
  );
  const [dragging, setDragging] = useState(false);
  const cellWidth = (el: HTMLElement) => el.parentElement?.getBoundingClientRect().width ?? 120;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={i18n.t('Resize column {column}', { column: label })}
      tabIndex={0}
      title={i18n.t('Drag to resize · double-click to reset · ←/→ to nudge')}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const startWidth = cellWidth(e.currentTarget);
        drag.current = { startX: e.clientX, startWidth, last: startWidth, moved: false };
        setDragging(true);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.last = clampWidth(d.startWidth + e.clientX - d.startX);
        d.moved = true;
        onResize(d.last, false);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (!d) return;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
        drag.current = null;
        setDragging(false);
        if (d.moved) onResize(d.last, true);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onReset();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        e.stopPropagation();
        const width = cellWidth(e.currentTarget);
        onResize(clampWidth(width + (e.key === 'ArrowRight' ? NUDGE : -NUDGE)), true);
      }}
      className="group absolute inset-y-1 -right-[7px] z-10 w-[9px] cursor-col-resize touch-none select-none focus-visible:outline-none"
    >
      <span
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors',
          dragging
            ? 'bg-accent'
            : 'group-hover:bg-accent/60 group-focus-visible:bg-accent/60 bg-transparent',
        )}
      />
    </div>
  );
}
