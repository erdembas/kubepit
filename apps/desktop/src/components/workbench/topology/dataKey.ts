import type { WatchSnapshot } from '../data/watchCache';

/**
 * Rebuild key of the topology inputs: what the graph actually reads from each
 * slot's snapshot. `status` is left out on purpose: leaving a view stops
 * every watch (`loading` → `idle`/`ready`) without changing any data, and that
 * must not rebuild the graph. A failure is still caught through `error`.
 */
export function topologyDataKey(
  snaps: ReadonlyArray<
    Pick<WatchSnapshot, 'version' | 'synced' | 'forbidden'> & { error?: string | null }
  >,
): string {
  return snaps
    .map((s) => `${s.version}:${s.synced ? 1 : 0}:${s.forbidden ? 1 : 0}:${s.error ?? ''}`)
    .join(',');
}

/** A memoised value and the dependencies it was computed from. */
export interface PausedMemo<T> {
  deps: readonly unknown[];
  value: T;
}

/**
 * `useMemo` that can be paused: while `active` is false the previous value is
 * kept whatever the dependencies do, and it is recomputed on resume only if
 * they changed meanwhile. The first value is always computed.
 */
export function pausedMemo<T>(
  prev: PausedMemo<T> | null,
  deps: readonly unknown[],
  active: boolean,
  compute: () => T,
): PausedMemo<T> {
  if (prev && (!active || sameDeps(prev.deps, deps))) return prev;
  return { deps, value: compute() };
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]) {
  return a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
}

/** Minimum time between graph rebuilds while a map's watches still sync. */
export const SYNC_REBUILD_INTERVAL_MS = 250;

/**
 * {@link pausedMemo} that coalesces rebuilds during the initial sync. Every
 * batch a watch delivers changes the data, so a map of many kinds would
 * otherwise rebuild its graph once per batch (70+ times at 10 000 pods).
 *
 * While `syncing`, a change of the data alone rebuilds at most once every
 * `interval` ms: the previous value is returned meanwhile, and `onDue` is
 * called once the next rebuild may run (the hook re-renders then). The
 * first value, a change of the structure (scope, sources, the extra object),
 * the change that completes the sync and every change after it rebuild at
 * once. While inactive the previous value is kept and nothing is scheduled.
 */
export class CoalescedMemo<T> {
  private memo: PausedMemo<T> | null = null;
  private structure: readonly unknown[] = [];
  private last = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onDue: () => void,
    private readonly interval = SYNC_REBUILD_INTERVAL_MS,
    private readonly now: () => number = () => performance.now(),
  ) {}

  get(
    structure: readonly unknown[],
    data: readonly unknown[],
    active: boolean,
    syncing: boolean,
    compute: () => T,
  ): T {
    const prev = this.memo;
    const deps = [...structure, ...data];
    if (prev && (!active || sameDeps(prev.deps, deps))) {
      if (!active) this.cancel();
      return prev.value;
    }
    if (prev && syncing && sameDeps(this.structure, structure)) {
      const wait = this.last + this.interval - this.now();
      if (wait > 0) {
        // Rounded up: timers may fire up to a fraction of a millisecond early.
        this.timer ??= setTimeout(() => {
          this.timer = null;
          this.onDue();
        }, Math.ceil(wait));
        return prev.value;
      }
    }
    this.cancel();
    this.memo = { deps, value: compute() };
    this.structure = structure;
    this.last = this.now();
    return this.memo.value;
  }

  /** Drops a scheduled wake-up (unmount); the value is kept. */
  cancel(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
