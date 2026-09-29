import type { CollisionDetection } from '@dnd-kit/core';
import { tabCollision } from '@/components/split/tabDrag';

/** Hidden scrollable tabs cannot intercept drops over fixed pins or neighbouring panes. */
export const viewTabCollision: CollisionDetection = (args) => {
  const pointer = args.pointerCoordinates;
  if (!pointer) return tabCollision(args);
  const bounds = new Map<Element, DOMRect>();
  const droppableContainers = args.droppableContainers.filter(({ node }) => {
    const viewport = node.current?.closest('[data-view-tabs-scroll]');
    if (!viewport) return true;
    let rect = bounds.get(viewport);
    if (!rect) {
      rect = viewport.getBoundingClientRect();
      bounds.set(viewport, rect);
    }
    return (
      pointer.x >= rect.left &&
      pointer.x <= rect.right &&
      pointer.y >= rect.top &&
      pointer.y <= rect.bottom
    );
  });
  return tabCollision({ ...args, droppableContainers });
};
