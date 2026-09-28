import { describe, expect, it } from 'vitest';
import {
  compareNodes,
  nodeId,
  tierOf,
  type TopoEdge,
  type TopoGraph,
  type TopoNode,
} from './model';
import { hideKinds } from './view';

// The quadratic implementation `hideKinds` replaced, copied verbatim (with the
// private `dedupe` it calls). It is the oracle for the linear one.
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

function hideKindsReference(
  nodes: readonly TopoNode[],
  edges: readonly TopoEdge[],
  hidden: ReadonlySet<string>,
  keepId: string | null,
): { nodes: TopoNode[]; edges: TopoEdge[] } {
  if (!hidden.size) return { nodes: [...nodes], edges: [...edges] };
  const drop = nodes.filter((n) => hidden.has(n.kind) && n.id !== keepId).sort(compareNodes);
  if (!drop.length) return { nodes: [...nodes], edges: [...edges] };
  let current = [...edges];
  for (const h of drop) {
    const ins = current.filter((e) => e.to === h.id && e.kind === 'owns');
    const outs = current.filter((e) => e.from === h.id && e.kind === 'owns');
    const bridged: TopoEdge[] = [];
    for (const a of ins)
      for (const b of outs) bridged.push({ id: '', from: a.from, to: b.to, kind: 'owns' });
    current = dedupe([...current.filter((e) => e.from !== h.id && e.to !== h.id), ...bridged]);
  }
  const dropped = new Set(drop.map((n) => n.id));
  return { nodes: nodes.filter((n) => !dropped.has(n.id)), edges: current };
}

const KEYS: Record<string, string> = {
  Deployment: 'deployments.apps',
  ReplicaSet: 'replicasets.apps',
  Pod: 'pods',
  ConfigMap: 'configmaps',
  Service: 'services',
};

function node(kind: string, ns: string, name: string): TopoNode {
  return {
    id: nodeId(KEYS[kind]!, ns, name),
    kind,
    kindKey: KEYS[kind]!,
    gvk: null,
    namespace: ns,
    name,
    uid: `${kind}/${name}`,
    tier: tierOf(kind),
    tone: null,
    status: '',
  };
}

/**
 * `n` Deployments → ReplicaSets → Pods (`owns`), each Pod mounting a
 * ConfigMap shared by a few chains. Among the first 60 chains, every fourth
 * Deployment keeps an old ReplicaSet, every fifth ReplicaSet runs two pods
 * (so bridging fans out) and a Service selects the pods of every third
 * chain. Ids are `kind|ns|name`.
 */
function chainGraph(n: number): TopoGraph {
  const nodes = new Map<string, TopoNode>();
  const edges: TopoEdge[] = [];
  const add = (x: TopoNode) => {
    if (!nodes.has(x.id)) nodes.set(x.id, x);
    return x.id;
  };
  const link = (from: string, to: string, kind: TopoEdge['kind']) =>
    edges.push({ id: `${from}>${to}:${kind}`, from, to, kind });
  for (let i = 0; i < n; i++) {
    const ns = `ns${i % 5}`;
    const extras = i < 60;
    const d = add(node('Deployment', ns, `web-${i}`));
    const cm = add(node('ConfigMap', ns, `config-${i % 7}`));
    const svc = extras && i % 3 === 0 ? add(node('Service', ns, `svc-${i}`)) : null;
    for (let r = 0; r < (extras && i % 4 === 0 ? 2 : 1); r++) {
      const rs = add(node('ReplicaSet', ns, `web-${i}-${r}`));
      link(d, rs, 'owns');
      for (let p = 0; p < (extras && i % 5 === 0 ? 2 : 1); p++) {
        const pod = add(node('Pod', ns, `web-${i}-${r}-${p}`));
        link(rs, pod, 'owns');
        link(pod, cm, 'mounts');
        if (svc) link(svc, pod, 'selects');
      }
    }
  }
  return { nodes, edges };
}

describe('hideKinds', () => {
  it.each([10, 200, 2000])(
    'matches the previous implementation on %i chains',
    (n) => {
      const g = chainGraph(n);
      const list = [...g.nodes.values()];
      const norm = (x: ReturnType<typeof hideKinds>) =>
        [...x.edges].map((e) => `${e.from}>${e.to}:${e.kind}`).sort();
      for (const hidden of [['ReplicaSet'], ['Pod'], ['ReplicaSet', 'ConfigMap']]) {
        const got = hideKinds(list, g.edges, new Set(hidden), null);
        const want = hideKindsReference(list, g.edges, new Set(hidden), null);
        expect(norm(got)).toEqual(norm(want));
        // Same order and ids too: the layout is deterministic on its input.
        expect(got).toEqual(want);
      }
    },
    60_000,
  );
  it('bridges 2000 chains without quadratic work', () => {
    // The previous implementation needs seconds here; the linear one a few
    // milliseconds. The bound leaves a wide margin for slow machines.
    const g = chainGraph(2000);
    const list = [...g.nodes.values()];
    const started = performance.now();
    hideKinds(list, g.edges, new Set(['ReplicaSet']), null);
    hideKinds(list, g.edges, new Set(['Pod']), null);
    expect(performance.now() - started).toBeLessThan(300);
  });
  it('keeps the root even when its kind is hidden', () => {
    const g = chainGraph(3);
    const list = [...g.nodes.values()];
    const keep = nodeId('replicasets.apps', 'ns0', 'web-0-0');
    const got = hideKinds(list, g.edges, new Set(['ReplicaSet']), keep);
    expect(got).toEqual(hideKindsReference(list, g.edges, new Set(['ReplicaSet']), keep));
    expect(got.nodes.some((x) => x.id === keep)).toBe(true);
  });
});
