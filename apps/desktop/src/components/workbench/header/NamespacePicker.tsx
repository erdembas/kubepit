import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, FolderTree, Search } from 'lucide-react';
import { Checkbox } from '@/components/ui/Choice';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/useAppStore';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import { useNamespaceNames, useSelectedNamespaces } from '../data/hooks';
import { useWatch } from '../data/watchCache';

const NS_GVK = toGvk(BUILTIN.Namespace);

/** Multi-select namespace scope for the whole workbench (persisted per cluster). */
export function NamespacePicker({ clusterId, isActive }: { clusterId: string; isActive: boolean }) {
  i18n.useLocale();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const selected = useSelectedNamespaces(clusterId);
  const accessible = useAppStore(
    (s) => s.clusters.find((c) => c.id === clusterId)?.accessible_namespaces ?? [],
  );
  const names = useNamespaceNames(clusterId, isActive && !accessible.length);
  const live = useWatch(clusterId, NS_GVK, [], isActive && open && !accessible.length);

  const options = useMemo(() => {
    if (accessible.length) return [...accessible].sort();
    const set = new Set<string>([...(names.data ?? []), ...selected]);
    for (const o of live.items) set.add(o.metadata.name);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [accessible, names.data, live.items, selected]);
  const filtered = options.filter((n) => n.toLowerCase().includes(query.trim().toLowerCase()));

  const set = (next: string[]) => useWorkbenchStore.getState().setNamespaces(clusterId, next);
  const toggle = (ns: string) =>
    set(selected.includes(ns) ? selected.filter((x) => x !== ns) : [...selected, ns]);

  useLayoutEffect(() => {
    if (!open) return;
    const r = trigger.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.min(r.left, window.innerWidth - 292), top: r.bottom + 6 });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    setQuery('');
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

  const label =
    selected.length === 0
      ? i18n.t('All namespaces')
      : selected.length === 1
        ? selected[0]!
        : i18n.t('{count} namespaces', { count: selected.length });

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={i18n.t('Namespaces')}
        title={selected.length > 1 ? selected.join('\n') : undefined}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'border-border/70 bg-surface/60 text-fg-muted hover:text-fg hover:bg-fg/4 flex h-8 max-w-56 min-w-0 shrink items-center gap-1.5 rounded-lg border px-2.5 text-[12px] transition-colors',
          open && 'bg-fg/5 text-fg',
          selected.length > 0 && 'text-fg',
        )}
      >
        <FolderTree className="text-fg-dim h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown
          className={cn('text-fg-dim h-3 w-3 shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panel}
            role="listbox"
            aria-multiselectable
            aria-label={i18n.t('Namespaces')}
            className="border-border bg-surface-overlay animate-fade-in fixed z-70 flex max-h-[420px] w-[280px] flex-col overflow-hidden rounded-lg border shadow-[0_12px_40px_rgba(0,0,0,0.35)]"
            style={{ left: pos.left, top: pos.top }}
          >
            <div className="border-border/60 flex items-center gap-2 border-b px-2.5">
              <Search className="text-fg-dim h-3.5 w-3.5 shrink-0" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={i18n.t('Filter namespaces…')}
                aria-label={i18n.t('Filter namespaces')}
                className="text-fg placeholder:text-fg-dim w-full bg-transparent py-2 text-[12px] outline-none"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && filtered[0]) toggle(filtered[0]);
                }}
              />
            </div>
            <div className="overlay-scroll min-h-0 flex-1 overflow-auto p-1">
              <button
                type="button"
                role="option"
                aria-selected={selected.length === 0}
                onClick={() => set([])}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors',
                  selected.length === 0
                    ? 'bg-fg/7 text-fg font-medium'
                    : 'text-fg-muted hover:bg-fg/4 hover:text-fg',
                )}
              >
                <Check
                  className={cn(
                    'h-3.5 w-3.5 shrink-0',
                    selected.length === 0 ? 'text-accent' : 'opacity-0',
                  )}
                />
                {i18n.t('All namespaces')}
                <span className="text-fg-dim ml-auto text-[10.5px] tabular-nums">
                  {options.length}
                </span>
              </button>
              <div className="border-border/60 my-1 border-t" />
              {filtered.map((ns) => {
                const on = selected.includes(ns);
                return (
                  <div key={ns} className="group hover:bg-fg/4 flex items-center rounded-md">
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-1.5 text-[12px]">
                      <Checkbox
                        checked={on}
                        onChange={() => toggle(ns)}
                        aria-label={ns}
                        className="mt-0"
                      />
                      <span className={cn('min-w-0 truncate', on ? 'text-fg' : 'text-fg-muted')}>
                        {ns}
                      </span>
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        set([ns]);
                        setOpen(false);
                      }}
                      className="text-fg-dim hover:text-accent mr-1 shrink-0 rounded px-1.5 py-0.5 text-[10.5px] opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      {i18n.t('only')}
                    </button>
                  </div>
                );
              })}
              {!filtered.length && (
                <p className="text-fg-dim px-3 py-6 text-center text-[12px]">
                  {i18n.t('No matching namespaces')}
                </p>
              )}
            </div>
            {selected.length > 0 && (
              <div className="border-border/60 text-fg-dim flex items-center justify-between border-t px-3 py-1.5 text-[11px]">
                <span>{i18n.t('{count} selected', { count: selected.length })}</span>
                <button type="button" onClick={() => set([])} className="hover:text-accent">
                  {i18n.t('Clear')}
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
