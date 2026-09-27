import { useRef, useState } from 'react';
import {
  pointerWithin,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { groupOf, splitSides, type SplitLayout, type SplitSide } from '@/store/splitLayout';

/** Droppable id prefixes; every other droppable id is a tab key. */
export const STRIP_DROP = 'strip:';
export const PANE_DROP = 'pane:';

export type DropZone = SplitSide | 'center';

/** Where a dragged tab should go, resolved on drop. */
export type TabDrop =
  { type: 'move'; pane: string; index?: number } | { type: 'split'; pane: string; side: SplitSide };

/** Share of a pane's width/height, from an edge, that splits instead of moving into it. */
const EDGE_ZONE = 0.3;

/**
 * Tabs win over the strip they sit in, strips over pane bodies. Pointer
 * based so a dragged tab lands where the cursor is, not where its ghost's
 * centre happens to be.
 */
export const tabCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const id = (h: { id: string | number }) => String(h.id);
  const tab = hits.find((h) => !id(h).startsWith(STRIP_DROP) && !id(h).startsWith(PANE_DROP));
  const hit =
    tab ??
    hits.find((h) => id(h).startsWith(STRIP_DROP)) ??
    hits.find((h) => id(h).startsWith(PANE_DROP));
  return hit ? [hit] : [];
};

/**
 * Drag state for tabs across the strips and panes of one split layout
 * (one `DndContext`): strips and pane bodies register droppables with the
 * prefixes above. While dragging over a pane body, `drop` previews the zone
 * (an edge splits that way, the centre moves the tab in); `end` turns the
 * drop into a `TabDrop` for the surface's store.
 */
export function useTabDrag(layout: SplitLayout) {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ pane: string; zone: DropZone } | null>(null);
  const dropRef = useRef<{ pane: string; zone: DropZone } | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const update = (next: { pane: string; zone: DropZone } | null) => {
    const prev = dropRef.current;
    if (prev?.pane === next?.pane && prev?.zone === next?.zone) return;
    dropRef.current = next;
    setDrop(next);
  };
  const cancel = () => {
    setDragKey(null);
    update(null);
  };

  const start = ({ active }: DragStartEvent) => setDragKey(String(active.id));

  const move = ({ active, over, activatorEvent, delta }: DragMoveEvent) => {
    const overId = over ? String(over.id) : '';
    if (!over || !overId.startsWith(PANE_DROP)) return update(null);
    const pane = overId.slice(PANE_DROP.length);
    const key = String(active.id);
    const origin = activatorEvent as PointerEvent;
    const x = origin.clientX + delta.x;
    const y = origin.clientY + delta.y;
    const r = over.rect;
    const distance: Record<SplitSide, number> = {
      left: (x - r.left) / r.width,
      right: (r.left + r.width - x) / r.width,
      top: (y - r.top) / r.height,
      bottom: (r.top + r.height - y) / r.height,
    };
    const edge = splitSides(layoutRef.current, pane, key)
      .filter((side) => distance[side] < EDGE_ZONE)
      .sort((a, b) => distance[a] - distance[b])[0];
    const own = groupOf(layoutRef.current, key)?.id === pane;
    update(edge ? { pane, zone: edge } : own ? null : { pane, zone: 'center' });
  };

  const end = ({ active, over }: DragEndEvent): TabDrop | null => {
    const key = String(active.id);
    const target = dropRef.current;
    cancel();
    if (!over) return null;
    const overId = String(over.id);
    if (overId.startsWith(PANE_DROP)) {
      if (!target) return null;
      return target.zone === 'center'
        ? { type: 'move', pane: target.pane }
        : { type: 'split', pane: target.pane, side: target.zone };
    }
    if (overId.startsWith(STRIP_DROP))
      return { type: 'move', pane: overId.slice(STRIP_DROP.length) };
    if (overId === key) return null;
    const pane = groupOf(layoutRef.current, overId);
    return pane ? { type: 'move', pane: pane.id, index: pane.tabs.indexOf(overId) } : null;
  };

  return { dragKey, drop, start, move, end, cancel };
}
