import * as i18n from '@/i18n';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ListFilter } from 'lucide-react';
import { Checkbox } from '@/components/ui/Choice';
import type { ColumnDef, KindColumns } from '@/lib/kube/columns';
import { cn } from '@/lib/cn';
import type { KubeObject } from '@/types';
import { facetCounts, facetSelection, withFacet } from './tableModel';

const PANEL_WIDTH = 240;

/**
 * Header button of a facet column: picks the values to show. The pick lives
 * in the table's filter text (`status:Running,Pending`), so saved views,
 * exports and the filtered count follow it.
 */
export function ColumnFilterMenu({
  column,
  kind,
  items,
  filter,
  onChange,
}: {
  column: ColumnDef;
  kind: KindColumns;
  /** Every item the table watches, before filtering (for the counts). */
  items: readonly KubeObject[];
  filter: string;
  onChange: (filter: string) => void;
}) {
  i18n.useLocale();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const label = column.label();
  const selected = facetSelection(filter, kind, column.id);
  const summary = selected.length
    ? i18n.t('Filter by {column}: {values}', { column: label, values: selected.join(', ') })
    : i18n.t('Filter by {column}', { column: label });
  const picked = new Set(selected.map((v) => v.toLowerCase()));
  const active = selected.length > 0;

  const rows = useMemo(() => {
    if (!open) return [];
    const counts = facetCounts(items, column);
    const known = new Set(counts.map((c) => c.value.toLowerCase()));
    // A pick no item carries right now (e.g. from a saved view) stays uncheckable.
    const missing = selected
      .filter((v) => !known.has(v.toLowerCase()))
      .map((value) => ({ value, count: 0 }));
    return [...counts, ...missing];
    // `selected` is derived from `filter`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, items, column, filter]);

  useLayoutEffect(() => {
    if (!open) return;
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.min(Math.max(8, r.left - 8), window.innerWidth - PANEL_WIDTH - 8);
    setPos({ left, top: r.bottom + 6 });
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

  const pick = (values: string[]) => onChange(withFacet(filter, kind, column.id, values));
  const toggle = (value: string) =>
    pick(
      picked.has(value.toLowerCase())
        ? selected.filter((v) => v.toLowerCase() !== value.toLowerCase())
        : [...selected, value],
    );

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={summary}
        title={summary}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'ml-1 inline-flex h-4 shrink-0 items-center justify-center gap-0.5 rounded-sm px-0.5 transition-colors',
          active ? 'text-accent hover:bg-accent/15' : 'text-fg-dim/60 hover:bg-fg/10 hover:text-fg',
        )}
      >
        <ListFilter className="h-3 w-3" />
        {active && <span className="text-[10px] tabular-nums">{selected.length}</span>}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panel}
            role="dialog"
            aria-label={i18n.t('Filter by {column}', { column: label })}
            className="border-border bg-surface-overlay animate-fade-in fixed z-70 flex max-h-[60vh] flex-col rounded-lg border p-1 shadow-[0_12px_40px_rgba(0,0,0,0.35)]"
            style={{ left: pos.left, top: pos.top, width: PANEL_WIDTH }}
          >
            <div className="text-fg-dim flex items-baseline justify-between gap-2 px-2 pt-1.5 pb-1">
              <span className="truncate text-[10px] font-semibold tracking-[0.12em] uppercase">
                {i18n.t('Filter by {column}', { column: label })}
              </span>
              <span className="shrink-0 text-[10.5px]">
                {active
                  ? i18n.t('{count} selected', { count: selected.length })
                  : i18n.t('All shown')}
              </span>
            </div>
            <div className="overlay-scroll min-h-0 flex-1 overflow-y-auto">
              {rows.length === 0 ? (
                <p className="text-fg-dim px-2 py-2 text-[11.5px]">{i18n.t('No values yet')}</p>
              ) : (
                rows.map(({ value, count }) => (
                  <div
                    key={value}
                    className="group text-fg-muted hover:bg-fg/4 hover:text-fg flex items-center gap-1 rounded-md pr-1.5 pl-2 text-[12px]"
                  >
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5">
                      <Checkbox
                        checked={picked.has(value.toLowerCase())}
                        onChange={() => toggle(value)}
                        className="mt-0"
                      />
                      <span className="truncate" title={value}>
                        {value}
                      </span>
                    </label>
                    <button
                      type="button"
                      onClick={() => pick([value])}
                      className="text-fg-dim hover:text-accent rounded px-1 text-[10.5px] opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      {i18n.t('Only')}
                    </button>
                    <span className="text-fg-dim w-7 shrink-0 text-right text-[11px] tabular-nums">
                      {count}
                    </span>
                  </div>
                ))
              )}
            </div>
            <div className="border-border/60 mt-1 border-t pt-1">
              <button
                type="button"
                disabled={!active}
                onClick={() => pick([])}
                className="text-fg-dim hover:text-accent disabled:hover:text-fg-dim w-full rounded-md px-2 py-1.5 text-left text-[11.5px] disabled:opacity-50"
              >
                {i18n.t('Show all')}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
