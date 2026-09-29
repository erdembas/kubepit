import { kindKey } from '@/lib/kube/catalog';
import type { TopoGraph, TopologyView, ViewOptions } from '@/lib/kube/topology';
import { perfEnabled, perfNow, recordDuration } from '@/lib/perf/probe';
import {
  acquireEngine,
  engineGeneration,
  EngineLost,
  postEngine,
  runEngine,
} from '@/lib/perf/worker/client';
import {
  SESSION_MISSING,
  type EngineTask,
  type TopologyDelta,
  type TopologyEngineResult,
} from '@/lib/perf/worker/engine';
import type { ApiResourceInfo, Gvk, KubeObject } from '@/types';

/**
 * The main-thread side of one map's topology session (`lib/perf/worker`):
 * the graph is built and the view derived in the engine worker, off the
 * main thread (plan Task 16, H5).
 *
 * - `setSource` streams what changed in the watched lists to the engine as
 *   the batches arrive (per-slot deltas found by object identity, so a
 *   batch costs its own objects, never the whole list).
 * - `setBuild` asks for a rebuild. `useTopologyData` passes a token that
 *   `CoalescedMemo` renews at most every 250 ms while the watches sync.
 * - `setView` asks for another view (filters, groups, root, hops) of the
 *   same graph; `withGraph` also brings the graph back (reachability).
 *
 * At most one request is in flight for data changes: later ones wait for
 * the reply and coalesce into one. A view change is sent at once, and the
 * reply of any request that a newer one superseded is dropped (sequence
 * numbers). While inactive nothing is sent and the last result stays; the
 * engine forgets the session and is released, so the worker stops once no
 * map is active.
 */

export interface TopologySlotData {
  gvk: Gvk;
  items: readonly KubeObject[];
  /** The snapshot's index: its identity changes exactly when the items do. */
  byUid: ReadonlyMap<string, KubeObject>;
  /** The list is complete (synced, no error): an absent object is "missing". */
  synced: boolean;
}

/** One map's input: a slot per topology source (`null` when not watched). */
export interface TopologySource {
  slots: ReadonlyArray<TopologySlotData | null>;
  namespaces: readonly string[] | null;
  apiResources: readonly ApiResourceInfo[] | null;
  extra: { gvk: Gvk; obj: KubeObject } | null;
  /** Every watched slot delivered its list (or failed). */
  synced: boolean;
}

export interface TopologyResult {
  view: TopologyView;
  /** The full graph, only while `withGraph` is on. */
  graph: TopoGraph | null;
  /** Derived from data whose every list was synced. */
  synced: boolean;
  /** The tag of the view request (the map's fit key). */
  tag: string;
}

export const EMPTY_VIEW: TopologyView = {
  nodes: [],
  edges: [],
  total: 0,
  relationships: 0,
  aggregated: 0,
  kinds: [],
  distance: new Map(),
};

const EMPTY_RESULT: TopologyResult = { view: EMPTY_VIEW, graph: null, synced: false, tag: '' };

/** The transport (`lib/perf/worker/client.ts`); tests pass their own. */
export interface TopologyEngine {
  run(task: EngineTask): Promise<TopologyEngineResult>;
  post(task: EngineTask): void;
  acquire(): () => void;
  generation(): number;
}

const workerEngine: TopologyEngine = {
  run: (task) => runEngine<TopologyEngineResult>(task),
  post: postEngine,
  acquire: acquireEngine,
  generation: engineGeneration,
};

/** Retries after the engine lost the session, before giving up until the next change. */
const MAX_RETRIES = 2;

const sameGvk = (a: Gvk, b: Gvk) =>
  a === b || (kindKey(a) === kindKey(b) && a.version === b.version);

const namespacesKey = (ns: readonly string[] | null) => (ns === null ? '\0' : ns.join(','));

function sameScope(a: TopologySource, b: TopologySource) {
  return (
    namespacesKey(a.namespaces) === namespacesKey(b.namespaces) &&
    a.apiResources === b.apiResources &&
    a.extra?.obj === b.extra?.obj &&
    (!a.extra || !b.extra || sameGvk(a.extra.gvk, b.extra.gvk))
  );
}

/**
 * What changed from `prev` (what the engine holds; `null` for nothing) to
 * `next`, or `null` when nothing did. Unchanged objects keep their
 * identity across snapshots, so a slot costs one pass over its index and
 * sends only new, changed and removed objects. A slot that changed as a
 * whole (a relist, another kind) is sent whole, in order.
 */
export function topologyDelta(
  prev: TopologySource | null,
  next: TopologySource,
): TopologyDelta | null {
  const delta: TopologyDelta = { slots: [] };
  if (!prev || !sameScope(prev, next))
    delta.scope = {
      namespaces: next.namespaces,
      apiResources: next.apiResources,
      extra: next.extra,
    };
  const count = Math.max(prev?.slots.length ?? 0, next.slots.length);
  for (let slot = 0; slot < count; slot++) {
    const a = prev?.slots[slot] ?? null;
    const b = next.slots[slot] ?? null;
    if (!b) {
      if (a)
        delta.slots.push({
          slot,
          gvk: null,
          synced: false,
          replace: true,
          upserts: [],
          removes: [],
        });
      continue;
    }
    if (!a || !sameGvk(a.gvk, b.gvk)) {
      delta.slots.push({
        slot,
        gvk: b.gvk,
        synced: b.synced,
        replace: true,
        upserts: b.items,
        removes: [],
      });
      continue;
    }
    if (a.byUid === b.byUid) {
      if (a.synced !== b.synced)
        delta.slots.push({
          slot,
          gvk: b.gvk,
          synced: b.synced,
          replace: false,
          upserts: [],
          removes: [],
        });
      continue;
    }
    const upserts: KubeObject[] = [];
    const removes: string[] = [];
    for (const [uid, obj] of b.byUid) if (a.byUid.get(uid) !== obj) upserts.push(obj);
    for (const uid of a.byUid.keys()) if (!b.byUid.has(uid)) removes.push(uid);
    if (upserts.length + removes.length >= b.items.length)
      delta.slots.push({
        slot,
        gvk: b.gvk,
        synced: b.synced,
        replace: true,
        upserts: b.items,
        removes: [],
      });
    else delta.slots.push({ slot, gvk: b.gvk, synced: b.synced, replace: false, upserts, removes });
  }
  return delta.scope || delta.slots.length ? delta : null;
}

let nextSession = 1;

/** What a request asked for (and so what its result shows). */
interface Asked {
  build: TopologySource | null;
  viewRev: number;
  withGraph: boolean;
}

const NOTHING: Asked = { build: null, viewRev: -1, withGraph: false };

export class TopologyModel {
  readonly session = nextSession++;
  private source: TopologySource | null = null;
  private build: TopologySource | null = null;
  private view: ViewOptions | null = null;
  private tag = '';
  private viewRev = 0;
  private withGraph = false;
  private active = false;
  private release: (() => void) | null = null;
  /** What the engine holds for this session, and in which engine generation. */
  private sent: { source: TopologySource; generation: number } | null = null;
  private requested: Asked = NOTHING;
  private shown: Asked = NOTHING;
  private seq = 0;
  private inFlight = false;
  private scheduled = false;
  private retries = 0;
  private result = EMPTY_RESULT;
  /** Engine revision of `result.graph` (-1: none held). */
  private graphRev = -1;
  private listeners = new Set<() => void>();

  constructor(private readonly engine: TopologyEngine = workerEngine) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getResult = (): TopologyResult => this.result;

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (active) {
      this.release = this.engine.acquire();
      this.schedule();
      return;
    }
    // Leaving costs one message: the engine forgets the session, the last
    // result stays, and a reply still in flight is dropped.
    this.seq++;
    this.inFlight = false;
    this.requested = this.shown;
    if (this.sent) this.engine.post({ kind: 'topology-dispose', session: this.session });
    this.sent = null;
    this.release?.();
    this.release = null;
  }

  /** The latest input; what changed is streamed to the engine at once. */
  setSource(source: TopologySource): void {
    if (source === this.source) return;
    this.source = source;
    if (this.active) this.push();
  }

  /** Rebuild with the latest input (a new token each time). */
  setBuild(token: TopologySource): void {
    if (token === this.build) return;
    this.build = token;
    this.schedule();
  }

  setView(view: ViewOptions, tag: string): void {
    if (view === this.view && tag === this.tag) return;
    this.view = view;
    this.tag = tag;
    this.viewRev++;
    this.schedule();
  }

  setWithGraph(withGraph: boolean): void {
    if (withGraph === this.withGraph) return;
    this.withGraph = withGraph;
    if (withGraph) {
      this.schedule();
      return;
    }
    this.requested = { ...this.requested, withGraph: false };
    this.shown = { ...this.shown, withGraph: false };
    this.graphRev = -1;
    if (this.result.graph) this.publish({ ...this.result, graph: null });
  }

  private publish(result: TopologyResult) {
    this.result = result;
    for (const listener of this.listeners) listener();
  }

  /** Requests go out in a microtask: every change of one React commit rides one request. */
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.flush();
    });
  }

  private flush() {
    if (!this.active || !this.source || !this.build || !this.view) return;
    const wantBuild = this.build !== this.requested.build;
    const wantView =
      this.viewRev !== this.requested.viewRev || this.withGraph !== this.requested.withGraph;
    if (!wantBuild && !wantView) return;
    // Data changes wait for the reply in flight; view changes go at once.
    if (this.inFlight && !wantView) return;
    this.request();
  }

  /** Sends what changed since the engine last heard (everything after a loss). */
  private push() {
    const source = this.source;
    if (!source) return;
    if (this.sent && this.sent.generation !== this.engine.generation()) this.sent = null;
    const delta = topologyDelta(this.sent?.source ?? null, source);
    // The first message creates the session, even for an empty map.
    if (delta || !this.sent)
      this.engine.post({
        kind: 'topology-data',
        session: this.session,
        delta: delta ?? { slots: [] },
      });
    this.sent = { source, generation: this.engine.generation() };
  }

  private request() {
    this.push();
    const source = this.source!;
    const asked: Asked = { build: this.build, viewRev: this.viewRev, withGraph: this.withGraph };
    const synced = source.synced;
    const tag = this.tag;
    const seq = ++this.seq;
    this.inFlight = true;
    this.requested = asked;
    const sentAt = perfNow();
    this.engine
      .run({
        kind: 'topology',
        session: this.session,
        view: this.view!,
        withGraph: this.withGraph,
        graphRev: this.graphRev,
        timed: perfEnabled(),
      })
      .then(
        (reply) => this.onReply(seq, asked, synced, tag, reply, sentAt),
        (error: unknown) => this.onError(seq, error),
      );
  }

  private onReply(
    seq: number,
    asked: Asked,
    synced: boolean,
    tag: string,
    reply: TopologyEngineResult,
    sentAt: number,
  ) {
    // A newer request is in flight (or the map was left): this one is stale.
    if (seq !== this.seq) return;
    this.inFlight = false;
    this.retries = 0;
    this.shown = asked;
    let graph: TopoGraph | null = null;
    if (this.withGraph) {
      if (reply.graph) {
        graph = reply.graph;
        this.graphRev = reply.graphRev;
      } else if (this.graphRev === reply.graphRev) graph = this.result.graph;
    }
    if (perfEnabled()) {
      if (reply.buildMs !== null) recordDuration('map:build', reply.buildMs);
      recordDuration('map:view', reply.viewMs ?? 0, {
        nodes: reply.view.nodes.length,
        synced: synced ? 1 : 0,
      });
      recordDuration('map:roundtrip', performance.now() - sentAt);
    }
    this.publish({ view: reply.view, graph, synced, tag });
    this.flush();
  }

  private onError(seq: number, error: unknown) {
    if (seq !== this.seq) return;
    this.inFlight = false;
    // The engine's copy is unknown now: the next request sends everything.
    this.sent = null;
    const lost =
      error instanceof EngineLost || (error instanceof Error && error.message === SESSION_MISSING);
    if (lost && this.retries < MAX_RETRIES) {
      this.retries++;
      this.requested = this.shown;
      this.schedule();
      return;
    }
    // Keep the last result; the next change tries again.
    console.error('kubepit: the Resource Map engine failed', error);
  }
}
