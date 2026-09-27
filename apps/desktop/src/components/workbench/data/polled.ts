import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * Shared request/poll cache for non-watch data (metrics, discovery, events
 * of one object, helm releases). Subscribers with the same key share one
 * in-flight request and one interval; polling stops when the last visible
 * subscriber leaves. Results stay cached for instant re-display.
 */

export interface PolledState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  /** Epoch ms of the last successful fetch. */
  updatedAt: number;
}

interface Entry<T> {
  state: PolledState<T>;
  listeners: Set<() => void>;
  fetcher: () => Promise<T>;
  interval: number | null;
  timer: number | null;
  inflight: Promise<void> | null;
}

const EMPTY: PolledState<never> = { data: undefined, error: null, loading: false, updatedAt: 0 };
const cache = new Map<string, Entry<unknown>>();

function emit(entry: Entry<unknown>) {
  for (const l of entry.listeners) l();
}

function run(key: string): Promise<void> {
  const entry = cache.get(key);
  if (!entry) return Promise.resolve();
  if (entry.inflight) return entry.inflight;
  entry.state = { ...entry.state, loading: true };
  emit(entry);
  entry.inflight = entry
    .fetcher()
    .then((data) => {
      entry.state = { data, error: null, loading: false, updatedAt: Date.now() };
    })
    .catch((error: unknown) => {
      entry.state = {
        ...entry.state,
        error: error instanceof Error ? error.message : String(error),
        loading: false,
      };
    })
    .finally(() => {
      entry.inflight = null;
      emit(entry);
    });
  return entry.inflight;
}

function schedule(key: string) {
  const entry = cache.get(key);
  if (!entry || entry.interval === null || entry.timer !== null || !entry.listeners.size) return;
  entry.timer = window.setInterval(() => void run(key), entry.interval);
}

function unschedule(entry: Entry<unknown>) {
  if (entry.timer !== null) window.clearInterval(entry.timer);
  entry.timer = null;
}

/** Force a refetch for every subscriber of `key` (after a mutation). */
export function refreshPolled(key: string) {
  if (cache.has(key)) void run(key);
}

/** Refetch every cached key starting with `prefix`. */
export function refreshPolledPrefix(prefix: string) {
  for (const key of cache.keys()) if (key.startsWith(prefix)) void run(key);
}

export function dropPolledPrefix(prefix: string) {
  for (const [key, entry] of cache) {
    if (!key.startsWith(prefix)) continue;
    unschedule(entry);
    cache.delete(key);
  }
}

/**
 * `key = null` disables the request. `interval = null` fetches once per
 * mount (and on `refresh`). `enabled = false` pauses polling but keeps the
 * cached value visible.
 */
export function usePolled<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  interval: number | null,
  enabled = true,
): PolledState<T> & { refresh: () => Promise<void> } {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!key || !enabled) return () => {};
      let entry = cache.get(key);
      if (!entry) {
        entry = {
          state: EMPTY,
          listeners: new Set(),
          fetcher: () => fetcherRef.current(),
          interval,
          timer: null,
          inflight: null,
        };
        cache.set(key, entry);
      }
      entry.fetcher = () => fetcherRef.current() as Promise<unknown>;
      entry.interval = interval;
      entry.listeners.add(onChange);
      const stale =
        !entry.state.updatedAt ||
        (interval !== null && Date.now() - entry.state.updatedAt > interval);
      if (stale) void run(key);
      schedule(key);
      const current = entry;
      return () => {
        current.listeners.delete(onChange);
        if (!current.listeners.size) unschedule(current);
      };
    },
    [key, enabled, interval],
  );

  const getSnapshot = () => ((key ? cache.get(key)?.state : undefined) ?? EMPTY) as PolledState<T>;
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const refresh = useCallback(() => (key ? run(key) : Promise.resolve()), [key]);
  return { ...state, refresh };
}

/** Run `fn` every `ms` while `enabled` (for clocks such as the Age column). */
export function useInterval(fn: () => void, ms: number, enabled: boolean) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => ref.current(), ms);
    return () => window.clearInterval(id);
  }, [ms, enabled]);
}
