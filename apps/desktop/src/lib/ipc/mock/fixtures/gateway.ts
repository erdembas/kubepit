import type { CrdInput } from './crds';
import { find, put, type ClusterDb } from './db';
import { DAY, meta, obj } from './util';

/** Gateway API CRDs and a gateway with HTTP and gRPC routes (relationship map demo). */

const GROUP = 'gateway.networking.k8s.io';
const API = `${GROUP}/v1`;

export const GATEWAY_CRDS: CrdInput[] = [
  {
    group: GROUP,
    kind: 'GatewayClass',
    plural: 'gatewayclasses',
    singular: 'gatewayclass',
    shortNames: ['gc'],
    scope: 'Cluster',
    versions: ['v1'],
    categories: ['gateway-api'],
    age: 110 * DAY,
  },
  {
    group: GROUP,
    kind: 'Gateway',
    plural: 'gateways',
    singular: 'gateway',
    shortNames: ['gtw'],
    scope: 'Namespaced',
    versions: ['v1'],
    categories: ['gateway-api'],
    age: 110 * DAY,
  },
  {
    group: GROUP,
    kind: 'HTTPRoute',
    plural: 'httproutes',
    singular: 'httproute',
    scope: 'Namespaced',
    versions: ['v1'],
    categories: ['gateway-api'],
    age: 110 * DAY,
  },
  {
    group: GROUP,
    kind: 'GRPCRoute',
    plural: 'grpcroutes',
    singular: 'grpcroute',
    scope: 'Namespaced',
    versions: ['v1'],
    categories: ['gateway-api'],
    age: 110 * DAY,
  },
];

const condition = (type: string, reason: string) => ({
  type,
  status: 'True',
  reason,
  message: '',
  lastTransitionTime: new Date(Date.now() - 20 * DAY).toISOString(),
  observedGeneration: 1,
});

const CONTROLLER = 'gateway.envoyproxy.io/gatewayclass-controller';

export function buildGatewayApi(db: ClusterDb) {
  const p = db.profile;
  const parent = { group: GROUP, kind: 'Gateway', name: 'public-gateway', namespace: 'web' };
  const accepted = [
    {
      parentRef: parent,
      controllerName: CONTROLLER,
      conditions: [condition('Accepted', 'Accepted'), condition('ResolvedRefs', 'ResolvedRefs')],
    },
  ];
  put(
    db,
    obj(API, 'GatewayClass', meta({ name: 'envoy', age: 100 * DAY }), {
      spec: { controllerName: CONTROLLER },
      status: { conditions: [condition('Accepted', 'Accepted')] },
    }),
  );
  put(
    db,
    obj(API, 'Gateway', meta({ name: 'public-gateway', namespace: 'web', age: 60 * DAY }), {
      spec: {
        gatewayClassName: 'envoy',
        listeners: [
          {
            name: 'http',
            protocol: 'HTTP',
            port: 80,
            allowedRoutes: { namespaces: { from: 'All' } },
          },
          {
            name: 'https',
            protocol: 'HTTPS',
            port: 443,
            hostname: `*.shop.${p.domain}`,
            tls: {
              mode: 'Terminate',
              certificateRefs: [{ kind: 'Secret', name: 'storefront-tls' }],
            },
            allowedRoutes: { namespaces: { from: 'All' } },
          },
        ],
      },
      status: {
        addresses: [{ type: 'IPAddress', value: '203.0.113.24' }],
        conditions: [condition('Accepted', 'Accepted'), condition('Programmed', 'Programmed')],
      },
    }),
  );
  const backends = [{ name: 'web-gateway', port: 8080 }];
  if (find(db, 'services', 'web', 'image-resizer'))
    backends.push({ name: 'image-resizer', port: 80 });
  put(
    db,
    obj(API, 'HTTPRoute', meta({ name: 'storefront-api', namespace: 'web', age: 60 * DAY }), {
      spec: {
        parentRefs: [{ name: 'public-gateway', sectionName: 'https' }],
        hostnames: [`api.shop.${p.domain}`],
        rules: backends.map((b) => ({
          matches: [{ path: { type: 'PathPrefix', value: `/${b.name}` } }],
          backendRefs: [{ name: b.name, port: b.port }],
        })),
      },
      status: { parents: accepted },
    }),
  );
  put(
    db,
    obj(API, 'GRPCRoute', meta({ name: 'payments-grpc', namespace: 'checkout', age: 45 * DAY }), {
      spec: {
        parentRefs: [{ name: 'public-gateway', namespace: 'web', sectionName: 'https' }],
        hostnames: [`grpc.shop.${p.domain}`],
        rules: [
          {
            matches: [{ method: { service: 'acme.payments.v1.Payments' } }],
            backendRefs: [{ name: 'payment-api', port: 9090 }],
          },
        ],
      },
      status: { parents: accepted },
    }),
  );
}
