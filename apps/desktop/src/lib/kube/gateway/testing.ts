import type { KubeObject } from '@/types';
import { GATEWAY_GROUP } from './kinds';
import { buildGatewayIndex, type GatewayIndexInput } from './refs';

/** Object builders shared by the Gateway API tests. */

let uid = 0;

export function kobj(
  apiVersion: string,
  kind: string,
  name: string,
  namespace: string | null,
  body: Record<string, unknown> = {},
  labels?: Record<string, string>,
): KubeObject {
  uid++;
  return {
    apiVersion,
    kind,
    metadata: {
      name,
      ...(namespace !== null ? { namespace } : {}),
      uid: `uid-${uid}`,
      generation: 1,
      ...(labels ? { labels } : {}),
    },
    ...body,
  } as KubeObject;
}

export const API = `${GATEWAY_GROUP}/v1`;

export const cond = (type: string, status: string, reason = type, message = '') => ({
  type,
  status,
  reason,
  message,
  observedGeneration: 1,
  lastTransitionTime: '2026-10-01T00:00:00Z',
});

export function gatewayClass(name: string, controller: string, accepted = true) {
  return kobj(API, 'GatewayClass', name, null, {
    spec: { controllerName: controller },
    status: {
      conditions: [
        cond('Accepted', accepted ? 'True' : 'False', accepted ? 'Accepted' : 'InvalidParameters'),
      ],
    },
  });
}

export function gateway(
  name: string,
  namespace: string,
  listeners: Record<string, unknown>[],
  extra: { className?: string; status?: Record<string, unknown> } = {},
) {
  return kobj(API, 'Gateway', name, namespace, {
    spec: { gatewayClassName: extra.className ?? 'eg', listeners },
    status: extra.status ?? {
      addresses: [{ type: 'IPAddress', value: '203.0.113.10' }],
      conditions: [cond('Accepted', 'True'), cond('Programmed', 'True')],
      listeners: listeners.map((l) => ({
        name: l.name,
        attachedRoutes: 1,
        supportedKinds: [],
        conditions: [
          cond('Accepted', 'True'),
          cond('Programmed', 'True'),
          cond('ResolvedRefs', 'True'),
        ],
      })),
    },
  });
}

export function httpRoute(
  name: string,
  namespace: string,
  spec: Record<string, unknown>,
  parents?: Array<{ parentRef: Record<string, unknown>; conditions: unknown[] }>,
) {
  return kobj(API, 'HTTPRoute', name, namespace, {
    spec,
    status: {
      parents: (parents ?? []).map((p) => ({
        parentRef: p.parentRef,
        controllerName: 'gateway.envoyproxy.io/gatewayclass-controller',
        conditions: p.conditions,
      })),
    },
  });
}

export function service(name: string, namespace: string, ports: number[]) {
  return kobj('v1', 'Service', name, namespace, {
    spec: { ports: ports.map((port) => ({ port, protocol: 'TCP' })) },
  });
}

export function namespace(name: string, labels: Record<string, string> = {}) {
  return kobj(
    'v1',
    'Namespace',
    name,
    null,
    {},
    { 'kubernetes.io/metadata.name': name, ...labels },
  );
}

export function grant(
  name: string,
  namespace: string,
  from: Array<{ group: string; kind: string; namespace: string }>,
  to: Array<{ group: string; kind: string; name?: string }>,
) {
  return kobj(`${GATEWAY_GROUP}/v1beta1`, 'ReferenceGrant', name, namespace, {
    spec: { from, to },
  });
}

export function index(input: Partial<GatewayIndexInput>) {
  return buildGatewayIndex({
    classes: [],
    gateways: [],
    routes: [],
    grants: [],
    services: [],
    namespaces: [],
    ...input,
  });
}
