import * as i18n from '@/i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EyeOff } from 'lucide-react';
import { useHealthStore } from '@/store/useHealthStore';

const MAX_NAMESPACES = 8;

/** "Ignore rule" popover: everywhere, or only in one of the namespaces the rule fires in. */
export function IgnoreMenu({
  clusterId,
  rule,
  namespaces,
}: {
  clusterId: string;
  rule: string;
  /** Namespaces of the rule's findings, most affected first. */
  namespaces: string[];
}) {
  i18n.useLocale();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ right: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const r = trigger.current?.getBoundingClientRect();
    if (r) setPos({ right: window.innerWidth - r.right, top: r.bottom + 4 });
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

  const choose = (namespace: string | null) => {
    useHealthStore.getState().ignore(clusterId, rule, namespace);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="text-fg-dim hover:text-fg hover:bg-fg/5 flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] transition"
      >
        <EyeOff className="h-3 w-3" />
        {i18n.t('Ignore')}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panel}
            role="menu"
            aria-label={i18n.t('Ignore rule')}
            className="border-border bg-surface-overlay fixed z-[200] max-w-[280px] min-w-[200px] rounded-lg border py-1 shadow-[0_12px_40px_rgba(0,0,0,0.35)]"
            style={{ right: pos.right, top: pos.top }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => choose(null)}
              className="text-fg hover:bg-accent/10 flex w-full items-center px-3 py-1.5 text-left text-[12px]"
            >
              {i18n.t('Ignore in every namespace')}
            </button>
            {namespaces.length > 0 && <div className="border-border my-1 border-t" />}
            {namespaces.slice(0, MAX_NAMESPACES).map((ns) => (
              <button
                key={ns}
                type="button"
                role="menuitem"
                onClick={() => choose(ns)}
                className="text-fg hover:bg-accent/10 flex w-full items-center px-3 py-1.5 text-left text-[12px]"
              >
                <span className="truncate">
                  {i18n.rich('Ignore in {namespace}', {
                    namespace: <span className="font-mono text-[11.5px]">{ns}</span>,
                  })}
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
