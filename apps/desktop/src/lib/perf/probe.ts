import type { FpsReport } from './stats';

/**
 * Dev-only performance probe (`?perf=1`, or `localStorage['kubepit.perf'] =
 * '1'`). The app calls the helpers below at a few hot spots (tables, watch
 * flushes, the Resource Map, the health scan, view switches); the
 * Playwright driver (`scripts/perf/ui-perf.mjs`) and developers read the
 * results through `window.__kubepitPerf` (`./driver.ts`).
 *
 * Disabled, every helper returns after one cached boolean check: no marks,
 * no observers, no global, no allocation. Call sites pass primitives only,
 * or guard richer arguments with `perfEnabled()`.
 */

let enabled: boolean | null = null;

function detect(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location?.search ?? '').get('perf') === '1') return true;
  } catch {
    // No location: fall through to the stored switch.
  }
  try {
    return window.localStorage?.getItem('kubepit.perf') === '1';
  } catch {
    return false;
  }
}

/** Whether the probe is on; evaluated once per page. */
export function perfEnabled(): boolean {
  if (enabled === null) enabled = detect();
  return enabled;
}

/** Samples kept per id; the oldest half is dropped beyond it (long soaks). */
const MAX_SAMPLES = 10_000;

type Meta = Record<string, number>;

let durations: Record<string, number[]> = {};
let details: Record<string, Array<Meta | null>> = {};
let marks: Record<string, number> = {};
let waiters: Array<{ id: string; resolve: (ms: number) => void }> = [];

/** `performance.now()` while enabled, else 0 (pair it with {@link recordSince}). */
export function perfNow(): number {
  return perfEnabled() ? performance.now() : 0;
}

export function perfMark(name: string): void {
  if (!perfEnabled()) return;
  marks[name] = performance.now();
  try {
    performance.mark(name);
  } catch {
    // The timeline mark is a convenience for DevTools only.
  }
}

export function recordDuration(id: string, ms: number, meta?: Meta): void {
  if (!perfEnabled()) return;
  const values = (durations[id] ??= []);
  const extra = (details[id] ??= []);
  values.push(ms);
  extra.push(meta ?? null);
  if (values.length > MAX_SAMPLES) {
    values.splice(0, MAX_SAMPLES / 2);
    extra.splice(0, MAX_SAMPLES / 2);
  }
  if (!waiters.length) return;
  const ready = waiters.filter((w) => w.id === id);
  if (!ready.length) return;
  waiters = waiters.filter((w) => w.id !== id);
  for (const w of ready) w.resolve(ms);
}

/** Records the time since `start` (from {@link perfNow}) under `id`. */
export function recordSince(id: string, start: number): void {
  if (!perfEnabled()) return;
  recordDuration(id, performance.now() - start);
}

/** Records the time since the mark `mark` under `id`; `null` without that mark. */
export function measureSince(mark: string, id: string): number | null {
  if (!perfEnabled()) return null;
  const start = marks[mark];
  if (start === undefined) return null;
  const ms = performance.now() - start;
  recordDuration(id, ms);
  return ms;
}

export interface PerfReport {
  durations: Record<string, number[]>;
  marks: Record<string, number>;
  /** The `meta` of each duration (same order), `null` where none was given. */
  details: Record<string, Array<Meta | null>>;
}

export function perfReport(): PerfReport {
  const copy = <T>(o: Record<string, T[]>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [...v]]));
  return { durations: copy(durations), marks: { ...marks }, details: copy(details) };
}

/** One id's samples, not copied (the driver polls them). */
export function perfSamples(id: string): {
  values: readonly number[];
  details: ReadonlyArray<Meta | null>;
} {
  return { values: durations[id] ?? [], details: details[id] ?? [] };
}

export function resetPerf(): void {
  durations = {};
  details = {};
  marks = {};
  table = null;
  pendingSwitch = null;
}

/** Resolves with the next duration recorded under `id`, or `null` after `timeoutMs`. */
export function nextRecord(id: string, timeoutMs = 30_000): Promise<number | null> {
  if (!perfEnabled()) return Promise.resolve(null);
  return new Promise((resolve) => {
    const waiter = { id, resolve: (ms: number | null) => resolve(ms) };
    waiters.push(waiter);
    setTimeout(() => {
      if (!waiters.includes(waiter)) return;
      waiters = waiters.filter((w) => w !== waiter);
      resolve(null);
    }, timeoutMs);
  });
}

/** `performance.now()` after `n` animation frames: the frame after the next paint for 2. */
export function afterFrames(n = 2): Promise<number> {
  return new Promise((resolve) => {
    const step = (left: number) =>
      left <= 0 ? resolve(performance.now()) : requestAnimationFrame(() => step(left - 1));
    step(n);
  });
}

// ---------------------------------------------------------------------------
// Watch batches: apply → commit
// ---------------------------------------------------------------------------

export interface WatchCommitTiming {
  /** When the first batch since the last flush arrived. */
  arrivedAt: number;
  /** Time spent applying those batches to the watch's map. */
  applyMs: number;
  /** When the flush began (building the snapshot, then emitting it). */
  flushStart: number;
  /** Objects in the snapshot. */
  items: number;
}

/**
 * Called right after a watch emits a snapshot: records `watch:apply` once
 * React has committed it. `useSyncExternalStore` re-renders at sync
 * priority in a microtask that the emit queued, so a microtask queued after
 * the emit runs after that render and commit.
 *
 * The value is the work: applying the batches plus flush start → commit.
 * The wait for the animation frame is left out; `latencyMs` (first batch →
 * commit) keeps it.
 */
export function recordWatchCommit(t: WatchCommitTiming): void {
  if (!perfEnabled()) return;
  const emitted = performance.now();
  queueMicrotask(() => {
    const end = performance.now();
    recordDuration('watch:apply', t.applyMs + (end - t.flushStart), {
      items: t.items,
      applyMs: t.applyMs,
      flushMs: emitted - t.flushStart,
      commitMs: end - emitted,
      latencyMs: end - t.arrivedAt,
    });
  });
}

// ---------------------------------------------------------------------------
// Tables: time to first rows and to synced
// ---------------------------------------------------------------------------

let table: { kind: string; rows: boolean; synced: boolean } | null = null;

/** A kind's table is being opened: `table:ttfr` and `table:synced` count from now. */
export function perfTableNavigate(kindKey: string): void {
  if (!perfEnabled()) return;
  perfMark('table:navigate');
  table = { kind: kindKey, rows: false, synced: false };
}

/**
 * Called while a table renders: the first render with rows records
 * `table:ttfr`, the first synced one `table:synced`, both once per
 * navigation and right after React commits that render.
 */
export function perfTableRendered(kindKey: string, rows: number, synced: boolean): void {
  if (!perfEnabled() || !table || table.kind !== kindKey) return;
  if (rows > 0 && !table.rows) {
    table.rows = true;
    queueMicrotask(() => measureSince('table:navigate', 'table:ttfr'));
  }
  if (synced && !table.synced) {
    table.synced = true;
    queueMicrotask(() => measureSince('table:navigate', 'table:synced'));
  }
}

// ---------------------------------------------------------------------------
// View switches
// ---------------------------------------------------------------------------

const shownViews = new Map<string, string | null>();
let pendingSwitch: number | null = null;

/** The driver is about to switch views: `view:switch` counts from now. */
export function perfViewSwitchStart(): void {
  if (!perfEnabled()) return;
  pendingSwitch = performance.now();
}

/**
 * Called while a pane renders: a changed active tab records `view:switch`,
 * from the driver's start (else this render) to two animation frames later.
 */
export function perfViewShown(pane: string, view: string | null): void {
  if (!perfEnabled()) return;
  const known = shownViews.has(pane);
  const last = shownViews.get(pane);
  shownViews.set(pane, view);
  if (!known || last === view) return;
  const start = pendingSwitch ?? performance.now();
  pendingSwitch = null;
  void afterFrames(2).then((end) => recordDuration('view:switch', end - start));
}

// ---------------------------------------------------------------------------
// The driver global
// ---------------------------------------------------------------------------

export interface WatchCacheStat {
  key: string;
  listeners: number;
  items: number;
}

export interface MockWatchStat {
  clusterId: string;
  key: string;
  namespaces: string[];
}

/** `window.__kubepitPerf`: what scripts and DevTools drive the app with. */
export interface PerfDriver {
  /** Opens the cluster and connects; resolves (ms) once connected with discovery loaded. */
  connect(clusterId: string): Promise<number>;
  /** Opens a kind's table (`table:ttfr` / `table:synced` count from here). */
  openKind(clusterId: string, kindKey: string, namespaces?: string[]): void;
  /** Opens a view (`@resource-map`, `@health`…), optionally scoped first. */
  openView(clusterId: string, viewKey: string, namespaces?: string[]): void;
  /** Switches the last cluster's focused pane; ms until two frames after the switch. */
  switchView(viewKey: string): Promise<number>;
  /** Scrolls the active table for `ms` at 2 000 px/s and reports its frames. */
  scrollTable(ms: number): Promise<FpsReport & { longTasks: number[]; distancePx: number }>;
  /** Manual frame sampling (while dragging the map by hand). */
  startFps(): void;
  stopFps(): FpsReport;
  /** Long task durations (ms) since the last reset. */
  longTasks(): number[];
  /** Used JS heap in bytes (`performance.memory`), `null` where unavailable. */
  heap(): number | null;
  domNodes(): number;
  watchStats(): WatchCacheStat[];
  mockWatchStats(): Promise<MockWatchStat[]>;
  report(): PerfReport;
  reset(): void;
  now(): number;
  /** Resolves with `performance.now()` after `n` animation frames. */
  afterFrames(n?: number): Promise<number>;
  /**
   * Resolves with the `count`-th duration of `id` since the last reset (and,
   * with `meta`, one whose meta matches), or `null` after `timeoutMs`.
   */
  waitFor(
    id: string,
    options?: { count?: number; meta?: Meta; timeoutMs?: number },
  ): Promise<number | null>;
}

declare global {
  interface Window {
    __kubepitPerf?: PerfDriver;
  }
}
