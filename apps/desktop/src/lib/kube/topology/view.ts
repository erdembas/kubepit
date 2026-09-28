import type { StatusTone } from '../pods';
import {
  compareNodes,
  groupId,
  kindRank,
  TIER,
  worstTone,
  type EdgeKind,
  type TopoEdge,
  type TopoGraph,
  type TopoNode,
} from './model';
import { isClusterScopedKind } from './sources';

/**
 * The view pipeline between the full graph and the layout:
 * scope (a namespace map or an object's neighbourhood) → drop inactive
 * controllers → hide filtered kinds → collapse pods per controller →
 * cap the node count. Every step is pure and keeps a deterministic order.
 */

export interface ViewOptions {
  /** Neighbourhood root; null shows the whole (scoped) graph. */
  rootId: string | null;
  /** Neighbourhood radius (1–3). Ownership links do not count as a hop. */
  hops: number;
  /** Pod groups the user expanded. */
  expanded: ReadonlySet<string>;
  /** Kubernetes kinds hidden by the filter chips. */
  hiddenKinds: ReadonlySet<string>;
  /** Above this many nodes the least important ones are aggregated. */
  maxNodes: number;
}

export interface KindCount {
  kind: string;
  kindKey: string;
  count: number;
}

export interface TopologyView {
  nodes: TopoNode[];
  edges: TopoEdge[];
  /** Objects in scope before filters and the cap. */
  total: number;
  /** Relationships between those objects. */
  relationships: number;
  /** Objects folded into "+N more" nodes by the cap. */
  aggregated: number;
  /** Kinds in scope (before the kind filter) for the filter chips. */
  kinds: KindCount[];
  /** Distance from the root per node id (neighbourhood mode only). */
  distance: ReadonlyMap<string, number>;
}

export const DEFAULT_MAX_NODES = 400;

/** Reverse traversal through these hubs would pull in unrelated objects (every pod on a node). */
const HUB_EDGES = new Set<EdgeKind>(['runs-on', 'identity', 'class', 'role-ref']);

function adjacency(edges: readonly TopoEdge[]) {
  const out = new Map<string, TopoEdge[]>();
  const inc = new Map<string, TopoEdge[]>();
  for (const e of edges) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    (inc.get(e.to) ?? inc.set(e.to, []).get(e.to)!).push(e);
  }
  return { out, inc };
}

/**
 * Objects within `hops` of the root. Ownership links are free — up to the
 * owners, and down to what an object owns — so a workload, its ReplicaSets
 * and pods count as one unit. Coming back down from an owner reached on
 * the way up costs a hop (a Node's pods do not pull in every sibling pod on
 * other nodes). Hubs (Nodes, service accounts, classes, cluster roles) are
 * only expanded from the root.
 */
export function neighbourhood(graph: TopoGraph, rootId: string, hops: number): Map<string, number> {
  const dist = new Map<string, number>();
  if (!graph.nodes.has(rootId)) return dist;
  const { out, inc } = adjacency(graph.edges);
  // States: node id + whether it was reached by walking up an owner link.
  const best = new Map<string, number>();
  const key = (id: string, up: boolean) => (up ? `^${id}` : id);
  const deque: Array<[string, boolean]> = [[rootId, false]];
  best.set(key(rootId, false), 0);
  dist.set(rootId, 0);
  // 0-1 BFS: free steps go to the front of the queue.
  while (deque.length) {
    const [u, up] = deque.shift()!;
    const du = best.get(key(u, up))!;
    const visit = (v: string, cost: number, nextUp: boolean) => {
      const dv = du + cost;
      if (dv > hops) return;
      const k = key(v, nextUp);
      const known = best.get(k);
      if (known !== undefined && known <= dv) return;
      best.set(k, dv);
      if (dv < (dist.get(v) ?? Infinity)) dist.set(v, dv);
      if (cost === 0) deque.unshift([v, nextUp]);
      else deque.push([v, nextUp]);
    };
    for (const e of out.get(u) ?? []) {
      if (e.kind === 'owns') visit(e.to, up ? 1 : 0, false);
      else visit(e.to, 1, false);
    }
    for (const e of inc.get(u) ?? []) {
      if (e.kind === 'owns') {
        visit(e.from, 0, true);
        continue;
      }
      if (u !== rootId && HUB_EDGES.has(e.kind)) continue;
      visit(e.from, 1, false);
    }
  }
  return dist;
}

/**
 * Namespace map scope: every namespaced object, plus cluster-scoped objects
 * related to them (a Node running a pod, the PV of a claim) and what those
 * reference (the StorageClass of that PV, the ClusterRole of a binding).
 */
export function scopedNodeIds(graph: TopoGraph): Set<string> {
  const keep = new Set<string>();
  for (const n of graph.nodes.values()) if (!isClusterScopedKind(n.kind)) keep.add(n.id);
  const { out } = adjacency(graph.edges);
  const queue: string[] = [];
  for (const e of graph.edges) {
    const a = graph.nodes.get(e.from);
    const b = graph.nodes.get(e.to);
    if (!a || !b) continue;
    if (keep.has(a.id) && !keep.has(b.id) && isClusterScopedKind(b.kind)) queue.push(b.id);
    if (keep.has(b.id) && !keep.has(a.id) && isClusterScopedKind(a.kind)) queue.push(a.id);
  }
  while (queue.length) {
    const id = queue.shift()!;
    if (keep.has(id)) continue;
    keep.add(id);
    for (const e of out.get(id) ?? []) if (!keep.has(e.to)) queue.push(e.to);
  }
  return keep;
}

function induced(graph: TopoGraph, ids: ReadonlySet<string>) {
  const nodes = [...ids].map((id) => graph.nodes.get(id)!).filter(Boolean);
  const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  return { nodes, edges };
}

function dedupe(edges: TopoEdge[]): TopoEdge[] {
  const seen = new Set<string>();
  const out: TopoEdge[] = [];
  for (const e of edges) {
    if (e.from === e.to) continue;
    const key = `${e.from}>${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...e, id: `${key}:${e.kind}` });
  }
  return out;
}

function remap(edges: readonly TopoEdge[], map: ReadonlyMap<string, string>): TopoEdge[] {
  return dedupe(
    edges.map((e) => ({ ...e, from: map.get(e.from) ?? e.from, to: map.get(e.to) ?? e.to })),
  );
}

/**
 * Hide kinds. Ownership chains through hidden nodes are bridged, so hiding
 * ReplicaSets still links Deployments to their pods.
 *
 * Linear in nodes + edges (+ the bridged edges): the live edges sit in one
 * insertion-ordered map keyed `from>to` with per-node incoming / outgoing
 * key sets, so removing a hidden node only touches its own edges. Hidden
 * nodes are bridged one at a time in `compareNodes` order and the first edge
 * of a pair wins, exactly like the list-rebuilding version this replaced
 * (same edges, order and ids).
 */
export function hideKinds(
  nodes: readonly TopoNode[],
  edges: readonly TopoEdge[],
  hidden: ReadonlySet<string>,
  keepId: string | null,
): { nodes: TopoNode[]; edges: TopoEdge[] } {
  if (!hidden.size) return { nodes: [...nodes], edges: [...edges] };
  const drop = nodes.filter((n) => hidden.has(n.kind) && n.id !== keepId).sort(compareNodes);
  if (!drop.length) return { nodes: [...nodes], edges: [...edges] };
  const live = new Map<string, TopoEdge>();
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  const keysOf = (index: Map<string, Set<string>>, id: string) => {
    let set = index.get(id);
    if (!set) index.set(id, (set = new Set()));
    return set;
  };
  const add = (from: string, to: string, kind: EdgeKind) => {
    if (from === to) return;
    const key = `${from}>${to}`;
    if (live.has(key)) return;
    live.set(key, { id: `${key}:${kind}`, from, to, kind });
    keysOf(outgoing, from).add(key);
    keysOf(incoming, to).add(key);
  };
  for (const e of edges) add(e.from, e.to, e.kind);
  for (const h of drop) {
    const ins: TopoEdge[] = [];
    const outs: TopoEdge[] = [];
    for (const key of incoming.get(h.id) ?? []) {
      const e = live.get(key)!;
      if (e.kind === 'owns') ins.push(e);
      live.delete(key);
      outgoing.get(e.from)?.delete(key);
    }
    for (const key of outgoing.get(h.id) ?? []) {
      const e = live.get(key)!;
      if (e.kind === 'owns') outs.push(e);
      live.delete(key);
      incoming.get(e.to)?.delete(key);
    }
    incoming.delete(h.id);
    outgoing.delete(h.id);
    for (const a of ins) for (const b of outs) add(a.from, b.to, 'owns');
  }
  const dropped = new Set(drop.map((n) => n.id));
  return { nodes: nodes.filter((n) => !dropped.has(n.id)), edges: [...live.values()] };
}

/** Collapse the pods of each controller into one group node (2+ pods, not expanded). */
export function groupPods(
  nodes: readonly TopoNode[],
  edges: readonly TopoEdge[],
  expanded: ReadonlySet<string>,
  keepId: string | null,
): { nodes: TopoNode[]; edges: TopoEdge[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ownerOf = new Map<string, string>();
  for (const e of edges) {
    if (e.kind !== 'owns' || ownerOf.has(e.to)) continue;
    if (byId.get(e.to)?.kind === 'Pod') ownerOf.set(e.to, e.from);
  }
  const members = new Map<string, TopoNode[]>();
  for (const n of nodes) {
    if (n.kind !== 'Pod' || n.id === keepId || n.group || n.aggregate) continue;
    const owner = ownerOf.get(n.id);
    if (!owner || expanded.has(groupId(owner))) continue;
    const list = members.get(owner) ?? [];
    list.push(n);
    members.set(owner, list);
  }
  const map = new Map<string, string>();
  const groups: TopoNode[] = [];
  for (const [owner, pods] of members) {
    if (pods.length < 2) continue;
    const id = groupId(owner);
    const tones: Partial<Record<StatusTone, number>> = {};
    for (const p of pods) if (p.tone) tones[p.tone] = (tones[p.tone] ?? 0) + 1;
    const first = pods[0]!;
    const ownerNode = byId.get(owner);
    groups.push({
      id,
      kind: 'Pod',
      kindKey: first.kindKey,
      gvk: first.gvk,
      namespace: first.namespace,
      name: ownerNode?.name ?? owner.split('|')[2] ?? owner,
      uid: null,
      tier: TIER.pod,
      tone: worstTone(pods.map((p) => p.tone)),
      status: String(pods.length),
      group: {
        ownerId: owner,
        count: pods.length,
        tones,
        members: pods.map((p) => p.id).sort(),
      },
    });
    for (const p of pods) map.set(p.id, id);
  }
  if (!groups.length) return { nodes: [...nodes], edges: [...edges] };
  return {
    nodes: [...nodes.filter((n) => !map.has(n.id)), ...groups],
    edges: remap(edges, map),
  };
}

/** Lower is more important when the map must be trimmed. */
const TIER_PRIORITY: Record<number, number> = {
  [TIER.route]: 0,
  [TIER.service]: 1,
  [TIER.workload]: 1,
  [TIER.pod]: 2,
  [TIER.controller]: 3,
  [TIER.entry]: 3,
  [TIER.config]: 4,
  [TIER.node]: 5,
  [TIER.binding]: 6,
  [TIER.cluster]: 6,
};

/**
 * Keep at most `max` nodes: the root, the nearest and most important ones
 * stay, the rest fold into one "+N more" node per kind.
 */
export function capNodes(
  nodes: readonly TopoNode[],
  edges: readonly TopoEdge[],
  max: number,
  keepId: string | null,
  distance: ReadonlyMap<string, number>,
): { nodes: TopoNode[]; edges: TopoEdge[]; aggregated: number } {
  if (nodes.length <= max) return { nodes: [...nodes], edges: [...edges], aggregated: 0 };
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const ranked = [...nodes].sort(
    (a, b) =>
      Number(b.id === keepId) - Number(a.id === keepId) ||
      (distance.get(a.id) ?? 0) - (distance.get(b.id) ?? 0) ||
      (TIER_PRIORITY[a.tier] ?? 7) - (TIER_PRIORITY[b.tier] ?? 7) ||
      (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
      compareNodes(a, b),
  );
  // Each folded kind costs one slot; iterate until the bucket count settles.
  let keep = max;
  let overflow: TopoNode[] = [];
  for (let i = 0; i < 8; i++) {
    overflow = ranked.slice(keep);
    const buckets = new Set(overflow.map((n) => n.kindKey)).size;
    const next = Math.max(1, max - buckets);
    if (next === keep) break;
    keep = next;
  }
  overflow = ranked.slice(keep);
  const map = new Map<string, string>();
  const buckets = new Map<string, TopoNode>();
  let aggregated = 0;
  for (const n of overflow) {
    const id = `more|${n.kindKey}`;
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = {
        id,
        kind: n.kind,
        kindKey: n.kindKey,
        gvk: n.gvk,
        namespace: null,
        name: '',
        uid: null,
        tier: n.tier,
        tone: null,
        status: '',
        aggregate: { count: 0 },
      };
      buckets.set(id, bucket);
    }
    const count = n.group?.count ?? n.aggregate?.count ?? 1;
    bucket.aggregate!.count += count;
    aggregated += count;
    map.set(n.id, id);
  }
  return {
    nodes: [...ranked.slice(0, keep), ...buckets.values()],
    edges: remap(edges, map),
    aggregated,
  };
}

function kindCounts(nodes: readonly TopoNode[]): KindCount[] {
  const counts = new Map<string, KindCount>();
  for (const n of nodes) {
    const c = counts.get(n.kind) ?? { kind: n.kind, kindKey: n.kindKey, count: 0 };
    c.count++;
    counts.set(n.kind, c);
  }
  return [...counts.values()].sort(
    (a, b) => kindRank(a.kind) - kindRank(b.kind) || a.kind.localeCompare(b.kind),
  );
}

/** Graph → the nodes and edges one map shows. */
export function deriveView(graph: TopoGraph, opts: ViewOptions): TopologyView {
  const rootId = opts.rootId && graph.nodes.has(opts.rootId) ? opts.rootId : null;
  const distance = rootId
    ? neighbourhood(graph, rootId, Math.max(1, Math.min(3, opts.hops)))
    : new Map<string, number>();
  const scoped = induced(graph, rootId ? new Set(distance.keys()) : scopedNodeIds(graph));
  const related = new Set<string>();
  for (const e of scoped.edges) {
    related.add(e.from);
    related.add(e.to);
  }
  const active = scoped.nodes.filter(
    (n) => n.id === rootId || (!n.inactive && (!n.quiet || related.has(n.id))),
  );
  const activeIds = new Set(active.map((n) => n.id));
  const base = {
    nodes: active,
    edges: scoped.edges.filter((e) => activeIds.has(e.from) && activeIds.has(e.to)),
  };
  const kinds = kindCounts(base.nodes);
  const visible = hideKinds(base.nodes, base.edges, opts.hiddenKinds, rootId);
  const grouped = groupPods(visible.nodes, visible.edges, opts.expanded, rootId);
  const capped = capNodes(grouped.nodes, grouped.edges, opts.maxNodes, rootId, distance);
  return {
    nodes: capped.nodes.sort(compareNodes),
    edges: capped.edges,
    total: base.nodes.length,
    relationships: base.edges.length,
    aggregated: capped.aggregated,
    kinds,
    distance,
  };
}

/** Case-insensitive name / kind / namespace match for the search box. */
export function matchNodes(nodes: readonly TopoNode[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return nodes
    .filter(
      (n) =>
        n.name.toLowerCase().includes(q) ||
        n.kind.toLowerCase() === q ||
        (n.namespace ?? '').toLowerCase() === q,
    )
    .map((n) => n.id);
}
