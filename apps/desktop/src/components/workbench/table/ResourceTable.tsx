import * as i18n from '@/i18n';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { Checkbox } from '@/components/ui/Choice';
import type { ColumnContext, ColumnDef } from '@/lib/kube/columns';
import { cn } from '@/lib/cn';
import type { SortPref } from '@/store/useWorkbenchStore';
import type { KubeObject } from '@/types';
import { trackMin } from './tableModel';

export const ROW_HEIGHT = 32;
const OVERSCAN = 10;

interface RowProps {
  obj: KubeObject;
  index: number;
  columns: ColumnDef[];
  template: string;
  ctx: ColumnContext;
  checked: boolean;
  active: boolean;
  selectable: boolean;
  onOpen: (obj: KubeObject) => void;
  onToggle: (uid: string, index: number, shift: boolean) => void;
  onContextMenu: (e: React.MouseEvent, obj: KubeObject) => void;
}

const Row = memo(function Row({
  obj,
  index,
  columns,
  template,
  ctx,
  checked,
  active,
  selectable,
  onOpen,
  onToggle,
  onContextMenu,
}: RowProps) {
  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      aria-selected={active}
      data-uid={obj.metadata.uid}
      onClick={(e) => {
        if (e.shiftKey && selectable) onToggle(obj.metadata.uid, index, true);
        else onOpen(obj);
      }}
      onContextMenu={(e) => onContextMenu(e, obj)}
      style={{ gridTemplateColumns: template, height: ROW_HEIGHT }}
      className={cn(
        'border-border/40 grid cursor-default items-center gap-x-2.5 border-b px-3 text-[12px] transition-colors select-none',
        active
          ? 'bg-fg/7 shadow-[inset_2px_0_0_rgb(var(--accent))]'
          : checked
            ? 'bg-accent/[0.06] hover:bg-accent/[0.09]'
            : 'hover:bg-fg/4',
        obj.metadata.deletionTimestamp && 'opacity-60',
      )}
    >
      {selectable && (
        <div role="cell" className="flex items-center" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={checked}
            aria-label={i18n.t('Select {name}', { name: obj.metadata.name })}
            onChange={() => undefined}
            onClick={(e) => onToggle(obj.metadata.uid, index, e.shiftKey)}
            className="mt-0"
          />
        </div>
      )}
      {columns.map((c) => (
        <div
          key={c.id}
          role="cell"
          className={cn(
            'flex min-w-0 items-center overflow-hidden',
            c.align === 'right' && 'justify-end',
            c.align === 'center' && 'justify-center',
          )}
        >
          {c.cell(obj, ctx)}
        </div>
      ))}
    </div>
  );
});

export interface ResourceTableProps {
  items: KubeObject[];
  columns: ColumnDef[];
  ctx: ColumnContext;
  sort: SortPref;
  onSort: (column: string) => void;
  checked: ReadonlySet<string>;
  onToggle: (uid: string, index: number, shift: boolean) => void;
  onToggleAll: () => void;
  activeUid: string | null;
  onOpen: (obj: KubeObject) => void;
  onContextMenu: (e: React.MouseEvent, obj: KubeObject) => void;
  selectable: boolean;
  /** Bump to scroll the active row into view. */
  revealKey?: number;
  /** Extra scroll space under the last row, e.g. for a floating bar. */
  bottomInset?: number;
  label: string;
}

/** Fixed-row-height windowed table: renders only visible rows, handles 5k+ items. */
export function ResourceTable(p: ResourceTableProps) {
  i18n.useLocale();
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const frame = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight || 600);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const activeIndex = p.activeUid ? p.items.findIndex((o) => o.metadata.uid === p.activeUid) : -1;
  useEffect(() => {
    const el = scroller.current;
    if (!el || activeIndex < 0) return;
    const top = activeIndex * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT + ROW_HEIGHT; // header row
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    // Only when asked (navigation) or when the active row moves by keyboard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.revealKey, activeIndex]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(p.items.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);
  const template = [p.selectable ? '18px' : null, ...p.columns.map((c) => c.width)]
    .filter(Boolean)
    .join(' ');
  const minWidth =
    p.columns.reduce((s, c) => s + trackMin(c.width) + 10, p.selectable ? 28 : 0) + 24;
  const allChecked = p.items.length > 0 && p.items.every((o) => p.checked.has(o.metadata.uid));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (!p.items.length) return;
    e.preventDefault();
    const from = activeIndex < 0 ? -1 : activeIndex;
    const next =
      p.items[Math.max(0, Math.min(p.items.length - 1, from + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) p.onOpen(next);
  };

  return (
    <div
      ref={scroller}
      role="table"
      aria-label={p.label}
      aria-rowcount={p.items.length + 1}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop;
        if (frame.current !== null) return;
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          setScrollTop(top);
        });
      }}
      className="relative min-h-0 flex-1 overflow-auto focus-visible:outline-none"
    >
      <div style={{ minWidth, paddingBottom: p.bottomInset }}>
        <div role="rowgroup" className="bg-surface/95 sticky top-0 z-10 backdrop-blur-sm">
          <div
            role="row"
            style={{ gridTemplateColumns: template, height: ROW_HEIGHT }}
            className="border-border/70 text-fg-dim grid items-center gap-x-2.5 border-b px-3 text-[10.5px] font-semibold tracking-[0.08em] uppercase"
          >
            {p.selectable && (
              <div role="columnheader" className="flex items-center">
                <Checkbox
                  checked={allChecked}
                  onChange={p.onToggleAll}
                  aria-label={i18n.t('Select all')}
                  className="mt-0"
                />
              </div>
            )}
            {p.columns.map((c) => {
              const sorted = p.sort.column === c.id;
              return (
                <div
                  key={c.id}
                  role="columnheader"
                  aria-sort={sorted ? (p.sort.desc ? 'descending' : 'ascending') : undefined}
                  className={cn(
                    'flex min-w-0 items-center',
                    c.align === 'right' && 'justify-end',
                    c.align === 'center' && 'justify-center',
                  )}
                >
                  {c.sort ? (
                    <button
                      type="button"
                      onClick={() => p.onSort(c.id)}
                      title={c.compact ? c.label() : undefined}
                      className={cn(
                        'hover:text-fg inline-flex min-w-0 items-center gap-1 truncate transition-colors',
                        sorted && 'text-fg',
                      )}
                    >
                      <span className={cn('truncate', c.compact && 'sr-only')}>{c.label()}</span>
                      {sorted &&
                        (p.sort.desc ? (
                          <ArrowDown className="h-3 w-3 shrink-0" />
                        ) : (
                          <ArrowUp className="h-3 w-3 shrink-0" />
                        ))}
                    </button>
                  ) : (
                    <span className={cn('truncate', c.compact && 'sr-only')}>{c.label()}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div role="rowgroup" style={{ height: p.items.length * ROW_HEIGHT, position: 'relative' }}>
          <div style={{ transform: `translateY(${start * ROW_HEIGHT}px)` }}>
            {p.items.slice(start, end).map((obj, i) => (
              <Row
                key={obj.metadata.uid}
                obj={obj}
                index={start + i}
                columns={p.columns}
                template={template}
                ctx={p.ctx}
                checked={p.checked.has(obj.metadata.uid)}
                active={obj.metadata.uid === p.activeUid}
                selectable={p.selectable}
                onOpen={p.onOpen}
                onToggle={p.onToggle}
                onContextMenu={p.onContextMenu}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
