import * as i18n from '@/i18n';
import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import type { LayoutNode, SplitNode, SplitOrientation } from '@/store/splitLayout';
import type { DropZone } from './tabDrag';

/** Smallest pane size, in px, a divider drag can leave on each axis. */
export type MinPane = Record<SplitOrientation, number>;

/**
 * Renders a split tree: panes through `slot`, splits as rows or columns
 * with draggable dividers. `onResize` receives relative node sizes by id.
 */
export function SplitTree({
  node,
  slot,
  onResize,
  minPane,
}: {
  node: LayoutNode;
  slot: (id: string) => React.ReactNode;
  onResize: (sizes: Record<string, number>) => void;
  minPane: MinPane;
}) {
  return node.type === 'pane' ? (
    slot(node.id)
  ) : (
    <SplitRow node={node} slot={slot} onResize={onResize} minPane={minPane} />
  );
}

/** Lays a split's children out on its axis with draggable dividers between neighbours. */
function SplitRow({
  node,
  slot,
  onResize,
  minPane,
}: {
  node: SplitNode;
  slot: (id: string) => React.ReactNode;
  onResize: (sizes: Record<string, number>) => void;
  minPane: MinPane;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [live, setLive] = useState<Record<string, number> | null>(null);
  const drag = useRef<{
    a: LayoutNode;
    b: LayoutNode;
    start: number;
    px: number;
    total: number;
    /** Latest sizes, committed on release. */
    sizes?: Record<string, number>;
  } | null>(null);
  const row = node.orientation === 'row';
  // Sizes are relative; normalised grow factors keep the children filling the
  // split (factors summing below 1 would leave part of it empty).
  const total = node.children.reduce((n, c) => n + c.size, 0);

  const pairSizes = (a: LayoutNode, b: LayoutNode, px: number, next: number) => {
    const pair = a.size + b.size;
    const min = Math.min((minPane[node.orientation] / px) * total, pair / 2);
    const clamped = Math.max(min, Math.min(pair - min, next));
    return { [a.id]: clamped, [b.id]: pair - clamped };
  };
  const extent = () => {
    const rect = containerRef.current?.getBoundingClientRect();
    return rect ? (row ? rect.width : rect.height) : 0;
  };

  return (
    <div
      ref={containerRef}
      className={cn('flex min-h-0 min-w-0 flex-1', row ? 'flex-row' : 'flex-col')}
    >
      {node.children.map((child, i) => {
        const prev = node.children[i - 1];
        const size = live?.[child.id] ?? child.size;
        return (
          <Fragment key={child.id}>
            {prev && (
              <PaneDivider
                orientation={node.orientation}
                dragging={!!live && prev.id in live && child.id in live}
                onPointerDown={(e) => {
                  const px = extent();
                  if (!px) return;
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  drag.current = {
                    a: prev,
                    b: child,
                    start: row ? e.clientX : e.clientY,
                    px,
                    total,
                  };
                  setLive({ [prev.id]: prev.size, [child.id]: child.size });
                }}
                onPointerMove={(e) => {
                  const d = drag.current;
                  if (!d) return;
                  const moved = (((row ? e.clientX : e.clientY) - d.start) / d.px) * d.total;
                  d.sizes = pairSizes(d.a, d.b, d.px, d.a.size + moved);
                  setLive(d.sizes);
                }}
                onPointerUp={() => {
                  const sizes = drag.current?.sizes;
                  drag.current = null;
                  setLive(null);
                  if (sizes) onResize(sizes);
                }}
                onDoubleClick={() => {
                  const pair = prev.size + child.size;
                  onResize({ [prev.id]: pair / 2, [child.id]: pair / 2 });
                }}
                onKeyDown={(e) => {
                  const keys = row ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
                  if (!keys.includes(e.key)) return;
                  e.preventDefault();
                  const px = extent();
                  if (!px) return;
                  const step = (e.shiftKey ? 0.1 : 0.03) * total * (e.key === keys[0] ? -1 : 1);
                  onResize(pairSizes(prev, child, px, prev.size + step));
                }}
              />
            )}
            <div className="flex min-h-0 min-w-0 flex-col" style={{ flex: `${size / total} 1 0%` }}>
              {child.type === 'pane' ? (
                slot(child.id)
              ) : (
                <SplitRow node={child} slot={slot} onResize={onResize} minPane={minPane} />
              )}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

function PaneDivider({
  orientation,
  dragging,
  ...handlers
}: {
  orientation: SplitOrientation;
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}) {
  i18n.useLocale();
  const row = orientation === 'row';
  return (
    <div className={cn('bg-border/70 relative shrink-0', row ? 'w-px' : 'h-px')}>
      <div
        {...handlers}
        role="separator"
        aria-orientation={row ? 'vertical' : 'horizontal'}
        tabIndex={0}
        title={i18n.t('Resize panes · drag or use arrow keys · double-click to equalize')}
        className={cn(
          'group absolute z-20 touch-none select-none focus-visible:outline-none',
          row
            ? 'inset-y-0 -right-1 -left-1 cursor-col-resize'
            : 'inset-x-0 -top-1 -bottom-1 cursor-row-resize',
        )}
      >
        <span
          className={cn(
            'pointer-events-none absolute transition-colors',
            row
              ? 'inset-y-0 left-1/2 w-px -translate-x-1/2'
              : 'inset-x-0 top-1/2 h-px -translate-y-1/2',
            dragging
              ? 'bg-accent'
              : 'group-hover:bg-accent/60 group-focus-visible:bg-accent/60 bg-transparent',
          )}
        />
      </div>
    </div>
  );
}

/**
 * One detached element per key that its content portals into. Layout edits
 * move the element between `HostSlot`s instead of remounting the content,
 * so pages, terminals and scroll-free state survive splits and moves.
 * Elements of keys no longer listed are dropped.
 */
export function useHosts(keys: readonly string[]): (key: string) => HTMLDivElement {
  const hosts = useRef(new Map<string, HTMLDivElement>());
  const live = new Set(keys);
  for (const key of hosts.current.keys()) if (!live.has(key)) hosts.current.delete(key);
  return (key) => {
    let host = hosts.current.get(key);
    if (!host) {
      host = document.createElement('div');
      host.className = 'flex min-h-0 min-w-0 flex-1 flex-col';
      hosts.current.set(key, host);
    }
    return host;
  };
}

/** Where a host's content shows; adopts the host element while mounted. */
export function HostSlot({ host, className }: { host: HTMLDivElement; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    slot.appendChild(host);
    return () => {
      if (host.parentNode === slot) slot.removeChild(host);
    };
  }, [host]);
  return <div ref={ref} className={className ?? 'flex min-h-0 min-w-0 flex-1 flex-col'} />;
}

const ZONE_CLASS: Record<DropZone, string> = {
  center: 'inset-1.5',
  left: 'inset-y-1.5 left-1.5 w-[calc(50%-0.375rem)]',
  right: 'inset-y-1.5 right-1.5 w-[calc(50%-0.375rem)]',
  top: 'inset-x-1.5 top-1.5 h-[calc(50%-0.375rem)]',
  bottom: 'inset-x-1.5 bottom-1.5 h-[calc(50%-0.375rem)]',
};

/** Preview of where a dragged tab lands in a pane (the pane body must be `relative`). */
export function DropZoneOverlay({ zone }: { zone: DropZone | null }) {
  if (!zone) return null;
  return (
    <div
      aria-hidden
      className={cn(
        'border-accent/60 bg-accent/10 pointer-events-none absolute z-30 rounded-md border transition-all duration-100',
        ZONE_CLASS[zone],
      )}
    />
  );
}
