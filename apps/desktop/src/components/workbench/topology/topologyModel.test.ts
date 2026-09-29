import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN } from '@/lib/kube/catalog';
import type { ViewOptions } from '@/lib/kube/topology';
import { EngineLost } from '@/lib/perf/worker/client';
import { EngineHost, type EngineTask, type TopologyEngineResult } from '@/lib/perf/worker/engine';
import type { KubeObject } from '@/types';
import { CoalescedMemo, SYNC_REBUILD_INTERVAL_MS } from './dataKey';
import { TopologyModel, topologyDelta, type TopologySource } from './topologyModel';

const pod = (i: number, rev = 0): KubeObject => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: `p-${i}`, namespace: 'ns', uid: `uid-${i}`, resourceVersion: String(rev) },
  spec: {},
});

/** A source with one pod slot, as `useTopologyData` makes it from a snapshot. */
function source(
  items: KubeObject[],
  synced = true,
  byUid?: Map<string, KubeObject>,
): TopologySource {
  return {
    slots: [
      {
        gvk: BUILTIN.Pod,
        items,
        byUid: byUid ?? new Map(items.map((o) => [o.metadata.uid, o])),
        synced,
      },
    ],
    namespaces: ['ns'],
    apiResources: null,
    extra: null,
    synced,
  };
}

const view = (extra: Partial<ViewOptions> = {}): ViewOptions => ({
  rootId: null,
  hops: 1,
  expanded: new Set(),
  hiddenKinds: new Set(),
  maxNodes: 1000,
  ...extra,
});

const podCount = (m: TopologyModel) =>
  m.getResult().view.nodes.filter((n) => n.kind === 'Pod' && !n.group).length;

/**
 * An engine over a real `EngineHost` whose requests the test answers by
 * hand (`answer`), or at once with `auto`.
 */
function testEngine(auto = false) {
  const host = new EngineHost();
  const runs: Array<{
    task: EngineTask;
    resolve: (r: TopologyEngineResult) => void;
    reject: (e: Error) => void;
  }> = [];
  const posts: EngineTask[] = [];
  const state = { generation: 0, held: 0 };
  const answer = (i = 0) => {
    const [r] = runs.splice(i, 1);
    try {
      r!.resolve(host.handle(r!.task) as TopologyEngineResult);
    } catch (error) {
      r!.reject(error as Error);
    }
  };
  return {
    host,
    runs,
    posts,
    state,
    answer,
    engine: {
      run: (task: EngineTask) =>
        new Promise<TopologyEngineResult>((resolve, reject) => {
          runs.push({ task, resolve, reject });
          if (auto) answer(runs.length - 1);
        }),
      post: (task: EngineTask) => {
        posts.push(task);
        host.handle(task);
      },
      acquire: () => {
        state.held++;
        return () => void state.held--;
      },
      generation: () => state.generation,
    },
  };
}

/** Lets queued microtasks (requests, replies) run. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('topologyDelta', () => {
  it('sends everything the first time, then only what changed', () => {
    const a = source([pod(1), pod(2)]);
    const first = topologyDelta(null, a)!;
    expect(first.scope).toBeDefined();
    expect(first.slots[0]).toMatchObject({ replace: true, upserts: a.slots[0]!.items });
    expect(topologyDelta(a, a)).toBeNull();

    const changed = pod(2, 1);
    const b = source([a.slots[0]!.items[0]!, changed, pod(3)]);
    const delta = topologyDelta(a, b)!;
    expect(delta.scope).toBeUndefined();
    expect(delta.slots).toEqual([
      {
        slot: 0,
        gvk: BUILTIN.Pod,
        synced: true,
        replace: false,
        upserts: [changed, b.slots[0]!.items[2]],
        removes: [],
      },
    ]);
    const c = source([b.slots[0]!.items[1]!, b.slots[0]!.items[2]!]);
    expect(topologyDelta(b, c)!.slots[0]).toMatchObject({ upserts: [], removes: ['uid-1'] });
  });

  it('sends a relisted slot whole, in order, and flags alone', () => {
    const a = source([pod(1), pod(2)]);
    const relisted = source([pod(2), pod(1)]);
    expect(topologyDelta(a, relisted)!.slots[0]).toMatchObject({
      replace: true,
      upserts: relisted.slots[0]!.items,
    });
    const unsynced = { ...a, slots: [{ ...a.slots[0]!, synced: false }] };
    expect(topologyDelta(unsynced, a)!.slots[0]).toMatchObject({
      synced: true,
      replace: false,
      upserts: [],
      removes: [],
    });
    expect(topologyDelta(a, { ...a, slots: [null] })!.slots[0]).toMatchObject({ gvk: null });
    expect(topologyDelta(a, { ...a, namespaces: ['other'] })!.scope).toEqual({
      namespaces: ['other'],
      apiResources: null,
      extra: null,
    });
  });
});

describe('TopologyModel', () => {
  afterEach(() => void vi.useRealTimers());

  it('streams each batch as its own objects and ends with the complete, synced view', async () => {
    vi.useFakeTimers();
    const t = testEngine(true);
    const model = new TopologyModel(t.engine);
    // What `useTopologyData` does on every render.
    let current = source([], false);
    let version = 0;
    const render = () => {
      model.setSource(current);
      model.setBuild(coalesced.get(['ns'], [version], true, !current.synced, () => current));
    };
    const coalesced = new CoalescedMemo<TopologySource>(render, SYNC_REBUILD_INTERVAL_MS, () =>
      Date.now(),
    );
    model.setView(view(), 'fit');
    model.setActive(true);
    render();
    const items: KubeObject[] = [];
    // 100 batches of 5 pods over 2 s, then the batch that completes the sync.
    for (let b = 0; b <= 100; b++) {
      await vi.advanceTimersByTimeAsync(20);
      for (let i = 0; i < 5; i++) items.push(pod(b * 5 + i));
      current = source([...items], b === 100);
      version++;
      render();
    }
    await vi.advanceTimersByTimeAsync(0);
    const data = t.posts.filter((p) => p.kind === 'topology-data');
    expect(data).toHaveLength(102);
    // Each batch sends its own pods, never the whole list.
    expect(
      data
        .slice(1)
        .every((p) => p.kind === 'topology-data' && p.delta.slots[0]!.upserts.length === 5),
    ).toBe(true);
    const built = model.getResult();
    expect(built.synced).toBe(true);
    expect(built.tag).toBe('fit');
    expect(podCount(model)).toBe(505);
  });

  it('builds at most 1 + 2000 / 250 times plus the synced build over a 2 s sync', async () => {
    vi.useFakeTimers();
    const t = testEngine(true);
    let requests = 0;
    const run = t.engine.run;
    t.engine.run = (task) => {
      requests++;
      return run(task);
    };
    const model = new TopologyModel(t.engine);
    let current = source([], false);
    let version = 0;
    const render = () => {
      model.setSource(current);
      model.setBuild(coalesced.get(['ns'], [version], true, !current.synced, () => current));
    };
    const coalesced = new CoalescedMemo<TopologySource>(render, SYNC_REBUILD_INTERVAL_MS, () =>
      Date.now(),
    );
    model.setView(view(), 'fit');
    model.setActive(true);
    render();
    const items: KubeObject[] = [];
    for (let b = 0; b < 100; b++) {
      await vi.advanceTimersByTimeAsync(20);
      items.push(pod(b));
      current = source([...items], false);
      version++;
      render();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toBeLessThanOrEqual(1 + Math.ceil(2000 / SYNC_REBUILD_INTERVAL_MS));
    const before = requests;
    current = source([...items], true);
    version++;
    render();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toBe(before + 1);
    expect(model.getResult().synced).toBe(true);
    expect(podCount(model)).toBe(100);
  });

  it('coalesces data changes behind the request in flight', async () => {
    const t = testEngine();
    const model = new TopologyModel(t.engine);
    model.setView(view(), 'fit');
    model.setActive(true);
    const a = source([pod(1)]);
    model.setSource(a);
    model.setBuild(a);
    await settle();
    expect(t.runs).toHaveLength(1);
    for (let i = 2; i <= 4; i++) {
      const next = source([...Array(i)].map((_, j) => pod(j + 1)));
      model.setSource(next);
      model.setBuild(next);
      await settle();
    }
    expect(t.runs).toHaveLength(1);
    t.answer();
    await settle();
    // One request for the three changes, built from the latest data.
    expect(t.runs).toHaveLength(1);
    t.answer();
    await settle();
    expect(podCount(model)).toBe(4);
  });

  it('drops a stale reply when a newer request is in flight', async () => {
    const t = testEngine();
    const model = new TopologyModel(t.engine);
    const a = source([pod(1), pod(2)]);
    model.setView(view(), 'fit');
    model.setActive(true);
    model.setSource(a);
    model.setBuild(a);
    await settle();
    // A view change does not wait: it supersedes the request in flight.
    model.setView(view({ hiddenKinds: new Set(['Pod']) }), 'fit');
    await settle();
    expect(t.runs).toHaveLength(2);
    t.answer(0);
    await settle();
    expect(model.getResult().view.nodes).toEqual([]); // the stale reply was dropped
    t.answer(0);
    await settle();
    expect(model.getResult().view.kinds.map((k) => k.kind)).toContain('Pod');
    expect(podCount(model)).toBe(0);
  });

  it('keeps its last result while inactive, sends nothing, and frees the engine', async () => {
    const t = testEngine(true);
    const model = new TopologyModel(t.engine);
    const a = source([pod(1)]);
    model.setView(view(), 'fit');
    model.setActive(true);
    model.setSource(a);
    model.setBuild(a);
    await settle();
    const shown = model.getResult();
    expect(podCount(model)).toBe(1);
    model.setActive(false);
    expect(t.state.held).toBe(0);
    expect(t.posts.at(-1)).toEqual({ kind: 'topology-dispose', session: model.session });
    expect(t.host.size).toBe(0);
    const posted = t.posts.length;
    const b = source([pod(1), pod(2)]);
    model.setSource(b);
    model.setBuild(b);
    model.setView(view({ hops: 2 }), 'fit');
    await settle();
    expect(t.posts.length).toBe(posted);
    expect(model.getResult()).toBe(shown);
    // Resuming sends the whole input again, then builds.
    model.setActive(true);
    await settle();
    expect(t.posts.at(-1)).toMatchObject({ kind: 'topology-data' });
    expect(podCount(model)).toBe(2);
  });

  it('resumes without work when nothing changed meanwhile', async () => {
    const t = testEngine(true);
    const model = new TopologyModel(t.engine);
    const a = source([pod(1)]);
    model.setView(view(), 'fit');
    model.setActive(true);
    model.setSource(a);
    model.setBuild(a);
    await settle();
    model.setActive(false);
    const posted = t.posts.length;
    model.setActive(true);
    await settle();
    expect(t.posts.length).toBe(posted);
    expect(podCount(model)).toBe(1);
  });

  it('sends everything again after the engine lost the session', async () => {
    const t = testEngine();
    const model = new TopologyModel(t.engine);
    const a = source([pod(1), pod(2)]);
    model.setView(view(), 'fit');
    model.setActive(true);
    model.setSource(a);
    model.setBuild(a);
    await settle();
    // The worker died: its sessions are gone and the request is rejected.
    t.host.handle({ kind: 'topology-dispose', session: model.session });
    t.state.generation++;
    t.runs.splice(0, 1)[0]!.reject(new EngineLost('the worker failed'));
    await settle();
    const resent = t.posts.at(-1)!;
    expect(resent).toMatchObject({ kind: 'topology-data' });
    expect(resent.kind === 'topology-data' && resent.delta.slots[0]!.upserts).toHaveLength(2);
    t.answer();
    await settle();
    expect(podCount(model)).toBe(2);
  });

  it('brings the graph back only while asked to', async () => {
    const t = testEngine(true);
    const model = new TopologyModel(t.engine);
    const a = source([pod(1)]);
    model.setView(view(), 'fit');
    model.setActive(true);
    model.setSource(a);
    model.setBuild(a);
    await settle();
    expect(model.getResult().graph).toBeNull();
    model.setWithGraph(true);
    await settle();
    const graph = model.getResult().graph;
    expect(graph?.nodes.has('pods|ns|p-1')).toBe(true);
    // Another view of the same graph keeps it without sending it again.
    model.setView(view({ hops: 2 }), 'fit');
    await settle();
    expect(model.getResult().graph).toBe(graph);
    model.setWithGraph(false);
    expect(model.getResult().graph).toBeNull();
  });
});
