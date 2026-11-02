import type { ApiResourceInfo, Gvk, KubeObject } from '@/types';
import { gvkFromApiResource, kindKey, parseApiVersion } from '../catalog';

/**
 * Gateway API kinds (`gateway.networking.k8s.io`, the experimental
 * `gateway.networking.x-k8s.io`) and Envoy Gateway's extension kinds
 * (`gateway.envoyproxy.io`). Detection is discovery-driven: the navigator's
 * Gateway API section only appears when the cluster serves them, and every
 * served version comes from discovery (the versions below are only used
 * before discovery answers).
 */

export const GATEWAY_GROUP = 'gateway.networking.k8s.io';
export const GATEWAY_X_GROUP = 'gateway.networking.x-k8s.io';
export const ENVOY_GROUP = 'gateway.envoyproxy.io';

export type RouteKind = 'HTTPRoute' | 'GRPCRoute' | 'TLSRoute' | 'TCPRoute' | 'UDPRoute';

export type GatewayKind =
  'GatewayClass' | 'Gateway' | RouteKind | 'ReferenceGrant' | 'BackendTLSPolicy' | 'ListenerSet';

export type EnvoyKind =
  | 'EnvoyProxy'
  | 'BackendTrafficPolicy'
  | 'ClientTrafficPolicy'
  | 'SecurityPolicy'
  | 'EnvoyExtensionPolicy'
  | 'EnvoyPatchPolicy'
  | 'Backend'
  | 'HTTPRouteFilter';

/** Envoy Gateway policies that attach to Gateways and routes through `targetRefs`. */
export type EnvoyPolicyKind = Extract<
  EnvoyKind,
  | 'BackendTrafficPolicy'
  | 'ClientTrafficPolicy'
  | 'SecurityPolicy'
  | 'EnvoyExtensionPolicy'
  | 'EnvoyPatchPolicy'
>;

export const ROUTE_KINDS: readonly RouteKind[] = [
  'HTTPRoute',
  'GRPCRoute',
  'TLSRoute',
  'TCPRoute',
  'UDPRoute',
];

export const ENVOY_POLICY_KINDS: readonly EnvoyPolicyKind[] = [
  'BackendTrafficPolicy',
  'ClientTrafficPolicy',
  'SecurityPolicy',
  'EnvoyExtensionPolicy',
  'EnvoyPatchPolicy',
];

export interface KnownKind extends Gvk {
  key: string;
}

function known(
  group: string,
  version: string,
  kind: string,
  plural: string,
  namespaced = true,
): KnownKind {
  return { group, version, kind, plural, namespaced, key: `${plural}.${group}` };
}

/** Gateway API kinds in navigator order. */
export const GATEWAY_KINDS: Readonly<Record<GatewayKind, KnownKind>> = {
  GatewayClass: known(GATEWAY_GROUP, 'v1', 'GatewayClass', 'gatewayclasses', false),
  Gateway: known(GATEWAY_GROUP, 'v1', 'Gateway', 'gateways'),
  ListenerSet: known(GATEWAY_GROUP, 'v1', 'ListenerSet', 'listenersets'),
  HTTPRoute: known(GATEWAY_GROUP, 'v1', 'HTTPRoute', 'httproutes'),
  GRPCRoute: known(GATEWAY_GROUP, 'v1', 'GRPCRoute', 'grpcroutes'),
  TLSRoute: known(GATEWAY_GROUP, 'v1alpha2', 'TLSRoute', 'tlsroutes'),
  TCPRoute: known(GATEWAY_GROUP, 'v1alpha2', 'TCPRoute', 'tcproutes'),
  UDPRoute: known(GATEWAY_GROUP, 'v1alpha2', 'UDPRoute', 'udproutes'),
  ReferenceGrant: known(GATEWAY_GROUP, 'v1beta1', 'ReferenceGrant', 'referencegrants'),
  BackendTLSPolicy: known(GATEWAY_GROUP, 'v1', 'BackendTLSPolicy', 'backendtlspolicies'),
};

export const ENVOY_KINDS: Readonly<Record<EnvoyKind, KnownKind>> = {
  EnvoyProxy: known(ENVOY_GROUP, 'v1alpha1', 'EnvoyProxy', 'envoyproxies'),
  BackendTrafficPolicy: known(
    ENVOY_GROUP,
    'v1alpha1',
    'BackendTrafficPolicy',
    'backendtrafficpolicies',
  ),
  ClientTrafficPolicy: known(
    ENVOY_GROUP,
    'v1alpha1',
    'ClientTrafficPolicy',
    'clienttrafficpolicies',
  ),
  SecurityPolicy: known(ENVOY_GROUP, 'v1alpha1', 'SecurityPolicy', 'securitypolicies'),
  EnvoyExtensionPolicy: known(
    ENVOY_GROUP,
    'v1alpha1',
    'EnvoyExtensionPolicy',
    'envoyextensionpolicies',
  ),
  EnvoyPatchPolicy: known(ENVOY_GROUP, 'v1alpha1', 'EnvoyPatchPolicy', 'envoypatchpolicies'),
  Backend: known(ENVOY_GROUP, 'v1alpha1', 'Backend', 'backends'),
  HTTPRouteFilter: known(ENVOY_GROUP, 'v1alpha1', 'HTTPRouteFilter', 'httproutefilters'),
};

const NAV_ORDER: readonly KnownKind[] = [
  ...Object.values(GATEWAY_KINDS),
  ...Object.values(ENVOY_KINDS),
];

const NAV_GROUPS = new Set([GATEWAY_GROUP, GATEWAY_X_GROUP, ENVOY_GROUP]);

/** Kinds shown in the navigator's Gateway API section (and left out of Custom Resources). */
export function isGatewayNavResource(r: Pick<Gvk, 'group'>): boolean {
  return NAV_GROUPS.has(r.group);
}

function order(r: Pick<Gvk, 'group' | 'plural'>): number {
  const i = NAV_ORDER.findIndex((k) => k.group === r.group && k.plural === r.plural);
  if (i >= 0) return i;
  // Experimental (x-k8s.io) kinds after the standard ones, Envoy Gateway's unknown kinds last.
  return NAV_ORDER.length + (r.group === GATEWAY_X_GROUP ? 0 : 1);
}

/** Served Gateway API and Envoy Gateway kinds, one entry per kind key, in navigator order. */
export function gatewayNavResources(
  apiResources: readonly ApiResourceInfo[] | null | undefined,
): ApiResourceInfo[] {
  const seen = new Set<string>();
  const out: ApiResourceInfo[] = [];
  for (const r of apiResources ?? []) {
    if (!isGatewayNavResource(r)) continue;
    const key = kindKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out.sort((a, b) => order(a) - order(b) || a.kind.localeCompare(b.kind));
}

function served(
  k: KnownKind,
  apiResources: readonly ApiResourceInfo[] | null | undefined,
): ApiResourceInfo | undefined {
  return apiResources?.find((r) => r.group === k.group && r.plural === k.plural);
}

/** The served Gvk of a Gateway API kind, or `null` when the cluster does not serve it. */
export function gatewayGvk(
  kind: GatewayKind,
  apiResources: readonly ApiResourceInfo[] | null | undefined,
): Gvk | null {
  const r = served(GATEWAY_KINDS[kind], apiResources);
  return r ? gvkFromApiResource(r) : null;
}

/** The served Gvk of an Envoy Gateway kind, or `null`. */
export function envoyGvk(
  kind: EnvoyKind,
  apiResources: readonly ApiResourceInfo[] | null | undefined,
): Gvk | null {
  const r = served(ENVOY_KINDS[kind], apiResources);
  return r ? gvkFromApiResource(r) : null;
}

export interface GatewayDetection {
  /** `Gateway` is served (the overview needs it). */
  served: boolean;
  /** Any Gateway API kind is served (left behind by an incomplete install, for example). */
  any: boolean;
  routes: RouteKind[];
  grants: boolean;
  backendTls: boolean;
  /** Experimental-channel kinds are served (TLS/TCP/UDP routes or the x-k8s.io group). */
  experimental: boolean;
  /** Envoy Gateway's CRDs are served. */
  envoy: boolean;
}

export function detectGatewayApi(
  apiResources: readonly ApiResourceInfo[] | null | undefined,
): GatewayDetection {
  const has = (k: GatewayKind) => !!served(GATEWAY_KINDS[k], apiResources);
  const routes = ROUTE_KINDS.filter(has);
  return {
    served: has('Gateway'),
    any: !!apiResources?.some((r) => r.group === GATEWAY_GROUP),
    routes,
    grants: has('ReferenceGrant'),
    backendTls: has('BackendTLSPolicy'),
    experimental:
      routes.some((k) => k === 'TLSRoute' || k === 'TCPRoute' || k === 'UDPRoute') ||
      !!apiResources?.some((r) => r.group === GATEWAY_X_GROUP),
    envoy: !!apiResources?.some((r) => r.group === ENVOY_GROUP),
  };
}

export function groupOf(obj: Pick<KubeObject, 'apiVersion'>): string {
  return parseApiVersion(obj.apiVersion ?? '').group;
}

const GATEWAY_KIND_NAMES = new Set<string>(Object.keys(GATEWAY_KINDS));
const ENVOY_KIND_NAMES = new Set<string>(Object.keys(ENVOY_KINDS));
const ROUTE_KIND_NAMES = new Set<string>(ROUTE_KINDS);
const ENVOY_POLICY_NAMES = new Set<string>(ENVOY_POLICY_KINDS);

/** The Gateway API kind of `obj` (matched by API group, not by kind name alone). */
export function gatewayKindOf(obj: Pick<KubeObject, 'apiVersion' | 'kind'>): GatewayKind | null {
  return groupOf(obj) === GATEWAY_GROUP && GATEWAY_KIND_NAMES.has(obj.kind)
    ? (obj.kind as GatewayKind)
    : null;
}

export function envoyKindOf(obj: Pick<KubeObject, 'apiVersion' | 'kind'>): EnvoyKind | null {
  return groupOf(obj) === ENVOY_GROUP && ENVOY_KIND_NAMES.has(obj.kind)
    ? (obj.kind as EnvoyKind)
    : null;
}

export function isRouteKind(kind: string): kind is RouteKind {
  return ROUTE_KIND_NAMES.has(kind);
}

export function isEnvoyPolicyKind(kind: string): kind is EnvoyPolicyKind {
  return ENVOY_POLICY_NAMES.has(kind);
}

export function isRoute(obj: Pick<KubeObject, 'apiVersion' | 'kind'>): boolean {
  return groupOf(obj) === GATEWAY_GROUP && ROUTE_KIND_NAMES.has(obj.kind);
}

/** Route kinds whose spec has `hostnames` (matched against listener hostnames). */
export function routeHasHostnames(kind: string): boolean {
  return kind === 'HTTPRoute' || kind === 'GRPCRoute' || kind === 'TLSRoute';
}

/** Kind key (`httproutes.gateway.networking.k8s.io`) of a known kind name. */
export function gatewayKey(kind: GatewayKind): string {
  return GATEWAY_KINDS[kind].key;
}

export function envoyKey(kind: EnvoyKind): string {
  return ENVOY_KINDS[kind].key;
}
