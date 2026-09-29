import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN } from '@/lib/kube/catalog';
import {
  buildTopology,
  deriveView,
  type TopoGraph,
  type TopologyInput,
  type ViewOptions,
} from '@/lib/kube/topology';
import { EngineLost } from '@/lib/perf/worker/client';
import { EngineHost, type EngineTask, type TopologyEngineResult } from '@/lib/perf/worker/engine';
import type { Gvk, KubeObject } from '@/types';
import { TopologyModel, type TopologySource } from './topologyModel';

/**
 * The model against an engine that fails the way the worker can: a request
 * that throws (an engine bug), a delta that fails half-way (the engine
 * forgets the session), a lost worker (every session gone, pending requests
 * rejected), with replies delivered later than the work is done, like the
 * worker (which handles messages in order and answers asynchronously).
 */
function faultyEngine() {
  let host = new EngineHost();
  const pending: Array<{ settle: () => void; reject: (e: Error) => void }> = [];
  const state = { generation: 0, failNextRun: false, poisonNextPost: false, runs: 0, posts: 0 };
  const engine = {
    run(task: EngineTask) {
      state.runs++;
      let outcome: { value: TopologyEngineResult } | { error: Error };
      if (state.failNextRun) {
        state.failNextRun = false;
        outcome = { error: new Error('engine bug') };
      } else
        try {
          outcome = { value: host.handle(task) as TopologyEngineResult };
        } catch (error) {
          outcome = { error: error as Error };
        }
      return new Promise<TopologyEngineResult>((resolve, reject) =>
        pending.push({
          settle: () => ('value' in outcome ? resolve(outcome.value) : reject(outcome.error)),
          reject,
        }),
      );
    },
    post(task: EngineTask) {
      state.posts++;
      let applied = task;
      if (state.poisonNextPost && task.kind === 'topology-data') {
        state.poisonNextPost = false;
        // The apply throws after the first slots: the engine drops the session.
        const bad = { slot: 0, gvk: BUILTIN.Pod, synced: true, replace: false, removes: [] };
        applied = {
          ...task,
          delta: {
            ...task.delta,
            slots: [...task.delta.slots, { ...bad, upserts: [{} as never] }],
          },
        };
      }
      try {
        host.handle(applied);
      } catch {
        // Logged by the real client; the session is gone.
      }
    },
    acquire: () => () => undefined,
    generation: () => state.generation,
  };
  return {
    engine,
    state,
    pending,
    /** Delivers the oldest `n` replies, in order. */
    deliver(n = Infinity) {
      for (let i = 0; i < n && pending.length; i++) pending.shift()!.settle();
    },
    /** The worker died: its sessions are gone and pending requests reject. */
    lose() {
      host = new EngineHost();
      state.generation++;
      for (const p of pending.splice(0)) p.reject(new EngineLost('the worker failed'));
    },
    get host() {
      return host;
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

/** Delivers every reply, including those of the requests replies cause. */
async function drain(e: ReturnType<typeof faultyEngine>) {
  for (let i = 0; i < 50; i++) {
    await settle();
    if (!e.pending.length) return;
    e.deliver();
  }
  throw new Error('the model keeps sending requests');
}

const view = (hidden: string[] = [], hops = 1): ViewOptions => ({
  rootId: null,
  hops,
  expanded: new Set(),
  hiddenKinds: new Set(hidden),
  maxNodes: 1000,
});

/** What the engine must have built from `source`: the same input as `useTopologyData`'s. */
function expected(source: TopologySource): TopoGraph {
  const input: TopologyInput = {
    lists: source.slots.flatMap((s) =>
      s ? [{ gvk: s.gvk, items: s.items, synced: s.synced }] : [],
    ),
    namespaces: source.namespaces,
    apiResources: source.apiResources,
    extra: source.extra ? [source.extra] : undefined,
  };
  return buildTopology(input);
}

/** The engine's graph equals a fresh build, node and edge order included. */
function expectGraph(graph: TopoGraph | null, source: TopologySource) {
  const want = expected(source);
  expect(graph).not.toBeNull();
  expect([...graph!.nodes.keys()]).toEqual([...want.nodes.keys()]);
  expect(graph!.edges).toEqual(want.edges);
  expect(graph).toEqual(want);
}

const pod = (i: number, rev = 0): KubeObject => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: {
    name: `pod-${i}`,
    namespace: 'ns',
    uid: `pod-${i}`,
    resourceVersion: String(rev),
    labels: { app: `a${i % 3}` },
  },
  spec: { volumes: [{ name: 'cfg', configMap: { name: `cm-${i % 4}` } }] },
});
const configMap = (i: number, rev = 0): KubeObject => ({
  apiVersion: 'v1',
  kind: 'ConfigMap',
  metadata: { name: `cm-${i}`, namespace: 'ns', uid: `cm-${i}`, resourceVersion: String(rev) },
});
const service = (i: number, rev = 0): KubeObject => ({
  apiVersion: 'v1',
  kind: 'Service',
  metadata: { name: `svc-${i}`, namespace: 'ns', uid: `svc-${i}`, resourceVersion: String(rev) },
  spec: { selector: { app: `a${i % 3}` } },
});

const KINDS: Array<{ gvk: Gvk; make: (i: number, rev?: number) => KubeObject }> = [
  { gvk: BUILTIN.Pod, make: pod },
  { gvk: BUILTIN.ConfigMap, make: configMap },
  { gvk: BUILTIN.Service, make: service },
];

/**
 * Watch slots that behave like `watchCache` entries: an insertion-ordered
 * map (updates keep their place, a re-add moves to the end, a relist
 * clears it), and a snapshot rebuilt only when something changed.
 */
class Slots {
  maps = KINDS.map(() => new Map<string, KubeObject>());
  watched = KINDS.map(() => true);
  synced = KINDS.map(() => false);
  private snaps: Array<{ items: KubeObject[]; byUid: Map<string, KubeObject> } | null> = KINDS.map(
    () => null,
  );

  touch(slot: number) {
    this.snaps[slot] = null;
  }

  source(): TopologySource {
    const slots = KINDS.map((k, i) => {
      if (!this.watched[i]) return null;
      const snap = (this.snaps[i] ??= {
        items: [...this.maps[i]!.values()],
        byUid: new Map(this.maps[i]!),
      });
      return { gvk: k.gvk, items: snap.items, byUid: snap.byUid, synced: this.synced[i]! };
    });
    return {
      slots,
      namespaces: ['ns'],
      apiResources: null,
      extra: null,
      synced: slots.every((s, i) => !s || this.synced[i]),
    };
  }
}

describe('TopologyModel under engine faults', () => {
  beforeEach(() => void vi.spyOn(console, 'error').mockImplementation(() => undefined));
  afterEach(() => void vi.restoreAllMocks());

  it('drops an unwatched slot after an engine error made it resend everything', async () => {
    const e = faultyEngine();
    const model = new TopologyModel(e.engine);
    model.setView(view(), 'fit');
    model.setWithGraph(true);
    model.setActive(true);
    const slots = new Slots();
    slots.maps[0]!.set('pod-1', pod(1));
    slots.maps[1]!.set('cm-1', configMap(1));
    const first = slots.source();
    model.setSource(first);
    model.setBuild(first);
    await drain(e);
    expectGraph(model.getResult().graph, first);
    // A request fails with an engine error; the engine keeps its session.
    e.state.failNextRun = true;
    model.setView(view(['ConfigMap']), 'fit');
    await drain(e);
    // Then the pods are no longer watched: the resend must not keep them.
    slots.watched[0] = false;
    const next = slots.source();
    model.setSource(next);
    model.setBuild(next);
    await drain(e);
    expectGraph(model.getResult().graph, next);
    expect([...model.getResult().graph!.nodes.keys()].some((id) => id.startsWith('pods|'))).toBe(
      false,
    );
  });

  it('resyncs after a failed apply instead of building from the next patch alone', async () => {
    const e = faultyEngine();
    const model = new TopologyModel(e.engine);
    model.setView(view(), 'fit');
    model.setWithGraph(true);
    model.setActive(true);
    const slots = new Slots();
    slots.maps[0]!.set('pod-1', pod(1)).set('pod-2', pod(2));
    const first = slots.source();
    model.setSource(first);
    model.setBuild(first);
    await drain(e);
    // This delta fails half-way (the engine forgets the session)…
    e.state.poisonNextPost = true;
    slots.maps[0]!.set('pod-3', pod(3));
    slots.touch(0);
    model.setSource(slots.source());
    // …and the next one is a patch that must not become the whole session.
    slots.maps[0]!.set('pod-4', pod(4));
    slots.touch(0);
    const last = slots.source();
    model.setSource(last);
    model.setBuild(last);
    await drain(e);
    expectGraph(model.getResult().graph, last);
  });

  it('never keeps a graph of a replaced session for one of the new', async () => {
    const e = faultyEngine();
    const model = new TopologyModel(e.engine);
    model.setView(view(), 'fit');
    model.setWithGraph(true);
    model.setActive(true);
    const slots = new Slots();
    slots.maps[0]!.set('pod-1', pod(1));
    const first = slots.source();
    model.setSource(first);
    model.setBuild(first);
    await drain(e);
    expect(model.getResult().graph!.nodes.has('pods|ns|pod-1')).toBe(true);
    // The worker dies; the new session also numbers its first graph 1.
    e.lose();
    slots.maps[0]!.delete('pod-1');
    slots.maps[0]!.set('pod-2', pod(2));
    slots.touch(0);
    const next = slots.source();
    model.setSource(next);
    model.setBuild(next);
    await drain(e);
    const { graph, view: shown } = model.getResult();
    expect(shown.nodes.some((n) => n.id === 'pods|ns|pod-2')).toBe(true);
    expect(graph!.nodes.has('pods|ns|pod-2')).toBe(true);
    expect(graph!.nodes.has('pods|ns|pod-1')).toBe(false);
  });

  it('does not rebuild on resume for an overlay turned off while its graph was on the way', async () => {
    const e = faultyEngine();
    const model = new TopologyModel(e.engine);
    model.setView(view(), 'fit');
    model.setActive(true);
    const slots = new Slots();
    slots.maps[0]!.set('pod-1', pod(1));
    const first = slots.source();
    model.setSource(first);
    model.setBuild(first);
    await drain(e);
    model.setWithGraph(true);
    await settle();
    expect(e.pending).toHaveLength(1);
    model.setWithGraph(false);
    await drain(e);
    expect(model.getResult().graph).toBeNull();
    model.setActive(false);
    const { runs, posts } = e.state;
    model.setActive(true);
    await drain(e);
    expect(e.state.runs).toBe(runs);
    expect(e.state.posts).toBe(posts);
  });

  it('keeps the engine equal to a fresh build through random changes and faults', async () => {
    for (let round = 1; round <= 20; round++) {
      const rand = prng(round);
      const pick = (n: number) => Math.floor(rand() * n);
      const e = faultyEngine();
      const model = new TopologyModel(e.engine);
      const slots = new Slots();
      let hidden: string[] = [];
      let hops = 1;
      let rendered = slots.source();
      let next = 0;
      let rev = 0;
      model.setView(view(hidden, hops), 'fit');
      model.setWithGraph(true);
      model.setActive(true);
      model.setSource(rendered);
      model.setBuild(rendered);
      const check = async (step: number) => {
        e.state.failNextRun = false;
        e.state.poisonNextPost = false;
        await drain(e);
        // A new view makes sure a request follows the last data.
        model.setView(view(hidden, hops), 'fit');
        await drain(e);
        const result = model.getResult();
        const where = `round ${round}, step ${step}`;
        expect(result.synced, where).toBe(rendered.synced);
        expectGraph(result.graph, rendered);
        expect(result.view, where).toEqual(deriveView(expected(rendered), view(hidden, hops)));
      };
      for (let step = 1; step <= 60; step++) {
        const slot = pick(KINDS.length);
        const map = slots.maps[slot]!;
        const keys = [...map.keys()];
        const make = KINDS[slot]!.make;
        const idOf = (uid: string) => Number(uid.split('-')[1]);
        switch (pick(12)) {
          case 0:
          case 1: // new objects
            for (let n = 1 + pick(3); n > 0; n--) map.set(make(next).metadata.uid, make(next++));
            break;
          case 2: // an update in place
            if (keys.length) {
              const uid = keys[pick(keys.length)]!;
              map.set(uid, make(idOf(uid), ++rev));
            }
            break;
          case 3: // a delete
            if (keys.length) map.delete(keys[pick(keys.length)]!);
            break;
          case 4: // deleted and added again: it moves to the end
            if (keys.length) {
              const uid = keys[pick(keys.length)]!;
              map.delete(uid);
              map.set(uid, make(idOf(uid), ++rev));
            }
            break;
          case 5: {
            // a relist: new objects, in another order, some gone
            const kept = keys.filter(() => rand() < 0.8).sort(() => rand() - 0.5);
            map.clear();
            for (const uid of kept) map.set(uid, make(idOf(uid), ++rev));
            break;
          }
          case 6: // the slot stops or starts being watched
            slots.watched[slot] = !slots.watched[slot];
            break;
          case 7:
            slots.synced[slot] = !slots.synced[slot];
            break;
          case 8: // a fault
            [
              () => (e.state.failNextRun = true),
              () => (e.state.poisonNextPost = true),
              () => e.lose(),
              () => {
                model.setActive(false);
                model.setActive(true);
              },
            ][pick(4)]!();
            break;
          case 9: // another view (pipelined; the older reply goes stale)
            hidden = rand() < 0.5 ? [] : ['ConfigMap'];
            hops = 1 + pick(3);
            model.setView(view(hidden, hops), 'fit');
            break;
          case 10: // replies arrive
            e.deliver(pick(3));
            break;
          default:
            break;
        }
        slots.touch(slot);
        // Some changes are not rendered at once: the next render carries them.
        if (rand() < 0.7) {
          rendered = slots.source();
          model.setSource(rendered);
          if (rand() < 0.8) model.setBuild(rendered);
        }
        await settle();
        if (step % 20 === 0) await check(step);
      }
      model.setActive(false);
    }
  });
});

/** Deterministic PRNG (mulberry32), so a failing round can be replayed. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
