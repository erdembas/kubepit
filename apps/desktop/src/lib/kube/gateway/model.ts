import type { KubeObject } from '@/types';
import { asArray, asNumber, asObject, asString, isObject, spec, status } from '../accessors';
import type { StatusTone } from '../pods';
import { GATEWAY_GROUP } from './kinds';

/**
 * Readers for Gateway API objects with the API's defaulting applied
 * (`parentRefs` default to a Gateway in the route's namespace, `backendRefs`
 * to a core Service, `allowedRoutes.namespaces.from` to `Same`), so the
 * reference checks and the UI see the same values a controller does.
 */

export interface GwCondition {
  type: string;
  status: string;
  reason: string;
  message: string;
  observedGeneration: number | null;
  lastTransitionTime: string;
}

export function conditionsOf(list: unknown): GwCondition[] {
  return asArray(list)
    .filter(isObject)
    .map((c) => ({
      type: asString(c.type),
      status: asString(c.status),
      reason: asString(c.reason),
      message: asString(c.message),
      observedGeneration: typeof c.observedGeneration === 'number' ? c.observedGeneration : null,
      lastTransitionTime: asString(c.lastTransitionTime),
    }));
}

export function findCondition(list: readonly GwCondition[], type: string): GwCondition | undefined {
  return list.find((c) => c.type === type);
}

/**
 * Tone of a condition whose `True` is good (Accepted, Programmed,
 * ResolvedRefs); `negative` flips it for conditions whose `True` is bad
 * (Conflicted, Overridden).
 */
export function conditionTone(c: GwCondition | undefined, negative = false): StatusTone {
  if (!c) return 'muted';
  if (c.status === 'True') return negative ? 'warning' : 'success';
  if (c.status === 'False') return negative ? 'success' : 'error';
  return 'warning';
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

export interface ParentRef {
  group: string;
  kind: string;
  namespace: string;
  name: string;
  sectionName: string | null;
  port: number | null;
}

/** A `parentRef` / `ancestorRef` with defaults: Gateway in `ns`. */
export function parentRefOf(raw: unknown, ns: string): ParentRef {
  const r = asObject(raw);
  const port = typeof r.port === 'number' ? r.port : null;
  return {
    group: typeof r.group === 'string' ? r.group : GATEWAY_GROUP,
    kind: asString(r.kind) || 'Gateway',
    namespace: asString(r.namespace) || ns,
    name: asString(r.name),
    sectionName: asString(r.sectionName) || null,
    port,
  };
}

export function sameParent(a: ParentRef, b: ParentRef): boolean {
  return (
    a.group === b.group &&
    a.kind === b.kind &&
    a.namespace === b.namespace &&
    a.name === b.name &&
    a.sectionName === b.sectionName &&
    a.port === b.port
  );
}

export function isGatewayParent(p: Pick<ParentRef, 'group' | 'kind'>): boolean {
  return p.group === GATEWAY_GROUP && p.kind === 'Gateway';
}

/** `ns/name` (`:section` / `:port` when set), for labels and keys. */
export function parentLabel(p: ParentRef): string {
  const base = `${p.namespace}/${p.name}`;
  return p.sectionName ? `${base}:${p.sectionName}` : p.port !== null ? `${base}:${p.port}` : base;
}

export function routeParentRefs(route: KubeObject): ParentRef[] {
  const ns = route.metadata.namespace ?? '';
  return asArray(spec(route).parentRefs).map((p) => parentRefOf(p, ns));
}

export interface BackendRef {
  group: string;
  kind: string;
  namespace: string;
  name: string;
  port: number | null;
  weight: number;
  /** Index of the rule in `spec.rules`. */
  rule: number;
  /** A `RequestMirror` filter's backend (receives copies, never answers). */
  mirror: boolean;
}

function backendRefOf(raw: unknown, ns: string, rule: number, mirror: boolean): BackendRef {
  const r = asObject(raw);
  return {
    group: asString(r.group),
    kind: asString(r.kind) || 'Service',
    namespace: asString(r.namespace) || ns,
    name: asString(r.name),
    port: typeof r.port === 'number' ? r.port : null,
    weight: typeof r.weight === 'number' ? r.weight : 1,
    rule,
    mirror,
  };
}

export const isServiceRef = (r: Pick<BackendRef, 'group' | 'kind'>) =>
  r.group === '' && r.kind === 'Service';

/** Rule backends plus RequestMirror backends (rule and backend filters). */
export function routeBackendRefs(route: KubeObject): BackendRef[] {
  const ns = route.metadata.namespace ?? '';
  const out: BackendRef[] = [];
  asArray(spec(route).rules).forEach((raw, i) => {
    const rule = asObject(raw);
    const mirrors = (filters: unknown) => {
      for (const f of asArray(filters).filter(isObject))
        if (f.type === 'RequestMirror' && isObject(f.requestMirror))
          out.push(backendRefOf(f.requestMirror.backendRef, ns, i, true));
    };
    for (const b of asArray(rule.backendRefs)) {
      out.push(backendRefOf(b, ns, i, false));
      mirrors(asObject(b).filters);
    }
    mirrors(rule.filters);
  });
  return out;
}

export function routeHostnames(route: KubeObject): string[] {
  return asArray(spec(route).hostnames)
    .map((h) => asString(h))
    .filter(Boolean);
}

export interface RouteRule {
  index: number;
  name: string;
  /** Short text per match (`PathPrefix /api`, `GET /x`, `acme.v1.Svc/Get`). */
  matches: string[];
  /** Filter types (`RequestRedirect`, `URLRewrite`, `ExtensionRef …`). */
  filters: string[];
  backends: BackendRef[];
  /** Answers without a backend (a redirect or an implementation's direct response). */
  terminal: boolean;
}

function httpMatchText(m: Record<string, unknown>): string {
  const parts: string[] = [];
  const method = asString(m.method);
  if (method) parts.push(method);
  if (isObject(m.path)) {
    const type = asString(m.path.type) || 'PathPrefix';
    parts.push(`${type} ${asString(m.path.value) || '/'}`);
  }
  for (const h of asArray(m.headers).filter(isObject))
    parts.push(
      `${asString(h.name)}${asString(h.type) === 'RegularExpression' ? '~' : '='}${asString(h.value)}`,
    );
  for (const q of asArray(m.queryParams).filter(isObject))
    parts.push(`?${asString(q.name)}=${asString(q.value)}`);
  return parts.join(' ') || 'PathPrefix /';
}

function grpcMatchText(m: Record<string, unknown>): string {
  const method = asObject(m.method);
  const svc = asString(method.service);
  const name = asString(method.method);
  const parts = [svc || name ? `${svc || '*'}/${name || '*'}` : '*'];
  for (const h of asArray(m.headers).filter(isObject))
    parts.push(`${asString(h.name)}=${asString(h.value)}`);
  return parts.join(' ');
}

export function routeRules(route: KubeObject): RouteRule[] {
  const backends = routeBackendRefs(route);
  return asArray(spec(route).rules).map((raw, index) => {
    const rule = asObject(raw);
    const matches = asArray(rule.matches)
      .filter(isObject)
      .map((m) => (route.kind === 'GRPCRoute' ? grpcMatchText(m) : httpMatchText(m)));
    const filters = asArray(rule.filters)
      .filter(isObject)
      .map((f) => {
        const type = asString(f.type);
        if (type === 'ExtensionRef' && isObject(f.extensionRef))
          return `${type} ${asString(f.extensionRef.kind)}/${asString(f.extensionRef.name)}`;
        return type;
      })
      .filter(Boolean);
    return {
      index,
      name: asString(rule.name),
      matches:
        matches.length || (route.kind !== 'HTTPRoute' && route.kind !== 'GRPCRoute')
          ? matches
          : [route.kind === 'GRPCRoute' ? '*' : 'PathPrefix /'],
      filters,
      backends: backends.filter((b) => b.rule === index),
      // An ExtensionRef may answer itself (direct responses); do not call such rules broken.
      terminal: filters.some((f) => f === 'RequestRedirect' || f.startsWith('ExtensionRef')),
    };
  });
}

// ---------------------------------------------------------------------------
// Route status
// ---------------------------------------------------------------------------

export interface RouteParentStatus {
  parentRef: ParentRef;
  controllerName: string;
  conditions: GwCondition[];
}

export function routeParentStatuses(route: KubeObject): RouteParentStatus[] {
  const ns = route.metadata.namespace ?? '';
  return asArray(status(route).parents)
    .filter(isObject)
    .map((p) => ({
      parentRef: parentRefOf(p.parentRef, ns),
      controllerName: asString(p.controllerName),
      conditions: conditionsOf(p.conditions),
    }));
}

/**
 * The status a controller wrote for `ref`: the exact (defaulted) match, else
 * one that echoes the reference without some defaulted fields — the same
 * name, namespace, kind and section, and the same port unless the status
 * omits it.
 */
export function parentStatusFor(
  statuses: readonly RouteParentStatus[],
  ref: ParentRef,
): RouteParentStatus | null {
  return (
    statuses.find((s) => sameParent(s.parentRef, ref)) ??
    statuses.find(
      (s) =>
        s.parentRef.name === ref.name &&
        s.parentRef.namespace === ref.namespace &&
        s.parentRef.kind === ref.kind &&
        s.parentRef.sectionName === ref.sectionName &&
        (s.parentRef.port === null || s.parentRef.port === ref.port),
    ) ??
    null
  );
}

export type RouteBucket = 'accepted' | 'unresolved' | 'partial' | 'rejected' | 'pending';

export interface RouteSummary {
  parents: number;
  accepted: number;
  rejected: number;
  unresolved: number;
  bucket: RouteBucket;
}

/**
 * Accepted by every parent (`accepted`), accepted but with unresolved
 * references (`unresolved`), by some (`partial`), by none of those that
 * reported (`rejected`), or no controller reported yet (`pending`).
 */
export function routeSummary(route: KubeObject): RouteSummary {
  const parents = routeParentRefs(route);
  const statuses = routeParentStatuses(route);
  let accepted = 0;
  let rejected = 0;
  let unresolved = 0;
  // Per parentRef: entries for removed parents are not counted.
  for (const ref of parents) {
    const s = parentStatusFor(statuses, ref);
    if (!s) continue;
    const a = findCondition(s.conditions, 'Accepted');
    if (a?.status === 'True') accepted++;
    else if (a?.status === 'False') rejected++;
    if (findCondition(s.conditions, 'ResolvedRefs')?.status === 'False') unresolved++;
  }
  const bucket: RouteBucket =
    accepted + rejected === 0
      ? 'pending'
      : rejected === 0 && accepted === parents.length
        ? unresolved
          ? 'unresolved'
          : 'accepted'
        : accepted === 0
          ? 'rejected'
          : 'partial';
  return { parents: parents.length, accepted, rejected, unresolved, bucket };
}

export const ROUTE_BUCKET_TONE: Record<RouteBucket, StatusTone> = {
  accepted: 'success',
  unresolved: 'warning',
  partial: 'warning',
  rejected: 'error',
  pending: 'muted',
};

// ---------------------------------------------------------------------------
// Gateways and classes
// ---------------------------------------------------------------------------

export interface SecretRef {
  group: string;
  kind: string;
  namespace: string;
  name: string;
}

export interface RouteGroupKind {
  group: string;
  kind: string;
}

export interface Listener {
  name: string;
  port: number;
  protocol: string;
  hostname: string | null;
  tls: { mode: string; certificateRefs: SecretRef[] } | null;
  allowedFrom: 'Same' | 'All' | 'Selector' | string;
  allowedSelector: Record<string, unknown> | null;
  /** `allowedRoutes.kinds` as written (empty = the protocol's defaults). */
  allowedKinds: RouteGroupKind[];
  status: {
    attachedRoutes: number;
    supportedKinds: RouteGroupKind[];
    conditions: GwCondition[];
  } | null;
}

function groupKinds(list: unknown): RouteGroupKind[] {
  return asArray(list)
    .filter(isObject)
    .map((k) => ({
      group: typeof k.group === 'string' ? k.group : GATEWAY_GROUP,
      kind: asString(k.kind),
    }));
}

/** Listeners from a Gateway's (or ListenerSet's) spec, joined with their status by name. */
export function gatewayListeners(gw: KubeObject): Listener[] {
  const ns = gw.metadata.namespace ?? '';
  const statuses = new Map(
    asArray(status(gw).listeners)
      .filter(isObject)
      .map((l) => [asString(l.name), l] as const),
  );
  return asArray(spec(gw).listeners)
    .filter(isObject)
    .map((l) => {
      const tls = isObject(l.tls) ? l.tls : null;
      const allowed = asObject(l.allowedRoutes);
      const nsSel = asObject(allowed.namespaces);
      const st = statuses.get(asString(l.name));
      return {
        name: asString(l.name),
        port: asNumber(l.port),
        protocol: asString(l.protocol),
        hostname: asString(l.hostname) || null,
        tls: tls
          ? {
              mode: asString(tls.mode) || 'Terminate',
              certificateRefs: asArray(tls.certificateRefs)
                .filter(isObject)
                .map((c) => ({
                  group: asString(c.group),
                  kind: asString(c.kind) || 'Secret',
                  namespace: asString(c.namespace) || ns,
                  name: asString(c.name),
                })),
            }
          : null,
        allowedFrom: asString(nsSel.from) || 'Same',
        allowedSelector: isObject(nsSel.selector) ? nsSel.selector : null,
        allowedKinds: groupKinds(allowed.kinds),
        status: st
          ? {
              attachedRoutes: asNumber(st.attachedRoutes),
              supportedKinds: groupKinds(st.supportedKinds),
              conditions: conditionsOf(st.conditions),
            }
          : null,
      };
    });
}

export function gatewayClassName(gw: KubeObject): string {
  return asString(spec(gw).gatewayClassName);
}

export interface GatewayAddress {
  type: string;
  value: string;
}

export function gatewayAddresses(gw: KubeObject): GatewayAddress[] {
  return asArray(status(gw).addresses)
    .filter(isObject)
    .map((a) => ({ type: asString(a.type) || 'IPAddress', value: asString(a.value) }))
    .filter((a) => a.value);
}

/** Sum of `status.listeners[].attachedRoutes` (as the controller counts them). */
export function attachedRouteCount(gw: KubeObject): number {
  return asArray(status(gw).listeners)
    .filter(isObject)
    .reduce((sum, l) => sum + asNumber(l.attachedRoutes), 0);
}

export type GatewayBucket = 'programmed' | 'pending' | 'failed' | 'unknown';

/** Programmed (and accepted), pending (Unknown / not yet), failed (False), or no status. */
export function gatewayBucket(gw: KubeObject): GatewayBucket {
  const conds = conditionsOf(status(gw).conditions);
  const accepted = findCondition(conds, 'Accepted');
  const programmed = findCondition(conds, 'Programmed');
  if (accepted?.status === 'False' || programmed?.status === 'False') return 'failed';
  if (programmed?.status === 'True') return 'programmed';
  if (!conds.length) return 'unknown';
  return 'pending';
}

export const GATEWAY_BUCKET_TONE: Record<GatewayBucket, StatusTone> = {
  programmed: 'success',
  pending: 'warning',
  failed: 'error',
  unknown: 'muted',
};

export function classController(cls: KubeObject): string {
  return asString(spec(cls).controllerName);
}

// ---------------------------------------------------------------------------
// Policies (Envoy Gateway policies, BackendTLSPolicy, other direct policies)
// ---------------------------------------------------------------------------

export interface PolicyTarget {
  group: string;
  kind: string;
  namespace: string;
  name: string;
  sectionName: string | null;
}

/** `spec.targetRef` (older single form) and `spec.targetRefs[]`; local to the policy's namespace. */
export function policyTargets(policy: KubeObject): PolicyTarget[] {
  const ns = policy.metadata.namespace ?? '';
  const s = spec(policy);
  const raw = [...(isObject(s.targetRef) ? [s.targetRef] : []), ...asArray(s.targetRefs)];
  return raw.filter(isObject).map((t) => ({
    group: asString(t.group),
    kind: asString(t.kind),
    namespace: asString(t.namespace) || ns,
    name: asString(t.name),
    sectionName: asString(t.sectionName) || null,
  }));
}

/** `spec.targetSelectors[]` as `Kind label=value,…` (Envoy Gateway). */
export function policySelectors(policy: KubeObject): string[] {
  return asArray(spec(policy).targetSelectors)
    .filter(isObject)
    .map((sel) => {
      const labels = Object.entries(asObject(sel.matchLabels)).map(
        ([k, v]) => `${k}=${asString(v)}`,
      );
      const exprs = asArray(sel.matchExpressions).length ? ['…'] : [];
      return `${asString(sel.kind)} ${[...labels, ...exprs].join(',')}`.trim();
    });
}

export interface AncestorStatus {
  ancestorRef: ParentRef;
  controllerName: string;
  conditions: GwCondition[];
}

export function policyAncestors(policy: KubeObject): AncestorStatus[] {
  const ns = policy.metadata.namespace ?? '';
  return asArray(status(policy).ancestors)
    .filter(isObject)
    .map((a) => ({
      ancestorRef: parentRefOf(a.ancestorRef, ns),
      controllerName: asString(a.controllerName),
      conditions: conditionsOf(a.conditions),
    }));
}

export type PolicyBucket = 'accepted' | 'conflicted' | 'rejected' | 'pending';

export function policyBucket(policy: KubeObject): PolicyBucket {
  const ancestors = policyAncestors(policy);
  if (!ancestors.length) return 'pending';
  let rejected = false;
  let conflicted = false;
  let acceptedSome = false;
  for (const a of ancestors) {
    const accepted = findCondition(a.conditions, 'Accepted');
    if (accepted?.status === 'True') acceptedSome = true;
    if (accepted?.status === 'False') {
      if (accepted.reason === 'Conflicted') conflicted = true;
      else rejected = true;
    }
    if (findCondition(a.conditions, 'Overridden')?.status === 'True') conflicted = true;
  }
  if (rejected) return 'rejected';
  if (conflicted) return 'conflicted';
  return acceptedSome ? 'accepted' : 'pending';
}

export const POLICY_BUCKET_TONE: Record<PolicyBucket, StatusTone> = {
  accepted: 'success',
  conflicted: 'warning',
  rejected: 'error',
  pending: 'muted',
};

/** Spec fields a policy configures besides its targets (Kubernetes field names, untranslated). */
export function policyFeatures(policy: KubeObject): string[] {
  return Object.keys(spec(policy))
    .filter((k) => k !== 'targetRef' && k !== 'targetRefs' && k !== 'targetSelectors')
    .sort();
}

// ---------------------------------------------------------------------------
// ReferenceGrants
// ---------------------------------------------------------------------------

export interface GrantFrom {
  group: string;
  kind: string;
  namespace: string;
}

export interface GrantTo {
  group: string;
  kind: string;
  /** `null` = every object of the kind in the grant's namespace. */
  name: string | null;
}

export function grantFrom(grant: KubeObject): GrantFrom[] {
  return asArray(spec(grant).from)
    .filter(isObject)
    .map((f) => ({
      group: asString(f.group),
      kind: asString(f.kind),
      namespace: asString(f.namespace),
    }));
}

export function grantTo(grant: KubeObject): GrantTo[] {
  return asArray(spec(grant).to)
    .filter(isObject)
    .map((t) => ({
      group: asString(t.group),
      kind: asString(t.kind),
      name: asString(t.name) || null,
    }));
}

/** `group/Kind`, `Kind` for the core group. */
export function groupKindText(gk: { group: string; kind: string }): string {
  return gk.group ? `${gk.kind}.${gk.group}` : gk.kind;
}

/** Policies whose targetRefs name `obj` (any section), in kind then name order. */
export function policiesTargeting(
  obj: KubeObject,
  policies: readonly KubeObject[],
): Array<{ policy: KubeObject; sections: string[] }> {
  const group = obj.apiVersion.includes('/')
    ? obj.apiVersion.slice(0, obj.apiVersion.indexOf('/'))
    : '';
  const ns = obj.metadata.namespace ?? '';
  const out: Array<{ policy: KubeObject; sections: string[] }> = [];
  for (const policy of policies) {
    const hits = policyTargets(policy).filter(
      (t) =>
        t.kind === obj.kind &&
        t.group === group &&
        t.name === obj.metadata.name &&
        (obj.kind === 'GatewayClass' || t.namespace === ns),
    );
    if (hits.length)
      out.push({
        policy,
        sections: hits.map((h) => h.sectionName).filter((s): s is string => !!s),
      });
  }
  return out.sort(
    (a, b) =>
      a.policy.kind.localeCompare(b.policy.kind) ||
      a.policy.metadata.name.localeCompare(b.policy.metadata.name),
  );
}
