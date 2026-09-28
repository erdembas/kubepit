import { useCallback, useSyncExternalStore } from 'react';
import { ipc } from '@/lib/ipc';
import { kindKey } from '@/lib/kube/catalog';
import type { ClusterId, Gvk, KubeObject, WatchBatch } from '@/types';
import { applyBatch, batchPatch, isForbidden } from './watchBatch';

/**
 * Shared, ref-counted resource watches. Every table, mini-table and overview
 * tile that needs the same (cluster, kind, namespaces) triple subscribes to
 * one backend watch. Items live in a Map keyed by uid; subscribers receive
 * an immutable snapshot rebuilt at most once per animation frame, so a busy
 * namespace never re-renders the UI per event.
 *
 * The last snapshot is kept after the watch stops (hidden tab, disconnected
 * view) so returning to a view paints instantly while the new watch resyncs.
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

class WatchEntry {
  private map = new Map<string, KubeObject>();
  private listeners = new Set<() => void>();
  private generation = 0;
  private watchId: string | null = null;
  private frame: number | null = null;
  private version = 0;
  snapshot: WatchSnapshot = EMPTY;

  constructor(
    readonly clusterId: ClusterId,
    readonly gvk: Gvk,
    readonly namespaces: string[],
  ) {}

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  restart() {
    this.stop();
    if (this.listeners.size) this.start();
  }

  private start() {
    const generation = ++this.generation;
    this.update({ status: 'loading', error: null, forbidden: false, synced: false });
    ipc
      .resourceWatch(this.clusterId, this.gvk, this.namespaces, (batch) => {
        if (generation === this.generation) this.apply(batch);
      })
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
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    const id = this.watchId;
    this.watchId = null;
    if (id) void ipc.resourceUnwatch(id).catch(() => undefined);
    if (this.snapshot.status === 'loading')
      this.update({ status: this.snapshot.synced ? 'ready' : 'idle' });
  }

  private apply(batch: WatchBatch) {
    applyBatch(this.map, batch);
    this.version++;
    const synced = this.snapshot.synced || batch.synced;
    // Errors and the first sync (or the recovery from an error) paint at once.
    if (batch.error || (synced && this.snapshot.status !== 'ready'))
      this.flush(batchPatch(this.snapshot, batch, this.map.size));
    else this.schedule();
  }

  private schedule() {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.flush({});
    });
  }

  private flush(patch: Partial<WatchSnapshot>) {
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
