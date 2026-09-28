/** Pixels per wheel line (`deltaMode` 1), as browsers scroll a line. */
const LINE_PX = 16;
/** Pixels per wheel page (`deltaMode` 2). */
const PAGE_PX = 240;

/**
 * Horizontal scroll, in pixels, of a wheel event over a horizontal strip (tab
 * bars): the dominant axis wins, so a vertical mouse wheel scrolls sideways
 * and a trackpad's horizontal swipe keeps its own direction.
 */
export function horizontalWheelDelta(e: {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
}): number {
  const delta = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (e.deltaMode === 1) return delta * LINE_PX;
  if (e.deltaMode === 2) return delta * PAGE_PX;
  return delta;
}
