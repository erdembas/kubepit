/**
 * Chart math for the metrics-history charts (pure, no React): nice axis
 * ticks for millicores and bytes, gap-aware segments and monotone-cubic
 * paths that never overshoot the data (a usage curve dipping below zero or
 * above its peak between samples would lie).
 */

export interface SeriesPoint {
  /** Epoch ms. */
  t: number;
  v: number;
}

export interface Scale {
  max: number;
  ticks: number[];
}

/** Range choices of the charts, in minutes. */
export const RANGES = [15, 30, 60] as const;
export type RangeMinutes = (typeof RANGES)[number];

function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = 10 ** exp;
  const f = raw / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * base;
}

/**
 * Axis from 0 to a round value ≥ `max` with about `target` intervals.
 * `binary` steps in powers of 1024 first (256 MiB, 1 GiB) so byte ticks
 * read naturally.
 */
export function niceScale(max: number, target = 4, binary = false): Scale {
  const top = max > 0 && Number.isFinite(max) ? max : 1;
  const unit = binary ? 1024 ** Math.max(0, Math.floor(Math.log2(top) / 10)) : 1;
  const step = niceStep(top / unit / target) * unit;
  const end = Math.ceil(top / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= end + step / 2; v += step) ticks.push(v);
  return { max: end, ticks };
}

/** Split where consecutive samples are further apart than `maxGapMs` (paused sampling). */
export function segments(points: readonly SeriesPoint[], maxGapMs: number): SeriesPoint[][] {
  const out: SeriesPoint[][] = [];
  let current: SeriesPoint[] = [];
  for (const p of points) {
    const last = current[current.length - 1];
    if (last && p.t - last.t > maxGapMs) {
      out.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length) out.push(current);
  return out;
}

/** Points inside `[from, to]` plus one neighbour on each side so lines reach the edges. */
export function clip(points: readonly SeriesPoint[], from: number, to: number): SeriesPoint[] {
  let start = 0;
  while (start < points.length && points[start]!.t < from) start++;
  let end = points.length;
  while (end > start && points[end - 1]!.t > to) end--;
  return points.slice(Math.max(0, start - 1), Math.min(points.length, end + 1));
}

/** Index of the point closest to `t` (points sorted by time), or -1. */
export function nearest(points: readonly SeriesPoint[], t: number): number {
  if (!points.length) return -1;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(points[lo - 1]!.t - t) <= Math.abs(points[lo]!.t - t)) return lo - 1;
  return lo;
}

type XY = [number, number];

/** SVG path through `pts` (pixel coords) using Fritsch–Carlson monotone cubic segments. */
export function monotonePath(pts: readonly XY[]): string {
  const n = pts.length;
  if (!n) return '';
  const f = (v: number) => Math.round(v * 100) / 100;
  if (n === 1) return `M${f(pts[0]![0])},${f(pts[0]![1])}`;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const w = pts[i + 1]![0] - pts[i]![0];
    dx.push(w);
    slope.push(w === 0 ? 0 : (pts[i + 1]![1] - pts[i]![1]) / w);
  }
  const tangent: number[] = [slope[0]!];
  for (let i = 1; i < n - 1; i++) {
    const a = slope[i - 1]!;
    const b = slope[i]!;
    if (a * b <= 0) tangent.push(0);
    else {
      const wa = 2 * dx[i]! + dx[i - 1]!;
      const wb = dx[i]! + 2 * dx[i - 1]!;
      tangent.push((wa + wb) / (wa / a + wb / b));
    }
  }
  tangent.push(slope[n - 2]!);
  let d = `M${f(pts[0]![0])},${f(pts[0]![1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    const h = dx[i]! / 3;
    d += `C${f(x0 + h)},${f(y0 + tangent[i]! * h)} ${f(x1 - h)},${f(y1 - tangent[i + 1]! * h)} ${f(x1)},${f(y1)}`;
  }
  return d;
}

/** Closed area under `monotonePath(pts)` down to `baseline`. */
export function areaPath(pts: readonly XY[], baseline: number): string {
  if (pts.length < 2) return '';
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  return `${monotonePath(pts)}L${last[0]},${baseline}L${first[0]},${baseline}Z`;
}

/**
 * Time ticks every `stepMs`, aligned to wall-clock multiples, inside
 * `[from, to]`. `offsetMs` shifts the alignment to local time (hour and day
 * steps land on local midnight, see `localOffset`).
 */
export function timeTicks(from: number, to: number, stepMs: number, offsetMs = 0): number[] {
  const out: number[] = [];
  const first = Math.ceil((from + offsetMs) / stepMs) * stepMs - offsetMs;
  for (let t = first; t <= to; t += stepMs) out.push(t);
  return out;
}

/** Local time minus UTC at `t`, in ms (for `timeTicks`). */
export function localOffset(t: number): number {
  return -new Date(t).getTimezoneOffset() * 60_000;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Tick spacing for a visible range (15 minutes up to several days). */
export function timeStep(rangeMs: number): number {
  const minutes = rangeMs / MINUTE;
  if (minutes <= 60) return (minutes <= 15 ? 5 : minutes <= 30 ? 10 : 15) * MINUTE;
  const hours = rangeMs / HOUR;
  if (hours <= 3) return 30 * MINUTE;
  if (hours <= 6) return HOUR;
  if (hours <= 12) return 2 * HOUR;
  if (hours <= 24) return 4 * HOUR;
  if (hours <= 72) return 12 * HOUR;
  if (hours <= 7 * 24) return DAY;
  return hours <= 14 * 24 ? 2 * DAY : 7 * DAY;
}

/** Axis label format: clock times, dates once ticks are a day apart. */
export function tickFormat(stepMs: number): Intl.DateTimeFormatOptions {
  return stepMs >= DAY
    ? { month: 'short', day: 'numeric' }
    : { hour: '2-digit', minute: '2-digit' };
}

/** Tooltip time format: with the date once the range spans more than a day. */
export function tooltipFormat(rangeMs: number): Intl.DateTimeFormatOptions {
  return rangeMs > DAY
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit', second: '2-digit' };
}

/**
 * Axis from `min` to `max` with about `target` intervals, for series that
 * can go negative (PromQL `deriv`, deltas). Non-negative data starts at 0.
 */
export function niceRange(min: number, max: number, target = 4): Scale & { min: number } {
  if (!(min < 0)) return { ...niceScale(max, target), min: 0 };
  const lo = Number.isFinite(min) ? min : -1;
  const hi = Number.isFinite(max) && max > lo ? max : lo + 1;
  const step = niceStep((hi - lo) / target);
  const start = Math.floor(lo / step - 1e-9) * step;
  const end = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : v);
  return { min: start, max: end, ticks };
}

export function lastValue(points: readonly SeriesPoint[]): number | null {
  return points.length ? points[points.length - 1]!.v : null;
}

export function peak(points: readonly SeriesPoint[]): number {
  let max = 0;
  for (const p of points) if (p.v > max) max = p.v;
  return max;
}
