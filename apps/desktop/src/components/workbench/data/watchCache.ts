import { useCallback, useSyncExternalStore } from 'react';
import { ipc } from '@/lib/ipc';
import { kindKey } from '@/lib/kube/catalog';
import { perfNow, recordWatchCommit } from '@/lib/perf/probe';
import type { ClusterId, Gvk, KubeObject, WatchBatch } from '@/types';
import {
  applyBatch,
  ApplyRetry,
  batchFlush,
  isForbidden,
  routeBatch,
  type BatchRoute,
} from './watchBatch';

/**
 * Shared, ref-counted resource watches. Every table, mini-table and overview
 * tile that needs the same (cluster, kind, namespaces) triple subscribes to
 * one backend watch. Items live in a Map keyed by uid; subscribers receive
 * an immutable snapshot rebuilt at most once per animation frame, so a busy
 * namespace never re-renders the UI per event.
 *
 * The last snapshot is kept after the watch stops (hidden tab, disconnected
 * view) so returning to a view paints instantly while the new watch resyncs.
 * Hidden tabs hold no backend watch, so the backend's flow control (every
 * batch is acknowledged once applied, see `routeBatch`) only concerns live
 * views.
 *
 * A batch that reports an error still carries its objects (`watchBatch.ts`):
 * the list only turns `error` when nothing is left; otherwise the rows stay
 * and `error` / `forbidden` feed a notice (one forbidden namespace of many).
 */

export type WatchStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface WatchSnapshot {
  items: readonly KubeObject[];
  byUid: ReadonlyMap<string, KubeObject>;
  status: WatchStatus;
  error: string | null;
  forbidden: boolean;
  synced: boolean;
  /** Increments on every applied batch. */
  version: number;
}

const EMPTY: WatchSnapshot = {
  items: [],
  byUid: new Map(),
  status: 'idle',
  error: null,
  forbidden: false,
  synced: false,
  version: 0,
};

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Tells the backend a batch is applied (an ended watch ignores it). */
function acknowledge(batch: WatchBatch) {
  void ipc.resourceWatchAck(batch.watch_id, batch.seq).catch(() => undefined);
}

class WatchEntry {
  private map = new Map<string, KubeObject>();
  private listeners = new Set<() => void>();
  private generation = 0;
  private watchId: string | null = null;
  private frame: number | null = null;
  private version = 0;
  /** Perf probe: when the first batch since the last flush arrived (0 while off). */
  private applyStart = 0;
  /** Perf probe: time spent applying the batches since the last flush. */
  private applyMs = 0;
  /** Restarts after failed applies, with backoff, then gives up. */
  private readonly retry = new ApplyRetry(
    () => this.relaunch(),
    (message) => this.update({ status: 'error', error: message, forbidden: false }),
  );
  snapshot: WatchSnapshot = EMPTY;

  constructor(
    readonly clusterId: ClusterId,
    readonly gvk: Gvk,
    readonly namespaces: string[],
  ) {}

  get listenerCount() {
    return this.listeners.size;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  /** Retry button, header refresh: start over, failed applies forgotten. */
  restart() {
    this.retry.reset();
    this.relaunch();
  }

  private relaunch() {
    this.stop();
    if (this.listeners.size) this.start();
  }

  private start() {
    const generation = ++this.generation;
    this.update({ status: 'loading', error: null, forbidden: false, synced: false });
    const route: BatchRoute = {
      apply: (batch) => {
        this.apply(batch);
        this.retry.succeeded();
      },
      ack: acknowledge,
      restart: () => this.relaunch(),
      // Stop at once (later batches would land on half-applied rows), then
      // restart after a backoff, or give up.
      failed: (error) => {
        this.stop();
        this.retry.failed(error);
      },
    };
    ipc
      .resourceWatch(this.clusterId, this.gvk, this.namespaces, (batch) =>
        routeBatch(batch, generation === this.generation, route),
      )
      .then((id) => {
        if (generation === this.generation) this.watchId = id;
        else void ipc.resourceUnwatch(id).catch(() => undefined);
      })
      .catch((error: unknown) => {
        if (generation !== this.generation) return;
        const message = errorText(error);
        this.update({ status: 'error', error: message, forbidden: isForbidden(message) });
      });
  }

  private stop() {
    this.generation++;
    this.retry.cancel();
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.applyStart = this.applyMs = 0;
    const id = this.watchId;
    this.watchId = null;
    if (id) void ipc.resourceUnwatch(id).catch(() => undefined);
    if (this.snapshot.status === 'loading')
      this.update({ status: this.snapshot.synced ? 'ready' : 'idle' });
  }

  private apply(batch: WatchBatch) {
    const start = perfNow();
    if (!this.applyStart) this.applyStart = start;
    // Error-only batches (a forbidden watch retrying) change no rows: no new
    // version, so consumers keyed on it (the health scan) do not recompute.
    const changed = applyBatch(this.map, batch);
    if (changed) this.version++;
    const patch = batchFlush(this.snapshot, batch, this.map.size);
    if (start) this.applyMs += performance.now() - start;
    if (patch) this.flush(patch);
    else if (changed) this.schedule();
  }

  private schedule() {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.flush({});
    });
  }

  private flush(patch: Partial<WatchSnapshot>) {
    const flushStart = this.applyStart && performance.now();
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    const byUid = new Map(this.map);
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      items: [...byUid.values()],
      byUid,
      version: this.version,
    };
    this.emit();
    if (this.applyStart) {
      const { applyStart: arrivedAt, applyMs } = this;
      recordWatchCommit({ arrivedAt, applyMs, flushStart, items: this.map.size });
      this.applyStart = this.applyMs = 0;
    }
  }

  private update(patch: Partial<WatchSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}

const entries = new Map<string, WatchEntry>();

export function watchKey(clusterId: ClusterId, gvk: Gvk, namespaces: readonly string[]) {
  const ns = gvk.namespaced ? [...namespaces].sort().join(',') : '';
  return `${clusterId}|${kindKey(gvk)}|${gvk.version}|${ns}`;
}

function entryFor(clusterId: ClusterId, gvk: Gvk, namespaces: readonly string[]) {
  const key = watchKey(clusterId, gvk, namespaces);
  let entry = entries.get(key);
  if (!entry) {
    entry = new WatchEntry(clusterId, gvk, gvk.namespaced ? [...namespaces].sort() : []);
    entries.set(key, entry);
  }
  return entry;
}

/** Every cached watch (perf probe): key, subscribers and items. */
export function watchCacheStats() {
  return [...entries].map(([key, entry]) => ({
    key,
    listeners: entry.listenerCount,
    items: entry.snapshot.items.length,
  }));
}

/** Restart every watch of a kind (retry button). */
export function restartWatch(clusterId: ClusterId, gvk: Gvk, namespaces: readonly string[]) {
  entries.get(watchKey(clusterId, gvk, namespaces))?.restart();
}

/** Drop cached snapshots of a disconnected cluster. */
export function dropClusterWatches(clusterId: ClusterId) {
  for (const [key, entry] of entries) if (entry.clusterId === clusterId) entries.delete(key);
}

/**
 * Subscribe to a live list. `enabled = false` (hidden tab, inactive view)
 * keeps returning the last snapshot without holding a backend watch.
 */
export function useWatch(
  clusterId: ClusterId,
  gvk: Gvk | null,
  namespaces: readonly string[],
  enabled: boolean,
): WatchSnapshot {
  const key = gvk ? watchKey(clusterId, gvk, namespaces) : null;
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!gvk || !enabled) return () => {};
      return entryFor(clusterId, gvk, namespaces).subscribe(onChange);
    },
    // `key` captures gvk + namespaces by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, enabled],
  );
  const getSnapshot = () => (key ? (entries.get(key)?.snapshot ?? EMPTY) : EMPTY);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Restart every live watch of a cluster (header refresh). */
export function restartClusterWatches(clusterId: ClusterId) {
  for (const entry of entries.values()) if (entry.clusterId === clusterId) entry.restart();
}
