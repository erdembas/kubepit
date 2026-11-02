import type { KubeObject } from '@/types';
import { buildDeployment } from './builders';
import type { CrdInput } from './crds';
import { find, put, type ClusterDb } from './db';
import { buildService } from './network';
import { tpl } from './template';
import { DAY, hexId, meta, obj } from './util';

/**
 * Gateway API demo: the CRDs (standard channel; staging also serves the
 * experimental one; the kind cluster has none, so its Gateway API view
 * offers the install), Envoy Gateway with its generated proxy fleet and
 * every policy kind on prod-eu, staging and dev, an Istio and an
 * unclaimed NGINX class on prod-us, Cilium on dev, and routes that break in
 * the documented ways (missing ReferenceGrant, sectionName or hostname
 * mismatch, missing backend) so the diagnosis has something to explain.
 */

const GROUP = 'gateway.networking.k8s.io';
const X_GROUP = 'gateway.networking.x-k8s.io';
const ENVOY = 'gateway.envoyproxy.io';
const API = `${GROUP}/v1`;
const ENVOY_API = `${ENVOY}/v1alpha1`;
export const EG_CONTROLLER = 'gateway.envoyproxy.io/gatewayclass-controller';
export const EG_NAMESPACE = 'envoy-gateway-system';
export const DEMO_BUNDLE_VERSION = 'v1.6.3';

/** Clusters serving the Gateway API CRDs, by channel (the demo install adds to it). */
const CHANNEL = new Map<string, 'standard' | 'experimental'>([
  ['c-prod-eu', 'standard'],
  ['c-prod-us', 'standard'],
  ['c-staging', 'experimental'],
  ['c-dev', 'standard'],
]);
const ENVOY_CLUSTERS = new Set(['c-prod-eu', 'c-staging', 'c-dev']);
const BUNDLE = new Map<string, string>();

export function hasGatewayApi(db: ClusterDb): boolean {
  return CHANNEL.has(db.profile.id);
}

export function hasEnvoyGateway(db: ClusterDb): boolean {
  return ENVOY_CLUSTERS.has(db.profile.id);
}

/** The demo install: the cluster serves the channel's CRDs from now on. */
export function markGatewayApiInstalled(
  db: ClusterDb,
  channel: 'standard' | 'experimental',
  version: string,
) {
  CHANNEL.set(db.profile.id, channel);
  BUNDLE.set(db.profile.id, version);
}

function bundleAnnotations(channel: string, version: string): Record<string, string> {
  return {
    'gateway.networking.k8s.io/bundle-version': version,
    'gateway.networking.k8s.io/channel': channel,
  };
}

/** The CRDs of a channel (also the demo's release manifest). */
export function gatewayChannelCrds(
  channel: 'standard' | 'experimental',
  version = DEMO_BUNDLE_VERSION,
  age = 110 * DAY,
): CrdInput[] {
  const annotations = bundleAnnotations(channel, version);
  const crd = (
    kind: string,
    plural: string,
    versions: string[],
    scope: 'Namespaced' | 'Cluster' = 'Namespaced',
    shortNames?: string[],
    group = GROUP,
  ): CrdInput => ({
    group,
    kind,
    plural,
    singular: kind.toLowerCase(),
    ...(shortNames ? { shortNames } : {}),
    scope,
    versions,
    categories: ['gateway-api'],
    age,
    annotations,
  });
  const standard = [
    crd('GatewayClass', 'gatewayclasses', ['v1'], 'Cluster', ['gc']),
    crd('Gateway', 'gateways', ['v1'], 'Namespaced', ['gtw']),
    crd('HTTPRoute', 'httproutes', ['v1']),
    crd('GRPCRoute', 'grpcroutes', ['v1']),
    crd('ReferenceGrant', 'referencegrants', ['v1beta1'], 'Namespaced', ['refgrant']),
    crd('BackendTLSPolicy', 'backendtlspolicies', ['v1'], 'Namespaced', ['btlspolicy']),
  ];
  if (channel === 'standard') return standard;
  return [
    ...standard,
    crd('TLSRoute', 'tlsroutes', ['v1alpha2']),
    crd('TCPRoute', 'tcproutes', ['v1alpha2']),
    crd('UDPRoute', 'udproutes', ['v1alpha2']),
    crd('XListenerSet', 'xlistenersets', ['v1alpha1'], 'Namespaced', ['lset'], X_GROUP),
  ];
}

const envoyCrd = (kind: string, plural: string, shortNames?: string[]): CrdInput => ({
  group: ENVOY,
  kind,
  plural,
  singular: kind.toLowerCase(),
  ...(shortNames ? { shortNames } : {}),
  scope: 'Namespaced',
  versions: ['v1alpha1'],
  categories: ['envoy-gateway'],
  age: 100 * DAY,
});

export function gatewayCrds(db: ClusterDb): CrdInput[] {
  const channel = CHANNEL.get(db.profile.id);
  if (!channel) return [];
  const out = gatewayChannelCrds(channel, BUNDLE.get(db.profile.id) ?? DEMO_BUNDLE_VERSION);
  if (hasEnvoyGateway(db))
    out.push(
      envoyCrd('EnvoyProxy', 'envoyproxies'),
      envoyCrd('BackendTrafficPolicy', 'backendtrafficpolicies', ['btp']),
      envoyCrd('ClientTrafficPolicy', 'clienttrafficpolicies', ['ctp']),
      envoyCrd('SecurityPolicy', 'securitypolicies', ['sp']),
      envoyCrd('EnvoyExtensionPolicy', 'envoyextensionpolicies', ['eep']),
      envoyCrd('EnvoyPatchPolicy', 'envoypatchpolicies', ['epp']),
      envoyCrd('Backend', 'backends', ['be']),
      envoyCrd('HTTPRouteFilter', 'httproutefilters', ['hrf']),
    );
  if (db.profile.platform === 'AKS')
    out.push({
      group: 'cilium.io',
      kind: 'CiliumEnvoyConfig',
      plural: 'ciliumenvoyconfigs',
      singular: 'ciliumenvoyconfig',
      shortNames: ['cec'],
      scope: 'Namespaced',
      versions: ['v2'],
      categories: ['cilium'],
      age: 180 * DAY,
    });
  return out;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const condition = (type: string, status = 'True', reason = type, message = '') => ({
  type,
  status,
  reason,
  message,
  lastTransitionTime: new Date(Date.now() - 20 * DAY).toISOString(),
  observedGeneration: 1,
});

interface Parent {
  name: string;
  namespace?: string;
  sectionName?: string;
}

function parentRef(p: Parent) {
  return {
    group: GROUP,
    kind: 'Gateway',
    name: p.name,
    ...(p.namespace ? { namespace: p.namespace } : {}),
    ...(p.sectionName ? { sectionName: p.sectionName } : {}),
  };
}

function routeStatus(
  controller: string,
  parents: Array<
    Parent & { accepted?: [string, string, string?]; resolved?: [string, string, string?] }
  >,
) {
  return {
    parents: parents.map((p) => ({
      parentRef: parentRef(p),
      controllerName: controller,
      conditions: [
        condition('Accepted', ...(p.accepted ?? ['True', 'Accepted'])),
        condition('ResolvedRefs', ...(p.resolved ?? ['True', 'ResolvedRefs'])),
      ],
    })),
  };
}

const ancestorStatus = (
  controller: string,
  ancestor: { kind?: string; name: string; namespace: string; sectionName?: string },
  conditions: ReturnType<typeof condition>[] = [condition('Accepted')],
) => ({
  ancestors: [
    {
      ancestorRef: { group: GROUP, kind: ancestor.kind ?? 'Gateway', ...ancestor },
      controllerName: controller,
      conditions,
    },
  ],
});

interface ListenerSpec {
  name: string;
  protocol: string;
  port: number;
  hostname?: string;
  tls?: Record<string, unknown>;
  allowedRoutes?: Record<string, unknown>;
}

function gateway(
  db: ClusterDb,
  input: {
    name: string;
    namespace: string;
    className: string;
    listeners: ListenerSpec[];
    attached: Record<string, number>;
    addresses?: Array<{ type: string; value: string }>;
    conditions?: ReturnType<typeof condition>[];
    listenerConditions?: Record<string, ReturnType<typeof condition>[]>;
    age?: number;
    noStatus?: boolean;
    infrastructure?: Record<string, unknown>;
  },
) {
  const kinds = (protocol: string) =>
    protocol === 'HTTP' || protocol === 'HTTPS'
      ? ['HTTPRoute', 'GRPCRoute']
      : protocol === 'TLS'
        ? ['TLSRoute']
        : protocol === 'TCP'
          ? ['TCPRoute']
          : ['UDPRoute'];
  return put(
    db,
    obj(
      API,
      'Gateway',
      meta({ name: input.name, namespace: input.namespace, age: input.age ?? 60 * DAY }),
      {
        spec: {
          gatewayClassName: input.className,
          ...(input.infrastructure ? { infrastructure: input.infrastructure } : {}),
          listeners: input.listeners,
        },
        ...(input.noStatus
          ? {}
          : {
              status: {
                addresses: input.addresses ?? [],
                conditions: input.conditions ?? [condition('Accepted'), condition('Programmed')],
                listeners: input.listeners.map((l) => ({
                  name: l.name,
                  attachedRoutes: input.attached[l.name] ?? 0,
                  supportedKinds: kinds(l.protocol).map((kind) => ({ group: GROUP, kind })),
                  conditions: input.listenerConditions?.[l.name] ?? [
                    condition('Accepted'),
                    condition('Programmed'),
                    condition('ResolvedRefs'),
                    condition('Conflicted', 'False', 'NoConflicts'),
                  ],
                })),
              },
            }),
      },
    ),
  );
}

function gatewayClass(
  db: ClusterDb,
  name: string,
  controller: string,
  extra: Record<string, unknown> = {},
  accepted = true,
) {
  return put(
    db,
    obj(API, 'GatewayClass', meta({ name, age: 100 * DAY }), {
      spec: { controllerName: controller, ...extra },
      ...(accepted
        ? {
            status: {
              conditions: [condition('Accepted'), condition('SupportedVersion')],
              supportedFeatures: [
                'Gateway',
                'GatewayPort8080',
                'HTTPRoute',
                'HTTPRouteHostRewrite',
                'HTTPRouteMethodMatching',
                'HTTPRoutePathRedirect',
                'HTTPRouteRequestMirror',
                'HTTPRouteResponseHeaderModification',
                'GRPCRoute',
                'ReferenceGrant',
                'BackendTLSPolicy',
              ].map((n) => ({ name: n })),
            },
          }
        : {}),
    }),
  );
}

function route(
  db: ClusterDb,
  kind: 'HTTPRoute' | 'GRPCRoute' | 'TLSRoute' | 'TCPRoute' | 'UDPRoute',
  name: string,
  namespace: string,
  spec: Record<string, unknown>,
  status?: Record<string, unknown>,
  age = 45 * DAY,
) {
  const apiVersion = kind === 'HTTPRoute' || kind === 'GRPCRoute' ? API : `${GROUP}/v1alpha2`;
  return put(
    db,
    obj(apiVersion, kind, meta({ name, namespace, age }), { spec, ...(status ? { status } : {}) }),
  );
}

// ---------------------------------------------------------------------------
// Envoy Gateway: controller, proxy fleet, policies
// ---------------------------------------------------------------------------

function buildEnvoyController(db: ClusterDb) {
  put(
    db,
    obj(
      'v1',
      'Namespace',
      meta({
        name: EG_NAMESPACE,
        age: 100 * DAY,
        labels: { 'kubernetes.io/metadata.name': EG_NAMESPACE },
      }),
      { spec: { finalizers: ['kubernetes'] }, status: { phase: 'Active' } },
    ),
  );
  buildDeployment(db, {
    namespace: EG_NAMESPACE,
    name: 'envoy-gateway',
    age: 100 * DAY,
    replicas: 1,
    labels: { 'app.kubernetes.io/instance': 'eg', 'control-plane': 'envoy-gateway' },
    template: tpl('envoy-gateway', [
      {
        name: 'envoy-gateway',
        image: 'docker.io/envoyproxy/gateway:v1.6.2',
        ports: [
          { name: 'grpc', port: 18000 },
          { name: 'ratelimit', port: 18001 },
          { name: 'metrics', port: 19001 },
        ],
        cpu: ['100m', '500m'],
        mem: ['256Mi', '1Gi'],
        probe: 'http',
        probePath: '/healthz',
      },
    ]),
  });
  buildService(db, {
    namespace: EG_NAMESPACE,
    name: 'envoy-gateway',
    selector: { app: 'envoy-gateway' },
    ports: [
      { name: 'grpc', port: 18000 },
      { name: 'ratelimit', port: 18001 },
      { name: 'metrics', port: 19001 },
    ],
  });
  put(
    db,
    obj(
      ENVOY_API,
      'EnvoyProxy',
      meta({ name: 'default-proxy', namespace: EG_NAMESPACE, age: 100 * DAY }),
      {
        spec: {
          provider: {
            type: 'Kubernetes',
            kubernetes: {
              envoyDeployment: {
                replicas: 2,
                container: { resources: { requests: { cpu: '100m', memory: '256Mi' } } },
              },
              envoyService: { type: 'LoadBalancer', externalTrafficPolicy: 'Local' },
            },
          },
          logging: { level: { default: 'warn' } },
          telemetry: {
            metrics: { prometheus: {} },
            accessLog: {
              settings: [
                {
                  format: { type: 'JSON' },
                  sinks: [{ type: 'File', file: { path: '/dev/stdout' } }],
                },
              ],
            },
          },
          shutdown: { drainTimeout: '60s' },
        },
      },
    ),
  );
}

/** The Deployment + Service Envoy Gateway generates for one Gateway; returns its address. */
function buildEnvoyProxy(db: ClusterDb, gw: { name: string; namespace: string; ports: number[] }) {
  const hash = hexId(db.rand, 8);
  const name = `envoy-${gw.namespace}-${gw.name}-${hash}`;
  const owning = {
    'app.kubernetes.io/name': 'envoy',
    'app.kubernetes.io/component': 'proxy',
    'app.kubernetes.io/managed-by': 'envoy-gateway',
    'gateway.envoyproxy.io/owning-gateway-name': gw.name,
    'gateway.envoyproxy.io/owning-gateway-namespace': gw.namespace,
  };
  buildDeployment(db, {
    namespace: EG_NAMESPACE,
    name,
    age: 40 * DAY,
    replicas: 2,
    labels: owning,
    template: tpl(
      name,
      [
        {
          name: 'envoy',
          image: 'docker.io/envoyproxy/envoy:distroless-v1.36.2',
          ports: [
            ...gw.ports.map((p) => ({ name: `port-${p}`, port: 10000 + p })),
            { name: 'metrics', port: 19001 },
          ],
          cpu: ['100m', '1'],
          mem: ['256Mi', '1Gi'],
          probe: 'http',
          probePath: '/ready',
        },
        {
          name: 'shutdown-manager',
          image: 'docker.io/envoyproxy/gateway:v1.6.2',
          cpu: ['10m', '100m'],
          mem: ['32Mi', '64Mi'],
        },
      ],
      { labels: owning, sa: name },
    ),
  });
  const svc = buildService(db, {
    namespace: EG_NAMESPACE,
    name,
    type: 'LoadBalancer',
    selector: { app: name },
    labels: owning,
    ports: gw.ports.map((p) => ({
      name: `${p === 443 ? 'https' : p === 80 ? 'http' : 'tcp'}-${p}`,
      port: p,
      targetPort: 10000 + p,
    })),
  }) as KubeObject | undefined;
  const ingress = ((
    svc?.status as
      { loadBalancer?: { ingress?: Array<{ ip?: string; hostname?: string }> } } | undefined
  )?.loadBalancer?.ingress ?? [])[0];
  return ingress?.ip
    ? [{ type: 'IPAddress', value: ingress.ip }]
    : ingress?.hostname
      ? [{ type: 'Hostname', value: ingress.hostname }]
      : [];
}

function buildEnvoyGateway(db: ClusterDb) {
  const p = db.profile;
  const staging = p.id === 'c-staging';
  const dev = p.id === 'c-dev';
  buildEnvoyController(db);
  gatewayClass(db, 'envoy', EG_CONTROLLER, {
    description: 'Envoy Gateway managed by the platform team',
    parametersRef: {
      group: ENVOY,
      kind: 'EnvoyProxy',
      name: 'default-proxy',
      namespace: EG_NAMESPACE,
    },
  });

  // public-gateway (web): HTTP → HTTPS redirect, HTTPS for the shop.
  const publicAddr = buildEnvoyProxy(db, {
    name: 'public-gateway',
    namespace: 'web',
    ports: [80, 443],
  });
  const listeners: ListenerSpec[] = [
    { name: 'http', protocol: 'HTTP', port: 80, allowedRoutes: { namespaces: { from: 'Same' } } },
    {
      name: 'https',
      protocol: 'HTTPS',
      port: 443,
      hostname: `*.shop.${p.domain}`,
      tls: { mode: 'Terminate', certificateRefs: [{ kind: 'Secret', name: 'storefront-tls' }] },
      allowedRoutes: { namespaces: { from: 'All' } },
    },
  ];
  gateway(db, {
    name: 'public-gateway',
    namespace: 'web',
    className: 'envoy',
    listeners,
    attached: { http: 1, https: staging ? 3 : 4 },
    addresses: publicAddr,
  });

  // Routes on public-gateway.
  const storefrontBackends = [{ name: 'web-gateway', port: 8080 }];
  if (find(db, 'services', 'web', 'image-resizer'))
    storefrontBackends.push({ name: 'image-resizer', port: 80 });
  route(
    db,
    'HTTPRoute',
    'storefront-api',
    'web',
    {
      parentRefs: [parentRef({ name: 'public-gateway', sectionName: 'https' })],
      hostnames: [`api.shop.${p.domain}`],
      rules: storefrontBackends.map((b) => ({
        matches: [{ path: { type: 'PathPrefix', value: `/${b.name}` } }],
        filters: [
          {
            type: 'RequestHeaderModifier',
            requestHeaderModifier: { add: [{ name: 'x-shop', value: 'storefront' }] },
          },
        ],
        backendRefs: [{ name: b.name, port: b.port }],
      })),
    },
    routeStatus(EG_CONTROLLER, [
      { name: 'public-gateway', namespace: 'web', sectionName: 'https' },
    ]),
    60 * DAY,
  );
  route(
    db,
    'HTTPRoute',
    'https-redirect',
    'web',
    {
      parentRefs: [parentRef({ name: 'public-gateway', sectionName: 'http' })],
      rules: [
        {
          filters: [
            { type: 'RequestRedirect', requestRedirect: { scheme: 'https', statusCode: 301 } },
          ],
        },
      ],
    },
    routeStatus(EG_CONTROLLER, [{ name: 'public-gateway', namespace: 'web', sectionName: 'http' }]),
    60 * DAY,
  );
  route(
    db,
    'GRPCRoute',
    'payments-grpc',
    'checkout',
    {
      parentRefs: [parentRef({ name: 'public-gateway', namespace: 'web', sectionName: 'https' })],
      hostnames: [`grpc.shop.${p.domain}`],
      rules: [
        {
          matches: [{ method: { service: 'acme.payments.v1.Payments' } }],
          backendRefs: [{ name: 'payment-api', port: 9090 }],
        },
      ],
    },
    routeStatus(EG_CONTROLLER, [
      { name: 'public-gateway', namespace: 'web', sectionName: 'https' },
    ]),
  );
  // A web route sending checkout traffic to the payment API in another namespace:
  // permitted by a ReferenceGrant except on staging, where the grant is missing.
  route(
    db,
    'HTTPRoute',
    'checkout',
    'web',
    {
      parentRefs: [parentRef({ name: 'public-gateway', sectionName: 'https' })],
      hostnames: [`checkout.shop.${p.domain}`],
      rules: [
        {
          matches: [{ path: { type: 'PathPrefix', value: '/' } }],
          backendRefs: [{ name: 'payment-api', namespace: 'checkout', port: 80 }],
        },
      ],
    },
    routeStatus(EG_CONTROLLER, [
      {
        name: 'public-gateway',
        namespace: 'web',
        sectionName: 'https',
        ...(staging
          ? {
              resolved: [
                'False',
                'RefNotPermitted',
                'Backend ref to Service checkout/payment-api not permitted by any ReferenceGrant.',
              ] as [string, string, string],
            }
          : {}),
      },
    ]),
  );
  if (!staging)
    put(
      db,
      obj(
        `${GROUP}/v1beta1`,
        'ReferenceGrant',
        meta({ name: 'allow-web-routes', namespace: 'checkout', age: 45 * DAY }),
        {
          spec: {
            from: [{ group: GROUP, kind: 'HTTPRoute', namespace: 'web' }],
            to: [{ group: '', kind: 'Service', name: 'payment-api' }],
          },
        },
      ),
    );

  if (staging) {
    // sectionName that no listener has.
    route(
      db,
      'HTTPRoute',
      'legacy-api',
      'web',
      {
        parentRefs: [parentRef({ name: 'public-gateway', sectionName: 'http-alt' })],
        hostnames: [`legacy.shop.${p.domain}`],
        rules: [{ backendRefs: [{ name: 'web-gateway', port: 8080 }] }],
      },
      routeStatus(EG_CONTROLLER, [
        {
          name: 'public-gateway',
          namespace: 'web',
          sectionName: 'http-alt',
          accepted: ['False', 'NoMatchingParent', 'No listeners match this parent ref'],
        },
      ]),
      9 * DAY,
    );
    // A hostname outside the listener's wildcard.
    route(
      db,
      'HTTPRoute',
      'blog',
      'web',
      {
        parentRefs: [parentRef({ name: 'public-gateway', sectionName: 'https' })],
        hostnames: ['blog.acme-news.org'],
        rules: [{ backendRefs: [{ name: 'storefront', port: 80 }] }],
      },
      routeStatus(EG_CONTROLLER, [
        {
          name: 'public-gateway',
          namespace: 'web',
          sectionName: 'https',
          accepted: [
            'False',
            'NoMatchingListenerHostname',
            'There were no hostname intersections between the HTTPRoute and this parent ref',
          ],
        },
      ]),
      4 * DAY,
    );
    // A route from team namespaces onto the HTTP listener, which only allows web.
    if (find(db, 'namespaces', null, 'data'))
      route(
        db,
        'HTTPRoute',
        'metrics-dashboard',
        'data',
        {
          parentRefs: [
            parentRef({ name: 'public-gateway', namespace: 'web', sectionName: 'http' }),
          ],
          rules: [{ backendRefs: [{ name: 'redis', port: 6379 }] }],
        },
        routeStatus(EG_CONTROLLER, [
          {
            name: 'public-gateway',
            namespace: 'web',
            sectionName: 'http',
            accepted: [
              'False',
              'NotAllowedByListeners',
              'No listeners included by this parent ref allowed this attachment.',
            ],
          },
        ]),
        2 * DAY,
      );

    // Experimental channel: TLS passthrough, TCP and UDP on an edge gateway.
    const edgeAddr = buildEnvoyProxy(db, {
      name: 'edge-gateway',
      namespace: 'data',
      ports: [5432, 6379, 5353],
    });
    gateway(db, {
      name: 'edge-gateway',
      namespace: 'data',
      className: 'envoy',
      listeners: [
        {
          name: 'postgres-tls',
          protocol: 'TLS',
          port: 5432,
          hostname: `db.${p.domain}`,
          tls: { mode: 'Passthrough' },
        },
        { name: 'redis', protocol: 'TCP', port: 6379 },
        { name: 'dns', protocol: 'UDP', port: 5353 },
      ],
      attached: { 'postgres-tls': 1, redis: 1, dns: 0 },
      addresses: edgeAddr,
    });
    route(
      db,
      'TLSRoute',
      'postgres',
      'data',
      {
        parentRefs: [parentRef({ name: 'edge-gateway', sectionName: 'postgres-tls' })],
        hostnames: [`db.${p.domain}`],
        rules: [{ backendRefs: [{ name: 'postgres', port: 5432 }] }],
      },
      routeStatus(EG_CONTROLLER, [
        { name: 'edge-gateway', namespace: 'data', sectionName: 'postgres-tls' },
      ]),
    );
    route(
      db,
      'TCPRoute',
      'redis',
      'data',
      {
        parentRefs: [parentRef({ name: 'edge-gateway', sectionName: 'redis' })],
        rules: [{ backendRefs: [{ name: 'redis', port: 6379 }] }],
      },
      routeStatus(EG_CONTROLLER, [
        { name: 'edge-gateway', namespace: 'data', sectionName: 'redis' },
      ]),
    );
    route(
      db,
      'UDPRoute',
      'cluster-dns',
      'data',
      {
        parentRefs: [parentRef({ name: 'edge-gateway', sectionName: 'dns' })],
        rules: [{ backendRefs: [{ name: 'kube-dns', namespace: 'kube-system', port: 53 }] }],
      },
      routeStatus(EG_CONTROLLER, [
        {
          name: 'edge-gateway',
          namespace: 'data',
          sectionName: 'dns',
          resolved: [
            'False',
            'RefNotPermitted',
            'Backend ref to Service kube-system/kube-dns not permitted by any ReferenceGrant.',
          ],
        },
      ]),
      3 * DAY,
    );
  }

  if (dev) {
    // A canary split whose second backend does not exist.
    route(
      db,
      'HTTPRoute',
      'storefront-canary',
      'web',
      {
        parentRefs: [parentRef({ name: 'public-gateway', sectionName: 'https' })],
        hostnames: [`canary.shop.${p.domain}`],
        rules: [
          {
            backendRefs: [
              { name: 'storefront', port: 80, weight: 90 },
              { name: 'storefront-v2', port: 80, weight: 10 },
            ],
          },
        ],
      },
      routeStatus(EG_CONTROLLER, [
        {
          name: 'public-gateway',
          namespace: 'web',
          sectionName: 'https',
          resolved: [
            'False',
            'BackendNotFound',
            'Failed to process route rule 0 backendRef 1: service web/storefront-v2 not found.',
          ],
        },
      ]),
      1 * DAY,
    );
  }

  // Policies.
  put(
    db,
    obj(
      ENVOY_API,
      'ClientTrafficPolicy',
      meta({ name: 'public-client', namespace: 'web', age: 50 * DAY }),
      {
        spec: {
          targetRefs: [{ group: GROUP, kind: 'Gateway', name: 'public-gateway' }],
          timeout: { http: { requestReceivedTimeout: '30s' } },
          tls: { minVersion: '1.2', alpnProtocols: ['h2', 'http/1.1'] },
          http3: {},
          clientIPDetection: { xForwardedFor: { numTrustedHops: 1 } },
        },
        status: ancestorStatus(EG_CONTROLLER, { name: 'public-gateway', namespace: 'web' }),
      },
    ),
  );
  put(
    db,
    obj(
      ENVOY_API,
      'BackendTrafficPolicy',
      meta({ name: 'gateway-defaults', namespace: 'web', age: 50 * DAY }),
      {
        spec: {
          targetRefs: [{ group: GROUP, kind: 'Gateway', name: 'public-gateway' }],
          rateLimit: {
            type: 'Local',
            local: { rules: [{ limit: { requests: 200, unit: 'Second' } }] },
          },
          timeout: { http: { requestTimeout: '15s' } },
        },
        status: ancestorStatus(EG_CONTROLLER, { name: 'public-gateway', namespace: 'web' }, [
          condition('Accepted'),
          condition(
            'Overridden',
            'True',
            'Overridden',
            'This policy is being overridden by other backendTrafficPolicies for these routes: [web/storefront-api]',
          ),
        ]),
      },
    ),
  );
  put(
    db,
    obj(
      ENVOY_API,
      'BackendTrafficPolicy',
      meta({ name: 'storefront-resilience', namespace: 'web', age: 30 * DAY }),
      {
        spec: {
          targetRefs: [{ group: GROUP, kind: 'HTTPRoute', name: 'storefront-api' }],
          retry: {
            numRetries: 3,
            retryOn: {
              triggers: ['connect-failure', 'retriable-status-codes'],
              httpStatusCodes: [503],
            },
          },
          circuitBreaker: { maxConnections: 1024, maxPendingRequests: 128 },
          loadBalancer: { type: 'LeastRequest' },
          healthCheck: {
            passive: { consecutive5XxErrors: 5, interval: '10s', baseEjectionTime: '30s' },
          },
        },
        status: ancestorStatus(EG_CONTROLLER, {
          name: 'public-gateway',
          namespace: 'web',
          sectionName: 'https',
        }),
      },
    ),
  );
  put(
    db,
    obj(ENVOY_API, 'SecurityPolicy', meta({ name: 'api-auth', namespace: 'web', age: 30 * DAY }), {
      spec: {
        targetRefs: [{ group: GROUP, kind: 'HTTPRoute', name: 'storefront-api' }],
        jwt: {
          providers: [
            {
              name: 'acme-sso',
              issuer: `https://sso.${p.domain}`,
              remoteJWKS: { uri: `https://sso.${p.domain}/.well-known/jwks.json` },
            },
          ],
        },
        cors: { allowOrigins: [`https://shop.${p.domain}`], allowMethods: ['GET', 'POST'] },
      },
      status: ancestorStatus(EG_CONTROLLER, {
        name: 'public-gateway',
        namespace: 'web',
        sectionName: 'https',
      }),
    }),
  );
  if (staging)
    put(
      db,
      obj(
        ENVOY_API,
        'SecurityPolicy',
        meta({ name: 'admin-basic-auth', namespace: 'web', age: 6 * DAY }),
        {
          spec: {
            targetRefs: [{ group: GROUP, kind: 'HTTPRoute', name: 'admin' }],
            basicAuth: { users: { name: 'admin-htpasswd' } },
          },
        },
      ),
    );
  put(
    db,
    obj(
      ENVOY_API,
      'EnvoyExtensionPolicy',
      meta({ name: 'request-id', namespace: 'web', age: 20 * DAY }),
      {
        spec: {
          targetRefs: [{ group: GROUP, kind: 'Gateway', name: 'public-gateway' }],
          wasm: [
            {
              name: 'request-id',
              rootID: 'request_id',
              code: { type: 'Image', image: { url: 'ghcr.io/acme/wasm/request-id:1.2.0' } },
            },
          ],
        },
        status: ancestorStatus(EG_CONTROLLER, { name: 'public-gateway', namespace: 'web' }),
      },
    ),
  );
  put(
    db,
    obj(
      ENVOY_API,
      'EnvoyPatchPolicy',
      meta({ name: 'listener-buffer', namespace: 'web', age: 20 * DAY }),
      {
        spec: {
          targetRef: { group: GROUP, kind: 'Gateway', name: 'public-gateway' },
          type: 'JSONPatch',
          jsonPatches: [
            {
              type: 'type.googleapis.com/envoy.config.listener.v3.Listener',
              name: 'web/public-gateway/https',
              operation: { op: 'add', path: '/per_connection_buffer_limit_bytes', value: 1048576 },
            },
          ],
        },
        status: ancestorStatus(EG_CONTROLLER, { name: 'public-gateway', namespace: 'web' }, [
          condition('Accepted'),
          condition('Programmed'),
        ]),
      },
    ),
  );
  put(
    db,
    obj(
      `${GROUP}/v1`,
      'BackendTLSPolicy',
      meta({ name: 'payment-api-tls', namespace: 'checkout', age: 30 * DAY }),
      {
        spec: {
          targetRefs: [{ group: '', kind: 'Service', name: 'payment-api', sectionName: 'http' }],
          validation: {
            hostname: 'payment-api.checkout.svc.cluster.local',
            caCertificateRefs: [{ group: '', kind: 'ConfigMap', name: 'payment-ca' }],
          },
        },
        status: ancestorStatus(EG_CONTROLLER, { name: 'public-gateway', namespace: 'web' }, [
          condition('Accepted'),
          condition('ResolvedRefs'),
        ]),
      },
    ),
  );
}

// ---------------------------------------------------------------------------
// Other implementations
// ---------------------------------------------------------------------------

function buildProdUs(db: ClusterDb) {
  const p = db.profile;
  // Istio serves the shop; an NGINX class was created but its controller never installed.
  gatewayClass(db, 'istio', 'istio.io/gateway-controller', {
    description: 'The default Istio GatewayClass',
  });
  gatewayClass(db, 'nginx', 'gateway.nginx.org/nginx-gateway-controller', {}, false);
  gateway(db, {
    name: 'mesh-ingress',
    namespace: 'web',
    className: 'istio',
    listeners: [
      {
        name: 'https',
        protocol: 'HTTPS',
        port: 443,
        hostname: `*.${p.domain}`,
        tls: { mode: 'Terminate', certificateRefs: [{ name: 'wildcard-tls' }] },
        allowedRoutes: { namespaces: { from: 'All' } },
      },
    ],
    attached: { https: 2 },
    addresses: [{ type: 'Hostname', value: `a3f9c1d2e7.elb.${p.region}.amazonaws.com` }],
  });
  route(
    db,
    'HTTPRoute',
    'storefront',
    'web',
    {
      parentRefs: [parentRef({ name: 'mesh-ingress' })],
      hostnames: [`shop.${p.domain}`],
      rules: [
        {
          matches: [{ path: { type: 'PathPrefix', value: '/api' } }],
          backendRefs: [{ name: 'web-gateway', port: 8080 }],
        },
        { backendRefs: [{ name: 'storefront', port: 80 }] },
      ],
    },
    routeStatus('istio.io/gateway-controller', [{ name: 'mesh-ingress', namespace: 'web' }]),
  );
  route(
    db,
    'GRPCRoute',
    'payments-grpc',
    'checkout',
    {
      parentRefs: [parentRef({ name: 'mesh-ingress', namespace: 'web' })],
      hostnames: [`grpc.${p.domain}`],
      rules: [{ backendRefs: [{ name: 'payment-api', port: 9090 }] }],
    },
    routeStatus('istio.io/gateway-controller', [{ name: 'mesh-ingress', namespace: 'web' }]),
  );
  gateway(db, {
    name: 'edge',
    namespace: 'web',
    className: 'nginx',
    listeners: [{ name: 'http', protocol: 'HTTP', port: 80 }],
    attached: {},
    noStatus: true,
    age: 12 * DAY,
  });
  route(
    db,
    'HTTPRoute',
    'status-page',
    'web',
    {
      parentRefs: [parentRef({ name: 'edge' })],
      hostnames: [`status.${p.domain}`],
      rules: [{ backendRefs: [{ name: 'storefront', port: 80 }] }],
    },
    undefined,
    12 * DAY,
  );
}

function buildCilium(db: ClusterDb) {
  const p = db.profile;
  gatewayClass(db, 'cilium', 'io.cilium/gateway-controller', { description: 'Cilium Gateway API' });
  gateway(db, {
    name: 'internal',
    namespace: 'web',
    className: 'cilium',
    listeners: [{ name: 'http', protocol: 'HTTP', port: 80, hostname: `internal.${p.domain}` }],
    attached: { http: 1 },
    addresses: [{ type: 'IPAddress', value: '10.240.0.77' }],
  });
  route(
    db,
    'HTTPRoute',
    'internal-tools',
    'web',
    {
      parentRefs: [parentRef({ name: 'internal' })],
      hostnames: [`internal.${p.domain}`],
      rules: [{ backendRefs: [{ name: 'web-gateway', port: 8080 }] }],
    },
    routeStatus('io.cilium/gateway-controller', [{ name: 'internal', namespace: 'web' }]),
  );
}

export function buildGatewayApi(db: ClusterDb) {
  if (!hasGatewayApi(db)) return;
  if (hasEnvoyGateway(db)) buildEnvoyGateway(db);
  if (db.profile.id === 'c-prod-us') buildProdUs(db);
  if (db.profile.platform === 'AKS') buildCilium(db);
}
