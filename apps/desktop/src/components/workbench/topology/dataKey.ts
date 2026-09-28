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
