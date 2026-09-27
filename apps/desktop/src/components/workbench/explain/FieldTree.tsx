import * as i18n from '@/i18n';
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronRight, Repeat } from 'lucide-react';
import type { TreeRow } from '@/lib/kube/schema/tree';
import { cn } from '@/lib/cn';

const ROW = 26;
const OVERSCAN = 12;

/** First sentence of a description, for the one-line summary. */
function summary(description: string): string {
  const text = description.replace(/\s+/g, ' ').trim();
  const end = text.search(/\.(\s|$)/);
  return end > 0 ? text.slice(0, end + 1) : text;
}

/**
 * Windowed field tree. Arrow keys move the selection (← / → collapse,
 * expand or step to the parent / first child), Enter toggles.
 */
export function FieldTree({
  rows,
  selectedId,
  revealKey,
  filtering,
  onSelect,
  onToggle,
}: {
  rows: TreeRow[];
  selectedId: string | null;
  /** Changes when the selected row should be scrolled into view. */
  revealKey: number;
  filtering: boolean;
  onSelect: (row: TreeRow) => void;
  onToggle: (row: TreeRow, open?: boolean) => void;
}) {
  i18n.useLocale();
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const revealed = useRef(-1);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setView({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Scroll a requested row into view once it exists (the schema may still be loading).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || revealed.current === revealKey || !selectedId) return;
    const index = rows.findIndex((r) => r.id === selectedId);
    if (index < 0) return;
    revealed.current = revealKey;
    const top = index * ROW;
    if (top < el.scrollTop || top + ROW > el.scrollTop + el.clientHeight)
      el.scrollTop = Math.max(0, top - el.clientHeight / 3);
  }, [revealKey, rows, selectedId]);

  const scrollToIndex = (index: number) => {
    const el = scroller.current;
    if (!el) return;
    const top = index * ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!rows.length) return;
    const at = rows.findIndex((r) => r.id === selectedId);
    const move = (index: number) => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
      if (!row) return;
      onSelect(row);
      scrollToIndex(rows.indexOf(row));
    };
    const current = rows[at];
    switch (e.key) {
      case 'ArrowDown':
        move(at < 0 ? 0 : at + 1);
        break;
      case 'ArrowUp':
        move(at < 0 ? 0 : at - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(rows.length - 1);
        break;
      case 'ArrowRight':
        if (!current) return move(0);
        if (current.field.expandable && !current.recursive && !current.expanded)
          onToggle(current, true);
        else if (current.expanded) move(at + 1);
        break;
      case 'ArrowLeft': {
        if (!current) return;
        if (current.expanded && !filtering) {
          onToggle(current, false);
          break;
        }
        for (let i = at - 1; i >= 0; i--) {
          if (rows[i]!.depth < current.depth) {
            move(i);
            break;
          }
        }
        break;
      }
      case 'Enter':
        if (current?.field.expandable && !current.recursive && !filtering) onToggle(current);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const first = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW) + OVERSCAN);
  return (
    <div
      ref={scroller}
      role="tree"
      aria-label={i18n.t('Fields')}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop;
        setView((v) => ({ ...v, top }));
      }}
      className="min-h-0 flex-1 overflow-auto outline-none"
    >
      <div style={{ height: rows.length * ROW }} className="relative min-w-[520px]">
        {rows.slice(first, last).map((row, i) => {
          const active = row.id === selectedId;
          const { field } = row;
          const canToggle = field.expandable && !row.recursive && !filtering;
          return (
            <div
              key={row.id}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={active}
              aria-expanded={field.expandable && !row.recursive ? row.expanded : undefined}
              onClick={() => onSelect(row)}
              onDoubleClick={() => canToggle && onToggle(row)}
              style={{ top: (first + i) * ROW, height: ROW, paddingLeft: 8 + row.depth * 14 }}
              className={cn(
                'absolute inset-x-0 flex cursor-default items-center gap-1.5 pr-3 text-[12px] transition-colors',
                active ? 'bg-fg/7 shadow-[inset_2px_0_0_rgb(var(--accent))]' : 'hover:bg-fg/4',
              )}
            >
              {field.expandable && !row.recursive ? (
                <button
                  type="button"
                  tabIndex={-1}
                  disabled={!canToggle}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(row);
                  }}
                  aria-label={row.expanded ? i18n.t('Collapse') : i18n.t('Expand')}
                  className="text-fg-dim hover:text-fg hover:bg-fg/10 flex h-4 w-4 shrink-0 items-center justify-center rounded disabled:hover:bg-transparent"
                >
                  <ChevronRight
                    className={cn('h-3 w-3 transition-transform', row.expanded && 'rotate-90')}
                  />
                </button>
              ) : (
                <span className="w-4 shrink-0" />
              )}
              <span
                className={cn(
                  'shrink-0 font-mono',
                  field.deprecated ? 'text-fg-dim line-through' : 'text-fg',
                  filtering && row.match && 'text-accent font-semibold',
                )}
              >
                {field.name}
              </span>
              {field.required && (
                <span className="text-accent shrink-0 text-[9.5px] font-semibold tracking-[0.08em] uppercase">
                  {i18n.t('required')}
                </span>
              )}
              <span className="text-fg-dim shrink-0 font-mono text-[11px]">{field.type}</span>
              {row.recursive && (
                <Repeat
                  className="text-fg-dim h-3 w-3 shrink-0"
                  aria-label={i18n.t('Recursive: this type already appears above')}
                />
              )}
              <span className="text-fg-muted min-w-0 flex-1 truncate pl-1 text-[11.5px]">
                {summary(field.description)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
