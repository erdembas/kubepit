import type { EdgeKind, TopoGraph } from '../topology/model';
import { coverageOf, type PortTarget } from './engine';
import type { Coverage, NpCluster, NpPod } from './model';
import { pairFor, targetsFor } from './summary';

/**
 * Resource map overlay: reachability from one pod to every pod on the map;
 * Services and controllers take the combined state of the pods they
 * select or own.
 */

export type ReachState = 'source' | 'allowed' | 'partial' | 'denied';

const STATE: Record<Coverage, ReachState> = { all: 'allowed', some: 'partial', none: 'denied' };

/** Combined state of several pods (the source itself does not count). */
export function aggregateReach(states: Iterable<ReachState | undefined>): ReachState | undefined {
  let allowed = false;
  let denied = false;
  let partial = false;
  let source = false;
  for (const s of states) {
    if (s === 'allowed') allowed = true;
    else if (s === 'denied') denied = true;
    else if (s === 'partial') partial = true;
    else if (s === 'source') source = true;
  }
  if (partial || (allowed && denied)) return 'partial';
  if (allowed) return 'allowed';
  if (denied) return 'denied';
  return source ? 'source' : undefined;
}

const DOWNSTREAM: ReadonlySet<EdgeKind> = new Set(['owns', 'selects']);

export function reachOverlay(
  graph: TopoGraph,
  cluster: NpCluster,
  source: NpPod,
  port: PortTarget | null,
): Map<string, ReachState> {
  const byUid = new Map<string, NpPod>();
  for (const pod of cluster.pods) if (pod.uid) byUid.set(pod.uid, pod);
  const out = new Map<string, ReachState>();
  for (const node of graph.nodes.values()) {
    if (node.kind !== 'Pod' || !node.uid) continue;
    const pod = byUid.get(node.uid);
    if (!pod) continue;
    if (pod.id === source.id) {
      out.set(node.id, 'source');
      continue;
    }
    const coverage = coverageOf(pairFor(cluster, source, pod).ports, targetsFor(pod, port));
    out.set(node.id, STATE[coverage]);
  }
  const children = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!DOWNSTREAM.has(e.kind)) continue;
    const list = children.get(e.from);
    if (list) list.push(e.to);
    else children.set(e.from, [e.to]);
  }
  for (const node of graph.nodes.values()) {
    if (out.has(node.id) || !children.has(node.id)) continue;
    const pods: string[] = [];
    const seen = new Set<string>([node.id]);
    let frontier = [node.id];
    for (let depth = 0; depth < 4 && frontier.length; depth++) {
      const next: string[] = [];
      for (const id of frontier)
        for (const child of children.get(id) ?? []) {
          if (seen.has(child)) continue;
          seen.add(child);
          if (graph.nodes.get(child)?.kind === 'Pod') pods.push(child);
          else next.push(child);
        }
      frontier = next;
    }
    const state = aggregateReach(pods.map((id) => out.get(id)));
    if (state) out.set(node.id, state);
  }
  return out;
}
