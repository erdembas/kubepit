import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface CheckMenuItem {
  id: string;
  label: ReactNode;
  checked: boolean;
  /** Leading swatch / icon. */
  leading?: ReactNode;
  /** Right-aligned hint (counts). */
  hint?: string;
  /** Element language when the label is an identifier shown uppercase. */
  lang?: string;
  onToggle: (event: React.MouseEvent) => void;
}

export interface CheckMenuAction {
  id: string;
  label: string;
  onClick: () => void;
}

/**
 * A popover of toggles that stays open while items are toggled (level and
 * column pickers), plus optional actions below a separator. Esc or a click
 * outside closes it. Rendered in a portal, flipped to stay on screen.
 */
export function CheckMenu({
  x,
  y,
  title,
  items,
  actions = [],
  empty,
  onClose,
}: {
  x: number;
  y: number;
  title?: string;
  items: CheckMenuItem[];
  actions?: CheckMenuAction[];
  empty?: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 6;
    setPos({
      left: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
    });
  }, [x, y, items.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      className="border-border bg-surface-overlay fixed z-10001 flex max-h-[min(420px,70vh)] min-w-[200px] flex-col rounded-md border py-1 shadow-[0_12px_40px_rgba(0,0,0,0.45)]"
      onContextMenu={(e) => e.preventDefault()}
    >
      {title && (
        <div className="text-fg-dim px-2.5 pt-1 pb-1.5 text-[10.5px] font-semibold tracking-[0.08em] uppercase">
          {title}
        </div>
      )}
      <div className="min-h-0 overflow-y-auto">
        {items.length === 0 && empty && (
          <div className="text-fg-dim px-2.5 py-1.5 text-[11.5px]">{empty}</div>
        )}
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitemcheckbox"
            aria-checked={item.checked}
            onClick={item.onToggle}
            className="hover:bg-fg/5 flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12px]"
          >
            <span
              className={cn(
                'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border',
                item.checked ? 'border-accent bg-accent text-accent-fg' : 'border-border-strong',
              )}
            >
              {item.checked && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
            </span>
            {item.leading}
            <span lang={item.lang} className="text-fg min-w-0 flex-1 truncate">
              {item.label}
            </span>
            {item.hint && (
              <span className="text-fg-dim shrink-0 pl-3 text-[10.5px] tabular-nums">
                {item.hint}
              </span>
            )}
          </button>
        ))}
      </div>
      {actions.length > 0 && (
        <>
          <div className="bg-border/70 my-1 h-px" />
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              role="menuitem"
              onClick={() => {
                a.onClick();
                onClose();
              }}
              className="text-fg-muted hover:text-fg hover:bg-fg/5 w-full px-2.5 py-1 text-left text-[12px]"
            >
              {a.label}
            </button>
          ))}
        </>
      )}
    </div>,
    document.body,
  );
}
