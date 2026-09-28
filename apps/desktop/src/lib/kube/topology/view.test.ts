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

/** Deterministic PRNG (mulberry32) so a failing graph can be replayed. */
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

const KINDS = Object.keys(KEYS);
const OTHER_EDGES: TopoEdge['kind'][] = ['mounts', 'selects', 'env'];

/**
 * A small random graph shaped like `buildTopology` output (one edge per
 * ordered pair, no self-loops) but with cycles, runs of same-kind owners and
 * mixed edge kinds between the same nodes, in a shuffled order.
 */
function randomGraph(seed: number) {
  const rand = prng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const count = 2 + Math.floor(rand() * 10);
  const nodes = Array.from({ length: count }, (_, i) =>
    node(pick(KINDS.slice(0, 2 + Math.floor(rand() * 4))), pick(['a', 'b']), `n${i}`),
  );
  const edges: TopoEdge[] = [];
  const density = 0.15 + rand() * 0.35;
  for (const from of nodes)
    for (const to of nodes) {
      if (from === to || rand() > density) continue;
      const kind = rand() < 0.7 ? 'owns' : pick(OTHER_EDGES);
      edges.push({ id: `${from.id}>${to.id}:${kind}`, from: from.id, to: to.id, kind });
    }
  for (let i = edges.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [edges[i], edges[j]] = [edges[j]!, edges[i]!];
  }
  const hidden = new Set(KINDS.filter(() => rand() < 0.4));
  const keepId = rand() < 0.3 ? pick(nodes).id : null;
  return { nodes, edges, hidden, keepId };
}

describe('hideKinds', () => {
  it.each([10, 200])('matches the previous implementation on %i chains', (n) => {
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
  });
  it('matches the previous implementation on 1600 random graphs', () => {
    for (let seed = 1; seed <= 1600; seed++) {
      const { nodes, edges, hidden, keepId } = randomGraph(seed);
      expect(hideKinds(nodes, edges, hidden, keepId), `seed ${seed}`).toEqual(
        hideKindsReference(nodes, edges, hidden, keepId),
      );
    }
  });
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
