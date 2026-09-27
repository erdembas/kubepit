import * as i18n from '@/i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Columns3 } from 'lucide-react';
import { Checkbox } from '@/components/ui/Choice';
import { IconButton } from '@/components/ui/IconButton';
import type { ColumnDef } from '@/lib/kube/columns';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';

/** Column visibility popover (persisted per kind). */
export function ColumnMenu({
  kind,
  columns,
  hidden,
}: {
  kind: string;
  columns: ColumnDef[];
  hidden: ReadonlySet<string>;
}) {
  i18n.useLocale();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ right: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const r = trigger.current?.getBoundingClientRect();
    if (r) setPos({ right: window.innerWidth - r.right, top: r.bottom + 6 });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <IconButton
        ref={trigger}
        label={i18n.t('Columns')}
        icon={<Columns3 />}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      {open &&
        pos &&
        createPortal(
          <div
            ref={panel}
            role="menu"
            className="border-border bg-surface-overlay animate-fade-in fixed z-70 w-56 rounded-lg border p-1 shadow-[0_12px_40px_rgba(0,0,0,0.35)]"
            style={{ right: pos.right, top: pos.top }}
          >
            <div className="text-fg-dim px-2 pt-1.5 pb-1 text-[10px] font-semibold tracking-[0.12em] uppercase">
              {i18n.t('Columns')}
            </div>
            {columns.map((c) => (
              <label
                key={c.id}
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] ${c.fixed ? 'text-fg-dim cursor-not-allowed' : 'text-fg-muted hover:bg-fg/4 hover:text-fg cursor-pointer'}`}
              >
                <Checkbox
                  checked={!hidden.has(c.id)}
                  disabled={c.fixed}
                  onChange={() => useWorkbenchStore.getState().toggleColumn(kind, c.id)}
                  className="mt-0"
                />
                <span className="truncate">{c.label()}</span>
              </label>
            ))}
            <div className="border-border/60 mt-1 border-t pt-1">
              <button
                type="button"
                onClick={() => useWorkbenchStore.getState().resetColumns(kind)}
                className="text-fg-dim hover:text-accent w-full rounded-md px-2 py-1.5 text-left text-[11.5px]"
              >
                {i18n.t('Reset to defaults')}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
