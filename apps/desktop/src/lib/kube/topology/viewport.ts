/** Pan/zoom math for the map canvas (screen = content × k + (x, y)). */

export interface Viewport {
  x: number;
  y: number;
  k: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const ZOOM_MIN = 0.12;
export const ZOOM_MAX = 2.5;

export function clampZoom(k: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k));
}

/** Zoom by `factor` keeping the screen point (px, py) fixed. */
export function zoomAt(v: Viewport, factor: number, px: number, py: number): Viewport {
  const k = clampZoom(v.k * factor);
  const ratio = k / v.k;
  return { k, x: px - (px - v.x) * ratio, y: py - (py - v.y) * ratio };
}

/** Fit content of `content` size into the viewport; never zooms in past `maxK`. */
export function fitView(content: Size, view: Size, padding = 24, maxK = 1): Viewport {
  if (!content.width || !content.height || !view.width || !view.height) return { x: 0, y: 0, k: 1 };
  const k = clampZoom(
    Math.min(
      maxK,
      (view.width - padding * 2) / content.width,
      (view.height - padding * 2) / content.height,
    ),
  );
  return {
    k,
    x: (view.width - content.width * k) / 2,
    y: (view.height - content.height * k) / 2,
  };
}

/** Center a content rectangle, keeping the zoom (raised to `minK` when tiny). */
export function centerOn(v: Viewport, rect: Rect, view: Size, minK = 0.6): Viewport {
  const k = Math.max(v.k, minK);
  return {
    k,
    x: view.width / 2 - (rect.x + rect.w / 2) * k,
    y: view.height / 2 - (rect.y + rect.h / 2) * k,
  };
}

/** Pan the least amount that brings `rect` (plus margin) into view. */
export function ensureVisible(v: Viewport, rect: Rect, view: Size, margin = 32): Viewport {
  const left = rect.x * v.k + v.x;
  const top = rect.y * v.k + v.y;
  const right = left + rect.w * v.k;
  const bottom = top + rect.h * v.k;
  let { x, y } = v;
  if (left < margin) x += margin - left;
  else if (right > view.width - margin) x -= right - (view.width - margin);
  if (top < margin) y += margin - top;
  else if (bottom > view.height - margin) y -= bottom - (view.height - margin);
  return x === v.x && y === v.y ? v : { ...v, x, y };
}
