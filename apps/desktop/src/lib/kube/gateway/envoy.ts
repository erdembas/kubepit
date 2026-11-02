import type { KubeObject } from '@/types';
import { asArray, asObject, asString, isObject, spec } from '../accessors';
import { implementationFor } from './implementations';
import { ENVOY_GROUP } from './kinds';
import { classController } from './model';

/**
 * Envoy Gateway specifics: which Gateways it serves, how its generated
 * proxy resources are labelled (to link a Gateway to its Envoy Deployment,
 * Service and pods), the admin port, and readers for its own kinds.
 */

/** Envoy's admin listener inside every Envoy Gateway proxy pod (bound to 127.0.0.1). */
export const ENVOY_ADMIN_PORT = 19000;

export const OWNING_GATEWAY_NAME = 'gateway.envoyproxy.io/owning-gateway-name';
export const OWNING_GATEWAY_NAMESPACE = 'gateway.envoyproxy.io/owning-gateway-namespace';
/** Set instead of the two above when the EnvoyProxy merges every Gateway of a class. */
export const OWNING_GATEWAY_CLASS = 'gateway.envoyproxy.io/owning-gatewayclass';

export function isEnvoyGatewayClass(cls: KubeObject | null | undefined): boolean {
  return !!cls && implementationFor(classController(cls))?.id === 'envoy-gateway';
}

/** Label selector of a Gateway's proxy resources (Deployment / DaemonSet, Service, pods, HPA). */
export function proxySelector(gateway: KubeObject, merged: boolean): string {
  if (merged) return `${OWNING_GATEWAY_CLASS}=${asString(spec(gateway).gatewayClassName)}`;
  return `${OWNING_GATEWAY_NAME}=${gateway.metadata.name},${OWNING_GATEWAY_NAMESPACE}=${gateway.metadata.namespace ?? ''}`;
}

/** Whether an EnvoyProxy merges the Gateways of its class into one proxy fleet. */
export function mergesGateways(envoyProxy: KubeObject | null | undefined): boolean {
  return !!envoyProxy && spec(envoyProxy).mergeGateways === true;
}

export interface ParametersRef {
  group: string;
  kind: string;
  name: string;
  namespace: string | null;
}

/** `spec.parametersRef` of a GatewayClass, or `spec.infrastructure.parametersRef` of a Gateway. */
export function parametersRef(obj: KubeObject): ParametersRef | null {
  const s = spec(obj);
  const raw = isObject(s.parametersRef)
    ? s.parametersRef
    : isObject(asObject(s.infrastructure).parametersRef)
      ? asObject(asObject(s.infrastructure).parametersRef)
      : null;
  if (!raw) return null;
  return {
    group: asString(raw.group),
    kind: asString(raw.kind),
    name: asString(raw.name),
    namespace:
      asString(raw.namespace) || (obj.kind === 'Gateway' ? (obj.metadata.namespace ?? null) : null),
  };
}

export const isEnvoyProxyRef = (r: ParametersRef | null) =>
  !!r && r.group === ENVOY_GROUP && r.kind === 'EnvoyProxy';

export interface EnvoyProxySummary {
  /** `Deployment`, `DaemonSet` or `—` (default Deployment). */
  workload: string;
  replicas: number | null;
  serviceType: string;
  mergeGateways: boolean;
  logLevel: string;
  telemetry: string[];
  bootstrap: string;
}

export function envoyProxySummary(ep: KubeObject): EnvoyProxySummary {
  const s = spec(ep);
  const k8s = asObject(asObject(s.provider).kubernetes);
  const daemonSet = isObject(k8s.envoyDaemonSet);
  const deployment = asObject(k8s.envoyDeployment);
  const service = asObject(k8s.envoyService);
  const logging = asObject(asObject(s.logging).level);
  return {
    workload: daemonSet ? 'DaemonSet' : 'Deployment',
    replicas: !daemonSet && typeof deployment.replicas === 'number' ? deployment.replicas : null,
    serviceType: asString(service.type) || 'LoadBalancer',
    mergeGateways: s.mergeGateways === true,
    logLevel: asString(logging.default),
    telemetry: Object.keys(asObject(s.telemetry)).sort(),
    bootstrap: asString(asObject(s.bootstrap).type),
  };
}

export interface EnvoyPatch {
  type: string;
  name: string;
  op: string;
  path: string;
}

/** `EnvoyPatchPolicy.spec.jsonPatches[]` (xDS resource type, name, operation). */
export function envoyPatches(epp: KubeObject): EnvoyPatch[] {
  return asArray(spec(epp).jsonPatches)
    .filter(isObject)
    .map((p) => ({
      type: asString(p.type).replace(/^type\.googleapis\.com\/envoy\.config\.\w+\.v3\./, ''),
      name: asString(p.name),
      op: asString(asObject(p.operation).op),
      path: asString(asObject(p.operation).path) || asString(asObject(p.operation).jsonPath),
    }));
}

/**
 * The Gateway API object an Envoy Gateway xDS resource was generated for:
 * route and cluster names start with `httproute/<ns>/<name>/rule/<i>`
 * (`grpcroute/…`, `tlsroute/…`, `tcproute/…`, `udproute/…`), listeners and
 * route configurations with `<ns>/<gateway>/<listener>`.
 */
export interface XdsOrigin {
  kind: string;
  namespace: string;
  name: string;
  /** Rule index for routes, listener name for gateways. */
  section: string | null;
}

const ROUTE_PREFIX: Record<string, string> = {
  httproute: 'HTTPRoute',
  grpcroute: 'GRPCRoute',
  tlsroute: 'TLSRoute',
  tcproute: 'TCPRoute',
  udproute: 'UDPRoute',
};

export function xdsOrigin(name: string): XdsOrigin | null {
  const parts = name.split('/');
  const kind = ROUTE_PREFIX[parts[0] ?? ''];
  if (kind && parts.length >= 3)
    return {
      kind,
      namespace: parts[1]!,
      name: parts[2]!,
      section: parts[3] === 'rule' && parts[4] !== undefined ? parts[4] : null,
    };
  if (parts.length === 3 && parts.every(Boolean))
    return { kind: 'Gateway', namespace: parts[0]!, name: parts[1]!, section: parts[2]! };
  return null;
}
