import * as i18n from '@/i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Lock, Plus, Server, X } from 'lucide-react';
import { Checkbox } from '@/components/ui/Choice';
import { EnvPill } from '@/components/workbench/ClusterAvatar';
import { clusterColor } from '@/lib/clusterMeta';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/useAppStore';
import type { ClusterDef, ClusterId } from '@/types';

/**
 * Cluster multi-select for diffs and applies. Read-only clusters can be
 * picked (a diff only reads) and are marked as excluded from apply;
 * disconnected clusters are connected when the diff runs.
 */
export function TargetPicker({
  value,
  onChange,
  disabled,
}: {
  value: ClusterId[];
  onChange: (next: ClusterId[]) => void;
  disabled?: boolean;
}) {
  i18n.useLocale();
  const clusters = useAppStore((s) => s.clusters);
  const statuses = useAppStore((s) => s.statuses);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const picked = value
    .map((id) => clusters.find((c) => c.id === id))
    .filter((c): c is ClusterDef => !!c);

  const toggle = (id: ClusterId) =>
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);

  useLayoutEffect(() => {
    if (!open) return;
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const height = Math.min(360, 44 + clusters.length * 34);
    const top = r.top - height - 6 > 8 ? r.top - height - 6 : r.bottom + 6;
    setPos({ left: Math.min(r.left, window.innerWidth - 312), top });
  }, [open, clusters.length]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div className="flex min-w-0 items-center gap-1">
      {picked.map((c) => (
        <span
          key={c.id}
          className="border-border/70 bg-surface/60 text-fg flex h-6 max-w-44 shrink-0 items-center gap-1.5 rounded-md border pr-0.5 pl-1.5 text-[11px]"
          title={
            c.read_only
              ? i18n.t('{cluster} is read-only: it is diffed, never applied', { cluster: c.name })
              : c.name
          }
        >
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: clusterColor(c) }}
          />
          <span className="min-w-0 truncate">{c.name}</span>
          {c.read_only && <Lock className="text-fg-dim h-2.5 w-2.5 shrink-0" />}
          <button
            type="button"
            disabled={disabled || picked.length === 1}
            onClick={() => toggle(c.id)}
            aria-label={i18n.t('Remove {cluster}', { cluster: c.name })}
            className="text-fg-dim hover:text-fg hover:bg-fg/8 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded disabled:hidden"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </span>
      ))}
      <button
        ref={trigger}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={i18n.t('Diff and apply to several clusters at once')}
        className={cn(
          'text-fg-dim hover:text-fg hover:bg-fg/5 flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors disabled:opacity-50',
          open && 'bg-fg/5 text-fg',
        )}
      >
        <Plus className="h-3 w-3" />
        {i18n.t('Clusters')}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panel}
            role="listbox"
            aria-multiselectable
            aria-label={i18n.t('Target clusters')}
            className="border-border bg-surface-overlay animate-fade-in fixed z-70 flex max-h-[360px] w-[300px] flex-col overflow-hidden rounded-lg border shadow-[0_12px_40px_rgba(0,0,0,0.35)]"
            style={{ left: pos.left, top: pos.top }}
          >
            <div className="text-fg-dim border-border/60 flex h-8 shrink-0 items-center gap-1.5 border-b px-3 text-[10.5px] font-semibold tracking-[0.08em] uppercase">
              <Server className="h-3 w-3" />
              {i18n.t('Target clusters')}
            </div>
            <div className="overlay-scroll min-h-0 flex-1 overflow-auto p-1">
              {clusters.map((c) => {
                const on = value.includes(c.id);
                const connected = statuses[c.id]?.state === 'connected';
                return (
                  <label
                    key={c.id}
                    className="hover:bg-fg/4 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12px]"
                  >
                    <Checkbox
                      checked={on}
                      disabled={on && value.length === 1}
                      onChange={() => toggle(c.id)}
                      aria-label={c.name}
                      className="mt-0"
                    />
                    <span
                      aria-hidden
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: clusterColor(c) }}
                    />
                    <span
                      className={cn('min-w-0 flex-1 truncate', on ? 'text-fg' : 'text-fg-muted')}
                    >
                      {c.name}
                    </span>
                    {c.read_only && (
                      <span
                        className="text-fg-dim flex shrink-0 items-center gap-1 text-[10px]"
                        title={i18n.t('Read-only cluster: diffed, but excluded from apply')}
                      >
                        <Lock className="h-2.5 w-2.5" />
                        {i18n.t('Diff only')}
                      </span>
                    )}
                    {!connected && (
                      <span
                        className="text-fg-dim shrink-0 text-[10px]"
                        title={i18n.t('Connects when the diff runs')}
                      >
                        {i18n.t('Offline')}
                      </span>
                    )}
                    <EnvPill cluster={c} />
                  </label>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
