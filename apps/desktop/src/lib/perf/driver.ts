import { watchCacheStats } from '@/components/workbench/data/watchCache';
import { openAndConnect } from '@/lib/clusterActions';
import { isTauri } from '@/lib/ipc/invoke';
import { useAppStore } from '@/store/useAppStore';
import { VIEW, useWorkbenchStore } from '@/store/useWorkbenchStore';
import {
  afterFrames,
  nextRecord,
  perfEnabled,
  perfMark,
  perfReport,
  perfSamples,
  perfTableNavigate,
  perfViewSwitchStart,
  resetPerf,
  type PerfDriver,
} from './probe';
import { installPerfGlobal } from './global';
import { fpsReport, type FpsReport } from './stats';

/**
 * `window.__kubepitPerf` (loaded by `main.tsx` only while the probe is on).
 * It drives the stores the way the UI does and reads the probe back; the
 * Playwright driver (`scripts/perf/ui-perf.mjs`) calls nothing else.
 */

/** Programmatic table scroll speed. */
const SCROLL_PX_PER_S = 2000;

function until(what: string, ready: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    // Timers, not animation frames: they keep running in a hidden window.
    const poll = () => {
      if (ready()) resolve();
      else if (performance.now() > deadline)
        reject(new Error(`perf: timed out waiting for ${what}`));
      else setTimeout(poll, 20);
    };
    poll();
  });
}

function isScrollable(el: HTMLElement) {
  const overflow = getComputedStyle(el).overflowY;
  return (overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight;
}

/** The scroll container of the visible resource table (`[role="rowgroup"]`'s scroll parent). */
function activeTableScroller(): HTMLElement | null {
  for (const group of document.querySelectorAll<HTMLElement>('[role="rowgroup"]')) {
    if (!group.offsetParent) continue;
    for (let el = group.parentElement; el; el = el.parentElement) if (isScrollable(el)) return el;
  }
  return null;
}

interface LongTask {
  start: number;
  duration: number;
}

/** Creates the driver and exposes it (no-op while the probe is off). */
export function installPerfDriver(): void {
  if (perfEnabled()) installPerfGlobal(createPerfDriver());
}

export function createPerfDriver(): PerfDriver {
  let current: string | null = null;
  let since = 0;
  const longTasks: LongTask[] = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        longTasks.push({ start: e.startTime, duration: e.duration });
      if (longTasks.length > 10_000) longTasks.splice(0, 5_000);
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    // No Long Tasks API (WebKit): long tasks stay empty.
  }
  const longTasksSince = (start: number) =>
    longTasks.filter((t) => t.start >= start).map((t) => t.duration);

  let fps: { frames: number[]; last: number | null; stop: boolean } | null = null;

  const cluster = () => {
    if (!current) throw new Error('perf: connect or open a cluster first');
    return current;
  };
  const workbench = useWorkbenchStore.getState;

  return {
    async connect(clusterId) {
      const start = performance.now();
      current = clusterId;
      // Land on a view without watches: the overview's health card would warm
      // the pods cache and hide the cold time to first rows.
      workbench().setActiveKind(clusterId, VIEW.portForwards);
      openAndConnect(clusterId);
      await until(
        `${clusterId} to connect`,
        () =>
          useAppStore.getState().statuses[clusterId]?.state === 'connected' &&
          !!workbench().apiResources[clusterId],
        60_000,
      );
      return performance.now() - start;
    },

    openKind(clusterId, kindKey, namespaces) {
      current = clusterId;
      if (namespaces) workbench().setNamespaces(clusterId, namespaces);
      perfTableNavigate(kindKey);
      workbench().setActiveKind(clusterId, kindKey);
    },

    openView(clusterId, viewKey, namespaces) {
      current = clusterId;
      if (namespaces) workbench().setNamespaces(clusterId, namespaces);
      perfMark('view:open');
      workbench().setActiveKind(clusterId, viewKey);
    },

    async switchView(viewKey) {
      const clusterId = cluster();
      const start = performance.now();
      const layout = workbench().layouts[clusterId];
      const pane = layout?.groups.find((g) => g.id === layout.focused);
      if (pane?.active === viewKey) return (await afterFrames(2)) - start;
      perfViewSwitchStart();
      const recorded = nextRecord('view:switch', 30_000);
      workbench().setActiveKind(clusterId, viewKey);
      return (await recorded) ?? (await afterFrames(2)) - start;
    },

    scrollTable(ms) {
      const el = activeTableScroller();
      if (!el) return Promise.reject(new Error('perf: no visible table to scroll'));
      return new Promise((resolve) => {
        const frames: number[] = [];
        let position = el.scrollTop;
        let direction = 1;
        let distancePx = 0;
        let end = 0;
        let last = 0;
        let begin = 0;
        const step = (t: number) => {
          const dt = t - last;
          last = t;
          frames.push(dt);
          // Down to the end, then back up.
          const max = el.scrollHeight - el.clientHeight;
          let next = position + (direction * SCROLL_PX_PER_S * dt) / 1000;
          if (next >= max) [next, direction] = [max, -1];
          else if (next <= 0) [next, direction] = [0, 1];
          distancePx += Math.abs(next - position);
          position = next;
          el.scrollTop = next;
          if (t < end) requestAnimationFrame(step);
          else resolve({ ...fpsReport(frames), longTasks: longTasksSince(begin), distancePx });
        };
        requestAnimationFrame((t) => {
          begin = performance.now();
          last = t;
          end = t + ms;
          requestAnimationFrame(step);
        });
      });
    },

    startFps() {
      const state = { frames: [] as number[], last: null as number | null, stop: false };
      fps = state;
      const step = (t: number) => {
        if (state.stop) return;
        if (state.last !== null) state.frames.push(t - state.last);
        state.last = t;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },

    stopFps(): FpsReport {
      const state = fps;
      fps = null;
      if (!state) return fpsReport([]);
      state.stop = true;
      return fpsReport(state.frames);
    },

    longTasks: () => longTasksSince(since),

    heap() {
      const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
      return memory ? memory.usedJSHeapSize : null;
    },

    domNodes: () => document.getElementsByTagName('*').length,

    watchStats: () => watchCacheStats(),

    async mockWatchStats() {
      if (isTauri) return [];
      return (await import('@/lib/ipc/mock/fixtures/db')).mockWatchStats();
    },

    report: () => perfReport(),

    reset() {
      resetPerf();
      since = performance.now();
    },

    now: () => performance.now(),

    afterFrames: (n) => afterFrames(n),

    waitFor(id, { count = 1, meta, timeoutMs = 30_000 } = {}) {
      const matches = () => {
        const { values, details } = perfSamples(id);
        let seen = 0;
        for (let i = 0; i < values.length; i++) {
          const extra = details[i];
          if (meta && !Object.entries(meta).every(([k, v]) => extra?.[k] === v)) continue;
          if (++seen === count) return values[i]!;
        }
        return null;
      };
      return until(`${id}`, () => matches() !== null, timeoutMs).then(
        () => matches(),
        () => null,
      );
    },
  };
}
