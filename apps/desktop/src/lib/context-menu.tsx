import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface MenuItem {
  label: string;
  action?: () => void;
  separator?: boolean;
  shortcut?: string;
}

export function useContextMenu(getItems: (x: number, y: number) => MenuItem[]) {
  const [state, setState] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      const items = getItems(e.clientX, e.clientY);
      if (items.length === 0) return;
      setState({ x: e.clientX, y: e.clientY, items });
    };
    const onClick = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as HTMLElement)) return;
      setState(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setState(null);
    };
    window.addEventListener('contextmenu', onContext);
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('contextmenu', onContext);
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [getItems]);

  const menu = state
    ? createPortal(
        <div
          ref={menuRef}
          className="border-border bg-surface-overlay fixed z-[200] min-w-[180px] rounded-lg border py-1 shadow-[0_12px_40px_rgba(0,0,0,0.35)]"
          style={{ left: state.x, top: state.y }}
          onClick={() => setState(null)}
        >
          {state.items.map((item, i) =>
            item.separator ? (
              <div key={i} className="border-border my-1 border-t" />
            ) : (
              <button
                key={i}
                type="button"
                className="text-fg hover:bg-accent/10 disabled:text-fg-dim flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition disabled:hover:bg-transparent"
                disabled={!item.action}
                onClick={() => item.action?.()}
              >
                <span className="flex-1">{item.label}</span>
                {item.shortcut && <span className="text-fg-dim text-[10px]">{item.shortcut}</span>}
              </button>
            ),
          )}
        </div>,
        document.body,
      )
    : null;

  return { menu };
}
