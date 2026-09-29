import { kindKey } from '@/lib/kube/catalog';
import { buildTopology, type TopologyList } from '@/lib/kube/topology/build';
import type { TopoGraph } from '@/lib/kube/topology/model';
import { deriveView, type TopologyView, type ViewOptions } from '@/lib/kube/topology/view';
import type { ApiResourceInfo, Gvk, KubeObject } from '@/types';

/**
 * The engines that run off the main thread (`engineWorker.ts`), or inline
 * where there is no `Worker` (Node, tests) or it failed to start
 * (`client.ts`). Pure: no DOM, no React, no i18n.
 *
 * Only the topology engine moved (plan Task 16, H5): its gate fired, the
 * health and netpol gates did not. Its input is every object of up to ~20
 * watched kinds, too large to clone per build (≈ 60 ms to serialise the
 * all-namespaces input of the `m` scale cluster, ≈ 35 ms to receive its
 * graph), so a topology session keeps a mirror of the watched lists in the
 * engine: the main thread streams per-slot deltas as batches arrive
 * (`topology-data`), asks for a build and view (`topology`), and gets back
 * only the view, plus the graph when it asked for it (the reachability
 * overlay needs it).
 */

/** Changes to one watch slot since the engine last heard of it. */
export interface TopologySlotDelta {
  slot: number;
  /** `null`: the slot is no longer watched. */
  gvk: Gvk | null;
  /** The list is complete (synced, no error): an absent object is "missing". */
  synced: boolean;
  /** Replace the slot's objects with `upserts` (in that order) instead of patching them. */
  replace: boolean;
  upserts: readonly KubeObject[];
  /** Uids to drop. */
  removes: readonly string[];
}

export interface TopologyDelta {
  /** The graph scope and extra objects, when they changed. */
  scope?: {
    namespaces: readonly string[] | null;
    apiResources: readonly ApiResourceInfo[] | null;
    extra: { gvk: Gvk; obj: KubeObject } | null;
  };
  slots: TopologySlotDelta[];
}

export type EngineTask =
  /** Applies a delta to a session's mirror (created on first use). No reply. */
  | { kind: 'topology-data'; session: number; delta: TopologyDelta }
  /** Builds the graph if its data changed, then derives the view. */
  | {
      kind: 'topology';
      session: number;
      view: ViewOptions;
      /** Send the graph back unless the caller holds revision `graphRev` already. */
      withGraph: boolean;
      graphRev: number;
      /** Measure the build and view (perf probe on). */
      timed: boolean;
    }
  | { kind: 'topology-dispose'; session: number };

export interface TopologyEngineResult {
  view: TopologyView;
  /** Revision of the session's graph the view was derived from. */
  graphRev: number;
  /** The graph, when asked for and the caller did not hold this revision. */
  graph?: TopoGraph;
  /** Engine time of the build (null: no rebuild, or not timed). */
  buildMs: number | null;
  /** Engine time of the view (null when not timed). */
  viewMs: number | null;
}

/**
 * A message to the worker: a request (`id > 0`) is answered with
 * `{ id, result }` or `{ id, error }`, a one-way task (`id = 0`) is not.
 */
export interface EngineRequest {
  id: number;
  task: EngineTask;
}

export type EngineResponse = { id: number; result: unknown } | { id: number; error: string };

/** A `topology` request for a session the engine does not hold (lost, or never fed). */
export const SESSION_MISSING = 'kubepit-engine: unknown topology session';

interface Slot {
  gvk: Gvk;
  key: string;
  synced: boolean;
  items: Map<string, KubeObject>;
}

class TopologySession {
  private slots: Array<Slot | null> = [];
  private namespaces: readonly string[] | null = [];
  private apiResources: readonly ApiResourceInfo[] | null = null;
  private extra: { gvk: Gvk; obj: KubeObject } | null = null;
  private graph: TopoGraph | null = null;
  private graphRev = 0;
  private dirty = true;

  apply(delta: TopologyDelta): void {
    if (delta.scope) {
      this.namespaces = delta.scope.namespaces;
      this.apiResources = delta.scope.apiResources;
      this.extra = delta.scope.extra;
    }
    for (const d of delta.slots) {
      if (!d.gvk) {
        this.slots[d.slot] = null;
        continue;
      }
      const key = `${kindKey(d.gvk)}/${d.gvk.version}`;
      let slot = this.slots[d.slot];
      if (!slot || d.replace || slot.key !== key) {
        slot = { gvk: d.gvk, key, synced: d.synced, items: new Map() };
        this.slots[d.slot] = slot;
      }
      for (const uid of d.removes) slot.items.delete(uid);
      for (const obj of d.upserts) slot.items.set(obj.metadata.uid, obj);
      slot.synced = d.synced;
    }
    this.dirty = true;
  }

  run(task: Extract<EngineTask, { kind: 'topology' }>): TopologyEngineResult {
    const now = task.timed ? () => performance.now() : () => 0;
    let buildMs: number | null = null;
    if (this.dirty || !this.graph) {
      const start = now();
      const lists: TopologyList[] = [];
      for (const slot of this.slots)
        if (slot)
          lists.push({ gvk: slot.gvk, items: [...slot.items.values()], synced: slot.synced });
      this.graph = buildTopology({
        lists,
        namespaces: this.namespaces,
        apiResources: this.apiResources,
        extra: this.extra ? [this.extra] : undefined,
      });
      this.graphRev++;
      this.dirty = false;
      if (task.timed) buildMs = now() - start;
    }
    const start = now();
    const view = deriveView(this.graph, task.view);
    const result: TopologyEngineResult = {
      view,
      graphRev: this.graphRev,
      buildMs,
      viewMs: task.timed ? now() - start : null,
    };
    if (task.withGraph && task.graphRev !== this.graphRev) result.graph = this.graph;
    return result;
  }
}

/** The engine's state: one topology session per open map. */
export class EngineHost {
  private sessions = new Map<number, TopologySession>();

  handle(task: EngineTask): unknown {
    switch (task.kind) {
      case 'topology-data': {
        let session = this.sessions.get(task.session);
        if (!session) this.sessions.set(task.session, (session = new TopologySession()));
        try {
          session.apply(task.delta);
        } catch (error) {
          // A half-applied mirror is wrong: forget it, so the next request
          // fails with SESSION_MISSING and the caller sends everything again.
          this.sessions.delete(task.session);
          throw error;
        }
        return null;
      }
      case 'topology': {
        const session = this.sessions.get(task.session);
        if (!session) throw new Error(SESSION_MISSING);
        return session.run(task);
      }
      case 'topology-dispose':
        this.sessions.delete(task.session);
        return null;
    }
  }

  /** Open sessions (tests). */
  get size(): number {
    return this.sessions.size;
  }
}
