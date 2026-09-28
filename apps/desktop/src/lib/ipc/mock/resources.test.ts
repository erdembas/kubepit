import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Gvk, KubeObject, WatchBatch } from '@/types';
import type * as Db from './fixtures/db';
import type { MockHandler } from './registry';

// `resource_watch` of the demo backend follows the backend's flush rule
// (`watch.rs` `run_watch`): a 150 ms ticker from the watch start, and 500
// pending objects flush at once.

const PODS: Gvk = { group: '', version: 'v1', kind: 'Pod', plural: 'pods', namespaced: true };
const JOBS: Gvk = { group: 'batch', version: 'v1', kind: 'Job', plural: 'jobs', namespaced: true };
const EVENTS: Gvk = { group: '', version: 'v1', kind: 'Event', plural: 'events', namespaced: true };
const CLUSTER = 'c-scale-s';

let handlers: Record<string, MockHandler>;
let db: typeof Db;

beforeAll(async () => {
  vi.useFakeTimers({ now: new Date('2026-09-28T10:00:00Z') });
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('location', { search: '', href: 'http://localhost:1430/' });
  // The list "arrives" 20 + random × 120 ms after the watch: at 80 ms.
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  ({ handlers } = await import('./registry'));
  await import('./resources');
  db = await import('./fixtures/db');
  // 1 200 pods: 1 000 generated plus 200 copies.
  const cluster = db.getDb(CLUSTER);
  const template = db.list(cluster, 'pods')[0]!;
  for (let i = 0; i < 200; i++) {
    const copy = structuredClone(template);
    copy.metadata = { ...copy.metadata, name: `extra-${i}`, uid: '' };
    db.put(cluster, copy);
  }
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function watch(gvk: Gvk) {
  const batches: WatchBatch[] = [];
  const id = handlers.resource_watch!({
    clusterId: CLUSTER,
    gvk,
    namespaces: [],
    onEvent: (b: WatchBatch) => batches.push(b),
  }) as string;
  return { id, batches };
}

const shape = (b: WatchBatch) => [b.reset, b.upserts.length + b.deletes.length, b.synced];

function replay(batches: WatchBatch[]) {
  const store = new Map<string, KubeObject>();
  for (const b of batches) {
    if (b.reset) store.clear();
    for (const o of b.upserts) store.set(o.metadata.uid, o);
    for (const uid of b.deletes) store.delete(uid);
  }
  return store;
}

describe('demo resource_watch', () => {
  it('sends full chunks when the list arrives and the rest with synced at the next tick', async () => {
    const { id, batches } = watch(PODS);
    await vi.advanceTimersByTimeAsync(79);
    expect(batches).toHaveLength(0);
    // The list arrives at 80 ms; each further full chunk takes a 0 ms
    // timer, which fake timers run 1 ms later.
    await vi.advanceTimersByTimeAsync(2);
    expect(batches.map(shape)).toEqual([
      [true, 500, false],
      [false, 500, false],
    ]);
    // The remainder goes out at the first tick, 150 ms after the watch.
    await vi.advanceTimersByTimeAsync(68);
    expect(batches).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches.map(shape)).toEqual([
      [true, 500, false],
      [false, 500, false],
      [false, 200, true],
    ]);
    expect(batches.every((b) => b.watch_id === id && b.error === null && !b.recovered)).toBe(true);
    expect(replay(batches).size).toBe(1200);
    handlers.resource_unwatch!({ watchId: id });
  });

  it('sends an empty list as one synced batch at the first tick', async () => {
    const { id, batches } = watch(JOBS);
    await vi.advanceTimersByTimeAsync(149);
    expect(batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches).toEqual([
      {
        watch_id: id,
        reset: true,
        upserts: [],
        deletes: [],
        synced: true,
        error: null,
        recovered: false,
      },
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(batches).toHaveLength(1);
    handlers.resource_unwatch!({ watchId: id });
  });

  it('sends a list of an exact multiple of 500 as full chunks, then an empty synced batch at the next tick', async () => {
    // 2 000 events (the `l` preset's pods and events take the same path).
    const { id, batches } = watch(EVENTS);
    await vi.advanceTimersByTimeAsync(79);
    expect(batches).toHaveLength(0);
    // 80–83 ms: every chunk is full, so none of them is synced.
    await vi.advanceTimersByTimeAsync(4);
    expect(batches.map(shape)).toEqual([
      [true, 500, false],
      [false, 500, false],
      [false, 500, false],
      [false, 500, false],
    ]);
    await vi.advanceTimersByTimeAsync(66);
    expect(batches).toHaveLength(4);
    // 150 ms: the first tick sends an empty synced batch.
    await vi.advanceTimersByTimeAsync(1);
    expect(batches.slice(4)).toEqual([
      {
        watch_id: id,
        reset: false,
        upserts: [],
        deletes: [],
        synced: true,
        error: null,
        recovered: false,
      },
    ]);
    expect(replay(batches).size).toBe(2000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(batches).toHaveLength(5);
    handlers.resource_unwatch!({ watchId: id });
  });

  it('sends changes made during the list after its synced batch, 500 at most per batch', async () => {
    const cluster = db.getDb(CLUSTER);
    const { id, batches } = watch(PODS);
    await vi.advanceTimersByTimeAsync(90);
    expect(batches).toHaveLength(2);
    // Churn before the synced batch: 1 100 pods change, 100 are deleted.
    const pods = db.list(cluster, 'pods');
    for (const pod of pods.slice(100)) {
      pod.metadata.labels = { ...pod.metadata.labels, churn: '1' };
      db.put(cluster, pod);
    }
    for (const pod of pods.slice(0, 100)) db.drop(cluster, pod);
    await vi.advanceTimersByTimeAsync(59);
    expect(batches).toHaveLength(2);
    // 150 ms: the synced remainder, then the held changes, full batches at once.
    await vi.advanceTimersByTimeAsync(1);
    expect(batches.slice(2).map(shape)).toEqual([
      [false, 200, true],
      [false, 500, true],
      [false, 500, true],
    ]);
    // 300 ms: the rest at the next tick.
    await vi.advanceTimersByTimeAsync(150);
    expect(batches.slice(5).map(shape)).toEqual([[false, 200, true]]);

    // Ongoing changes: 500 pending flush at once, the rest at the next tick.
    const live = db.list(cluster, 'pods');
    for (const pod of live.slice(0, 600)) {
      pod.metadata.labels = { ...pod.metadata.labels, churn: '2' };
      db.put(cluster, pod);
    }
    expect(batches.slice(6).map(shape)).toEqual([[false, 500, true]]);
    await vi.advanceTimersByTimeAsync(150);
    expect(batches.slice(6).map(shape)).toEqual([
      [false, 500, true],
      [false, 100, true],
    ]);

    expect(batches.every((b) => b.upserts.length + b.deletes.length <= 500)).toBe(true);
    const store = replay(batches);
    expect([...store.keys()].sort()).toEqual(live.map((p) => p.metadata.uid).sort());
    expect([...store.values()].every((p) => p.metadata.labels?.churn)).toBe(true);
    handlers.resource_unwatch!({ watchId: id });
  });
});
