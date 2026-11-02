import type { KubeObject } from '@/types';
import { asArray, asObject, isObject, spec } from '../accessors';
import { matchesSelector, parseSelector } from '../selectors';
import { GATEWAY_GROUP, isRouteKind, routeHasHostnames } from './kinds';
import {
  findCondition,
  gatewayListeners,
  grantFrom,
  grantTo,
  isGatewayParent,
  isServiceRef,
  routeBackendRefs,
  routeHostnames,
  routeParentRefs,
  parentStatusFor,
  routeParentStatuses,
  type BackendRef,
  type Listener,
  type ParentRef,
  type RouteGroupKind,
  type RouteParentStatus,
} from './model';

/**
 * Reference resolution over the watched lists: route → Gateway / listener
 * (sectionName, port, allowedRoutes namespaces and kinds, hostname
 * intersection, as the Gateway API spec defines attachment), route →
 * backend Service and port, and ReferenceGrant checks for cross-namespace
 * references. Pure and deterministic; a list that has not synced makes the
 * answers about it `null` ("unknown") instead of "missing".
 */

export interface GatewayIndexInput {
  classes: readonly KubeObject[];
  gateways: readonly KubeObject[];
  routes: readonly KubeObject[];
  grants: readonly KubeObject[];
  services: readonly KubeObject[];
  namespaces: readonly KubeObject[];
  /** Lists that are complete; references into an incomplete one are not reported missing. */
  known?: Partial<Record<KnownList, boolean>>;
}

export type KnownList = 'classes' | 'gateways' | 'routes' | 'services' | 'namespaces' | 'grants';

export interface GatewayIndex {
  classes: ReadonlyMap<string, KubeObject>;
  gateways: ReadonlyMap<string, KubeObject>;
  services: ReadonlyMap<string, KubeObject>;
  namespaces: ReadonlyMap<string, KubeObject>;
  /** ReferenceGrants by their namespace (the referent's). */
  grants: ReadonlyMap<string, readonly KubeObject[]>;
  routes: readonly KubeObject[];
  /** Routes naming each Gateway (`ns/name`) as a parent. */
  routesByGateway: ReadonlyMap<string, readonly KubeObject[]>;
  known: Record<KnownList, boolean>;
}

const nsKey = (namespace: string, name: string) => `${namespace}/${name}`;

function byNsName(list: readonly KubeObject[]): Map<string, KubeObject> {
  return new Map(list.map((o) => [nsKey(o.metadata.namespace ?? '', o.metadata.name), o]));
}

export function buildGatewayIndex(input: GatewayIndexInput): GatewayIndex {
  const add = (map: Map<string, KubeObject[]>, key: string, o: KubeObject) => {
    const list = map.get(key);
    if (list) list.push(o);
    else map.set(key, [o]);
  };
  const grants = new Map<string, KubeObject[]>();
  for (const g of input.grants) add(grants, g.metadata.namespace ?? '', g);
  const routesByGateway = new Map<string, KubeObject[]>();
  for (const route of input.routes) {
    if (!isRouteKind(route.kind)) continue;
    const keys = new Set(
      routeParentRefs(route)
        .filter(isGatewayParent)
        .map((p) => nsKey(p.namespace, p.name)),
    );
    for (const key of keys) add(routesByGateway, key, route);
  }
  return {
    classes: new Map(input.classes.map((c) => [c.metadata.name, c])),
    gateways: byNsName(input.gateways),
    services: byNsName(input.services),
    namespaces: new Map(input.namespaces.map((n) => [n.metadata.name, n])),
    grants,
    routes: input.routes,
    routesByGateway,
    known: {
      classes: input.known?.classes ?? true,
      gateways: input.known?.gateways ?? true,
      routes: input.known?.routes ?? true,
      services: input.known?.services ?? true,
      namespaces: input.known?.namespaces ?? true,
      grants: input.known?.grants ?? true,
    },
  };
}

export function gatewayOf(index: GatewayIndex, namespace: string, name: string) {
  return index.gateways.get(nsKey(namespace, name)) ?? null;
}

export function serviceOf(index: GatewayIndex, namespace: string, name: string) {
  return index.services.get(nsKey(namespace, name)) ?? null;
}

// ---------------------------------------------------------------------------
// ReferenceGrant
// ---------------------------------------------------------------------------

export interface GrantSubject {
  group: string;
  kind: string;
  namespace: string;
}

export interface GrantTarget {
  group: string;
  kind: string;
  namespace: string;
  name: string;
}

/**
 * The ReferenceGrant in the target's namespace that lets `from` reference
 * `to`, or `null`. Same-namespace references never need one.
 */
/** Whether `grant` (in `to.namespace`) lets `from` reference `to`. */
export function grantPermits(grant: KubeObject, from: GrantSubject, to: GrantTarget): boolean {
  if ((grant.metadata.namespace ?? '') !== to.namespace) return false;
  const fromOk = grantFrom(grant).some(
    (f) => f.group === from.group && f.kind === from.kind && f.namespace === from.namespace,
  );
  return (
    fromOk &&
    grantTo(grant).some(
      (t) => t.group === to.group && t.kind === to.kind && (t.name === null || t.name === to.name),
    )
  );
}

export function grantFor(
  index: GatewayIndex,
  from: GrantSubject,
  to: GrantTarget,
): KubeObject | null {
  return (index.grants.get(to.namespace) ?? []).find((g) => grantPermits(g, from, to)) ?? null;
}

/**
 * `true` when a cross-namespace reference is permitted (or not cross-namespace),
 * `false` when no grant allows it, `null` when grants could not be read.
 */
export function referencePermitted(
  index: GatewayIndex,
  from: GrantSubject,
  to: GrantTarget,
): boolean | null {
  if (from.namespace === to.namespace) return true;
  if (grantFor(index, from, to)) return true;
  return index.known.grants ? false : null;
}

// ---------------------------------------------------------------------------
// Hostnames
// ---------------------------------------------------------------------------

const norm = (h: string) => h.trim().toLowerCase().replace(/\.$/, '');

/**
 * Whether two Gateway API hostnames can both match a request: exact names
 * compare equal; `*.example.com` matches any name with that suffix (one or
 * more labels, never `example.com` itself); two wildcards intersect when
 * one suffix contains the other.
 */
export function hostnamesIntersect(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  const xw = x.startsWith('*.');
  const yw = y.startsWith('*.');
  if (!xw && !yw) return x === y;
  if (xw && yw) {
    const xs = x.slice(1);
    const ys = y.slice(1);
    return xs === ys || xs.endsWith(ys) || ys.endsWith(xs);
  }
  const [wild, exact] = xw ? [x, y] : [y, x];
  return exact.endsWith(wild.slice(1)) && exact.length > wild.length - 1;
}

/** Route hostnames that a listener accepts (all when either side sets none). */
export function matchingHostnames(listenerHostname: string | null, hostnames: readonly string[]) {
  if (!listenerHostname || !hostnames.length) return [...hostnames];
  return hostnames.filter((h) => hostnamesIntersect(listenerHostname, h));
}

// ---------------------------------------------------------------------------
// Parents (route → Gateway / listener)
// ---------------------------------------------------------------------------

/** Route kinds a listener accepts by default, by protocol (core protocols only). */
export function defaultRouteKinds(protocol: string, tlsMode: string | null): string[] | null {
  switch (protocol) {
    case 'HTTP':
    case 'HTTPS':
      return ['HTTPRoute', 'GRPCRoute'];
    case 'TLS':
      return tlsMode === 'Terminate' ? ['TLSRoute', 'TCPRoute'] : ['TLSRoute'];
    case 'TCP':
      return ['TCPRoute'];
    case 'UDP':
      return ['UDPRoute'];
    default:
      // Implementation-specific protocols (`example.com/proto`): not checked.
      return null;
  }
}

/** The route kinds a listener accepts: its status, else `allowedRoutes.kinds`, else the defaults. */
export function listenerKinds(l: Listener): RouteGroupKind[] | null {
  if (l.status?.supportedKinds.length) return l.status.supportedKinds;
  if (l.allowedKinds.length) return l.allowedKinds;
  const defaults = defaultRouteKinds(l.protocol, l.tls?.mode ?? null);
  return defaults ? defaults.map((kind) => ({ group: GATEWAY_GROUP, kind })) : null;
}

export type ListenerMismatch = 'namespace' | 'kind' | 'hostname';

export interface ListenerMatch {
  listener: Listener;
  /** Every check passed (or could not be evaluated). */
  ok: boolean;
  mismatches: ListenerMismatch[];
  /** The namespace selector could not be evaluated (Namespaces not readable). */
  namespaceUnknown: boolean;
  /** Route hostnames this listener accepts (route kinds with hostnames only). */
  hostnames: string[];
}

function emptySelector(raw: Record<string, unknown> | null): boolean {
  if (!raw) return true;
  return !Object.keys(asObject(raw.matchLabels)).length && !asArray(raw.matchExpressions).length;
}

/** Whether routes in `routeNs` may attach (allowedRoutes.namespaces); `null` = unknown. */
export function namespaceAllowed(
  index: GatewayIndex,
  listener: Listener,
  gatewayNs: string,
  routeNs: string,
): boolean | null {
  switch (listener.allowedFrom) {
    case 'All':
      return true;
    case 'Selector': {
      if (emptySelector(listener.allowedSelector)) return true;
      const ns = index.namespaces.get(routeNs);
      if (!ns) return index.known.namespaces ? false : null;
      return matchesSelector(parseSelector(listener.allowedSelector), ns.metadata.labels);
    }
    case 'Same':
      return routeNs === gatewayNs;
    default:
      // A value this version of the API does not define: the controller decides.
      return null;
  }
}

export function matchListener(
  index: GatewayIndex,
  route: KubeObject,
  gateway: KubeObject,
  listener: Listener,
): ListenerMatch {
  const mismatches: ListenerMismatch[] = [];
  const allowed = namespaceAllowed(
    index,
    listener,
    gateway.metadata.namespace ?? '',
    route.metadata.namespace ?? '',
  );
  if (allowed === false) mismatches.push('namespace');
  const kinds = listenerKinds(listener);
  if (kinds && !kinds.some((k) => k.group === GATEWAY_GROUP && k.kind === route.kind))
    mismatches.push('kind');
  let hostnames: string[] = [];
  if (routeHasHostnames(route.kind)) {
    const own = routeHostnames(route);
    hostnames = matchingHostnames(listener.hostname, own);
    if (own.length && !hostnames.length) mismatches.push('hostname');
  }
  return {
    listener,
    ok: mismatches.length === 0,
    mismatches,
    namespaceUnknown: allowed === null,
    hostnames,
  };
}

export type ParentProblem =
  | 'gateway-missing'
  | 'unchecked-kind'
  | 'no-section'
  | 'no-port'
  | 'no-listener'
  | 'no-matching-listener';

export interface ResolvedParent {
  ref: ParentRef;
  /** `null` when not a Gateway, or not found (see `problem`). */
  gateway: KubeObject | null;
  /** Candidate listeners (after sectionName / port) with their checks. */
  listeners: ListenerMatch[];
  /** At least one listener accepts the route by the spec checks. */
  attachable: boolean;
  status: RouteParentStatus | null;
  problem: ParentProblem | null;
}

function statusFor(route: KubeObject, ref: ParentRef): RouteParentStatus | null {
  return parentStatusFor(routeParentStatuses(route), ref);
}

export function resolveParent(
  index: GatewayIndex,
  route: KubeObject,
  ref: ParentRef,
): ResolvedParent {
  const status = statusFor(route, ref);
  const base = { ref, status, listeners: [] as ListenerMatch[], attachable: false };
  if (!isGatewayParent(ref))
    // Mesh parents (GAMMA: a Service) and ListenerSets: only their status is read.
    return { ...base, gateway: null, attachable: true, problem: 'unchecked-kind' };
  const gateway = gatewayOf(index, ref.namespace, ref.name);
  if (!gateway)
    return {
      ...base,
      gateway: null,
      attachable: !index.known.gateways,
      problem: index.known.gateways ? 'gateway-missing' : null,
    };
  const all = gatewayListeners(gateway);
  let candidates = all;
  if (ref.sectionName) candidates = candidates.filter((l) => l.name === ref.sectionName);
  if (!candidates.length && ref.sectionName) return { ...base, gateway, problem: 'no-section' };
  if (ref.port !== null) candidates = candidates.filter((l) => l.port === ref.port);
  if (!candidates.length && ref.port !== null) return { ...base, gateway, problem: 'no-port' };
  if (!candidates.length) return { ...base, gateway, problem: 'no-listener' };
  const listeners = candidates.map((l) => matchListener(index, route, gateway, l));
  const attachable = listeners.some((m) => m.ok);
  return {
    ...base,
    gateway,
    listeners,
    attachable,
    problem: attachable ? null : 'no-matching-listener',
  };
}

export function resolveParents(index: GatewayIndex, route: KubeObject): ResolvedParent[] {
  return routeParentRefs(route).map((ref) => resolveParent(index, route, ref));
}

// ---------------------------------------------------------------------------
// Backends (route → Service)
// ---------------------------------------------------------------------------

export type BackendProblem =
  'service-missing' | 'port-missing' | 'port-unknown' | 'not-permitted' | 'unchecked-kind';

export interface ResolvedBackend {
  ref: BackendRef;
  service: KubeObject | null;
  crossNamespace: boolean;
  /** The grant permitting a cross-namespace reference. */
  grant: KubeObject | null;
  problems: BackendProblem[];
}

export function servicePorts(svc: KubeObject): number[] {
  return asArray(spec(svc).ports)
    .filter(isObject)
    .map((p) => (typeof p.port === 'number' ? p.port : 0))
    .filter((p) => p > 0);
}

export function resolveBackend(
  index: GatewayIndex,
  route: KubeObject,
  ref: BackendRef,
): ResolvedBackend {
  const routeNs = route.metadata.namespace ?? '';
  const crossNamespace = ref.namespace !== routeNs;
  const problems: BackendProblem[] = [];
  let grant: KubeObject | null = null;
  if (crossNamespace) {
    grant = grantFor(
      index,
      { group: GATEWAY_GROUP, kind: route.kind, namespace: routeNs },
      { group: ref.group, kind: ref.kind, namespace: ref.namespace, name: ref.name },
    );
    if (!grant && index.known.grants) problems.push('not-permitted');
  }
  if (!isServiceRef(ref)) {
    problems.push('unchecked-kind');
    return { ref, service: null, crossNamespace, grant, problems };
  }
  const service = serviceOf(index, ref.namespace, ref.name);
  if (ref.port === null) problems.push('port-missing');
  if (!service) {
    if (index.known.services) problems.push('service-missing');
  } else if (ref.port !== null && !servicePorts(service).includes(ref.port)) {
    problems.push('port-unknown');
  }
  return { ref, service, crossNamespace, grant, problems };
}

export function resolveBackends(index: GatewayIndex, route: KubeObject): ResolvedBackend[] {
  return routeBackendRefs(route).map((ref) => resolveBackend(index, route, ref));
}

// ---------------------------------------------------------------------------
// Gateway side: routes attached per listener
// ---------------------------------------------------------------------------

export interface Attachment {
  route: KubeObject;
  parent: ResolvedParent;
  /** Listener names the spec checks accept the route on. */
  listeners: string[];
  /** The Gateway's controller accepted the route for this parent. */
  accepted: boolean | null;
}

/** Every route that names `gateway` as a parent, with what the checks and the status say. */
export function routesOf(index: GatewayIndex, gateway: KubeObject): Attachment[] {
  const ns = gateway.metadata.namespace ?? '';
  const name = gateway.metadata.name;
  const out: Attachment[] = [];
  for (const route of index.routesByGateway.get(nsKey(ns, name)) ?? []) {
    for (const ref of routeParentRefs(route)) {
      if (!isGatewayParent(ref) || ref.namespace !== ns || ref.name !== name) continue;
      const parent = resolveParent(index, route, ref);
      const accepted = parent.status
        ? (findCondition(parent.status.conditions, 'Accepted')?.status ?? null) === 'True'
        : null;
      out.push({
        route,
        parent,
        listeners: parent.listeners.filter((m) => m.ok).map((m) => m.listener.name),
        accepted,
      });
    }
  }
  return out.sort(
    (a, b) =>
      a.route.kind.localeCompare(b.route.kind) ||
      (a.route.metadata.namespace ?? '').localeCompare(b.route.metadata.namespace ?? '') ||
      a.route.metadata.name.localeCompare(b.route.metadata.name),
  );
}

/** Gateways of a GatewayClass. */
export function gatewaysOfClass(index: GatewayIndex, className: string): KubeObject[] {
  return [...index.gateways.values()]
    .filter((g) => asObject(g.spec).gatewayClassName === className)
    .sort(
      (a, b) =>
        (a.metadata.namespace ?? '').localeCompare(b.metadata.namespace ?? '') ||
        a.metadata.name.localeCompare(b.metadata.name),
    );
}
