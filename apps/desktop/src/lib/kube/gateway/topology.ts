import type { KubeObject } from '@/types';
import type { StatusTone } from '../pods';
import { implementationName } from './implementations';
import { GATEWAY_GROUP, isRouteKind } from './kinds';
import {
  GATEWAY_BUCKET_TONE,
  ROUTE_BUCKET_TONE,
  classController,
  conditionsOf,
  conditionTone,
  findCondition,
  gatewayBucket,
  gatewayClassName,
  gatewayListeners,
  isGatewayParent,
  routeHostnames,
  routeParentRefs,
  routeSummary,
} from './model';
import { resolveBackends, resolveParents, type GatewayIndex } from './refs';

/**
 * The traffic topology of the Gateway API objects in scope: GatewayClass →
 * Gateway → route → backend, laid out in four columns. Rows follow the
 * column to the left (a gateway sits next to its class, a route next to its
 * first gateway, a backend next to its first route), so edges mostly run
 * straight. Pure: the canvas only draws what this returns.
 */

export type TopoColumn = 0 | 1 | 2 | 3;

export interface GwTopoNode {
  id: string;
  column: TopoColumn;
  kind: string;
  /** For links: apiVersion of the object (or the referenced kind's). */
  apiVersion: string;
  name: string;
  namespace: string | null;
  /** One line under the name (controller, listeners, hostnames, ports). */
  sub: string;
  tone: StatusTone;
  /** A reference to an object that does not exist. */
  missing: boolean;
  x: number;
  y: number;
}

export interface GwTopoEdge {
  id: string;
  from: string;
  to: string;
  tone: StatusTone;
  /** Mirror backends and parents the spec checks reject. */
  dashed: boolean;
  label: string;
}

export interface GwTopology {
  nodes: GwTopoNode[];
  edges: GwTopoEdge[];
  width: number;
  height: number;
}

export const NODE_W = 224;
export const NODE_H = 46;
const COL_GAP = 92;
const ROW_GAP = 14;
const PAD = 16;

const idOf = (kind: string, ns: string | null, name: string) => `${kind}|${ns ?? ''}|${name}`;

export interface TopologyScope {
  /** Namespaces whose Gateways and routes are shown; empty = all. */
  namespaces: readonly string[];
  /** Show only this object's neighbourhood (a Gateway, route or class id). */
  focus?: string | null;
}

export function buildGatewayTopology(index: GatewayIndex, scope: TopologyScope): GwTopology {
  const inScope = (ns: string | undefined | null) =>
    !scope.namespaces.length || scope.namespaces.includes(ns ?? '');
  const nodes = new Map<string, Omit<GwTopoNode, 'x' | 'y'>>();
  const edges = new Map<string, GwTopoEdge>();
  const addEdge = (e: Omit<GwTopoEdge, 'id'>) => {
    const id = `${e.from}>${e.to}`;
    const prev = edges.get(id);
    // Keep the worst tone when two references join the same pair.
    if (!prev || TONE_RANK[e.tone] < TONE_RANK[prev.tone]) edges.set(id, { id, ...e });
  };

  const routes = index.routes.filter((r) => isRouteKind(r.kind) && inScope(r.metadata.namespace));
  // A gateway outside the scope still shows when a route in scope uses it.
  const used = new Set(
    routes.flatMap((r) =>
      routeParentRefs(r)
        .filter(isGatewayParent)
        .map((p) => `${p.namespace}/${p.name}`),
    ),
  );
  const gateways = [...index.gateways.entries()]
    .filter(([key, g]) => inScope(g.metadata.namespace) || used.has(key))
    .map(([, g]) => g);

  for (const g of gateways) {
    const className = gatewayClassName(g);
    const cls = index.classes.get(className);
    const classId = idOf('GatewayClass', null, className);
    if (!nodes.has(classId))
      nodes.set(classId, {
        id: classId,
        column: 0,
        kind: 'GatewayClass',
        apiVersion: cls?.apiVersion ?? `${GATEWAY_GROUP}/v1`,
        name: className,
        namespace: null,
        sub: cls ? implementationName(classController(cls)) : '',
        tone: cls
          ? conditionTone(findCondition(conditionsOf((cls.status ?? {}).conditions), 'Accepted'))
          : index.known.classes
            ? 'error'
            : 'muted',
        missing: !cls && index.known.classes,
      });
    const gwId = idOf('Gateway', g.metadata.namespace ?? '', g.metadata.name);
    const listeners = gatewayListeners(g);
    nodes.set(gwId, {
      id: gwId,
      column: 1,
      kind: 'Gateway',
      apiVersion: g.apiVersion,
      name: g.metadata.name,
      namespace: g.metadata.namespace ?? null,
      sub: listeners.map((l) => `${l.protocol}:${l.port}`).join(' '),
      tone: GATEWAY_BUCKET_TONE[gatewayBucket(g)],
      missing: false,
    });
    addEdge({ from: classId, to: gwId, tone: 'muted', dashed: false, label: '' });
  }

  for (const r of routes) {
    const routeId = idOf(r.kind, r.metadata.namespace ?? '', r.metadata.name);
    const summary = routeSummary(r);
    nodes.set(routeId, {
      id: routeId,
      column: 2,
      kind: r.kind,
      apiVersion: r.apiVersion,
      name: r.metadata.name,
      namespace: r.metadata.namespace ?? null,
      sub: routeHostnames(r).join(', '),
      tone: ROUTE_BUCKET_TONE[summary.bucket],
      missing: false,
    });
    for (const p of resolveParents(index, r)) {
      if (!isGatewayParent(p.ref)) continue;
      const gwId = idOf('Gateway', p.ref.namespace, p.ref.name);
      if (!nodes.has(gwId))
        nodes.set(gwId, {
          id: gwId,
          column: 1,
          kind: 'Gateway',
          apiVersion: `${GATEWAY_GROUP}/v1`,
          name: p.ref.name,
          namespace: p.ref.namespace,
          sub: '',
          tone: p.problem === 'gateway-missing' ? 'error' : 'muted',
          missing: p.problem === 'gateway-missing',
        });
      const accepted = p.status ? findCondition(p.status.conditions, 'Accepted') : undefined;
      const tone: StatusTone =
        p.problem && p.problem !== 'unchecked-kind'
          ? 'error'
          : accepted
            ? conditionTone(accepted)
            : 'muted';
      addEdge({
        from: gwId,
        to: routeId,
        tone,
        dashed: !p.attachable,
        label: p.ref.sectionName ?? (p.ref.port !== null ? String(p.ref.port) : ''),
      });
    }
    for (const b of resolveBackends(index, r)) {
      const backendId = idOf(b.ref.kind, b.ref.namespace, b.ref.name);
      if (!nodes.has(backendId))
        nodes.set(backendId, {
          id: backendId,
          column: 3,
          kind: b.ref.kind,
          apiVersion: b.ref.group ? `${b.ref.group}/v1` : 'v1',
          name: b.ref.name,
          namespace: b.ref.namespace,
          sub: '',
          tone: b.problems.includes('service-missing') ? 'error' : 'muted',
          missing: b.problems.includes('service-missing'),
        });
      const node = nodes.get(backendId)!;
      if (b.ref.port !== null && !node.missing) {
        const ports = new Set(node.sub ? node.sub.split(' ') : []);
        ports.add(`:${b.ref.port}`);
        node.sub = [...ports].sort().join(' ');
      }
      const bad = b.problems.filter((x) => x !== 'unchecked-kind');
      addEdge({
        from: routeId,
        to: backendId,
        tone: bad.length ? 'error' : 'success',
        dashed: b.ref.mirror,
        label: b.ref.weight !== 1 ? `w${b.ref.weight}` : '',
      });
    }
  }

  let kept = [...nodes.values()];
  let keptEdges = [...edges.values()];
  if (scope.focus && nodes.has(scope.focus)) {
    const near = neighbourhood(scope.focus, keptEdges);
    kept = kept.filter((n) => near.has(n.id));
    keptEdges = keptEdges.filter((e) => near.has(e.from) && near.has(e.to));
  }
  return layout(kept, keptEdges);
}

function pushTo(map: Map<string, string[]>, key: string, value: string) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const TONE_RANK: Record<StatusTone, number> = {
  error: 0,
  warning: 1,
  info: 2,
  success: 3,
  muted: 4,
};

/**
 * Everything upstream and downstream of `id` (a route's gateways and class,
 * a gateway's routes and their backends), not siblings reached through a
 * shared node.
 */
function neighbourhood(id: string, edges: readonly GwTopoEdge[]): Set<string> {
  const down = new Map<string, string[]>();
  const up = new Map<string, string[]>();
  for (const e of edges) {
    pushTo(down, e.from, e.to);
    pushTo(up, e.to, e.from);
  }
  const out = new Set([id]);
  const walk = (adjacency: Map<string, string[]>) => {
    const seen = new Set([id]);
    const stack = [id];
    while (stack.length) {
      for (const next of adjacency.get(stack.pop()!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        out.add(next);
        stack.push(next);
      }
    }
  };
  walk(up);
  walk(down);
  return out;
}

function layout(nodes: Omit<GwTopoNode, 'x' | 'y'>[], edges: GwTopoEdge[]): GwTopology {
  const columns: Omit<GwTopoNode, 'x' | 'y'>[][] = [[], [], [], []];
  for (const n of nodes) columns[n.column]!.push(n);
  const row = new Map<string, number>();
  const name = (n: Omit<GwTopoNode, 'x' | 'y'>) => `${n.namespace ?? ''}/${n.name}`;
  // Column 0 by name; every later column by the smallest row of its left-hand neighbours.
  columns[0]!.sort((a, b) => name(a).localeCompare(name(b)));
  columns[0]!.forEach((n, i) => row.set(n.id, i));
  const incoming = new Map<string, string[]>();
  for (const e of edges) pushTo(incoming, e.to, e.from);
  for (let c = 1; c < 4; c++) {
    const parentRow = (n: Omit<GwTopoNode, 'x' | 'y'>) => {
      let best = Number.POSITIVE_INFINITY;
      for (const from of incoming.get(n.id) ?? [])
        if (row.has(from)) best = Math.min(best, row.get(from)!);
      return best;
    };
    const keyed = columns[c]!.map((n) => ({ n, p: parentRow(n) }));
    keyed.sort(
      (a, b) => a.p - b.p || a.n.kind.localeCompare(b.n.kind) || name(a.n).localeCompare(name(b.n)),
    );
    columns[c] = keyed.map((k) => k.n);
    columns[c]!.forEach((n, i) => row.set(n.id, i));
  }
  const tallest = Math.max(1, ...columns.map((c) => c.length));
  const colHeight = (count: number) => count * NODE_H + Math.max(0, count - 1) * ROW_GAP;
  const height = PAD * 2 + colHeight(tallest);
  const placed: GwTopoNode[] = [];
  columns.forEach((col, c) => {
    const offset = (colHeight(tallest) - colHeight(col.length)) / 2;
    col.forEach((n, i) =>
      placed.push({
        ...n,
        x: PAD + c * (NODE_W + COL_GAP),
        y: PAD + offset + i * (NODE_H + ROW_GAP),
      }),
    );
  });
  return {
    nodes: placed,
    edges: edges.sort((a, b) => a.id.localeCompare(b.id)),
    width: PAD * 2 + 4 * NODE_W + 3 * COL_GAP,
    height,
  };
}

/** The topology node id of an object (for focus and selection). */
export function topologyId(obj: Pick<KubeObject, 'kind' | 'metadata'>): string {
  return idOf(
    obj.kind,
    obj.kind === 'GatewayClass' ? null : (obj.metadata.namespace ?? ''),
    obj.metadata.name,
  );
}
