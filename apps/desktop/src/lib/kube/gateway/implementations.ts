import type { ApiResourceInfo } from '@/types';
import { kindKey } from '../catalog';
import { ENVOY_GROUP } from './kinds';

/**
 * Well-known Gateway API implementations, recognised by the
 * `GatewayClass.spec.controllerName` they register (`domain/path`), plus
 * the API groups of their policy and extension CRDs. Product names are never
 * translated. Extension kinds are listed only when discovery serves them.
 */

export type ImplementationId =
  | 'envoy-gateway'
  | 'istio'
  | 'cilium'
  | 'nginx-gateway-fabric'
  | 'kong'
  | 'traefik'
  | 'contour'
  | 'kgateway'
  | 'gloo'
  | 'agentgateway'
  | 'gke'
  | 'aws-lattice'
  | 'aws-lbc'
  | 'azure-agc'
  | 'consul'
  | 'apisix'
  | 'haproxy';

export interface ExtensionGroup {
  group: string;
  /** Only these kinds of the group (the group also serves unrelated kinds); unset = all. */
  kinds?: readonly string[];
}

export interface GatewayImplementation {
  id: ImplementationId;
  name: string;
  /** Controller name domains (`gateway.envoyproxy.io/gatewayclass-controller` → `gateway.envoyproxy.io`). */
  domains: readonly string[];
  docs: string;
  extensions: readonly ExtensionGroup[];
}

export const IMPLEMENTATIONS: readonly GatewayImplementation[] = [
  {
    id: 'envoy-gateway',
    name: 'Envoy Gateway',
    domains: ['gateway.envoyproxy.io'],
    docs: 'https://gateway.envoyproxy.io/docs/',
    extensions: [{ group: ENVOY_GROUP }],
  },
  {
    id: 'istio',
    name: 'Istio',
    domains: ['istio.io'],
    docs: 'https://istio.io/latest/docs/tasks/traffic-management/ingress/gateway-api/',
    extensions: [
      {
        group: 'networking.istio.io',
        kinds: ['DestinationRule', 'EnvoyFilter', 'ServiceEntry', 'Sidecar', 'ProxyConfig'],
      },
      { group: 'security.istio.io', kinds: ['AuthorizationPolicy', 'RequestAuthentication'] },
      { group: 'telemetry.istio.io' },
      { group: 'extensions.istio.io' },
    ],
  },
  {
    id: 'cilium',
    name: 'Cilium',
    domains: ['io.cilium'],
    docs: 'https://docs.cilium.io/en/stable/network/servicemesh/gateway-api/gateway-api/',
    extensions: [
      {
        group: 'cilium.io',
        kinds: ['CiliumEnvoyConfig', 'CiliumClusterwideEnvoyConfig', 'CiliumGatewayClassConfig'],
      },
    ],
  },
  {
    id: 'nginx-gateway-fabric',
    name: 'NGINX Gateway Fabric',
    domains: ['gateway.nginx.org'],
    docs: 'https://docs.nginx.com/nginx-gateway-fabric/',
    extensions: [{ group: 'gateway.nginx.org' }],
  },
  {
    id: 'kong',
    name: 'Kong',
    domains: ['konghq.com'],
    docs: 'https://developer.konghq.com/kubernetes-ingress-controller/gateway-api/',
    extensions: [
      {
        group: 'configuration.konghq.com',
        kinds: [
          'KongPlugin',
          'KongClusterPlugin',
          'KongConsumer',
          'KongUpstreamPolicy',
          'KongIngress',
        ],
      },
      { group: 'gateway-operator.konghq.com' },
    ],
  },
  {
    id: 'traefik',
    name: 'Traefik',
    domains: ['traefik.io'],
    docs: 'https://doc.traefik.io/traefik/routing/providers/kubernetes-gateway/',
    extensions: [
      {
        group: 'traefik.io',
        kinds: ['Middleware', 'MiddlewareTCP', 'TLSOption', 'ServersTransport', 'TLSStore'],
      },
    ],
  },
  {
    id: 'contour',
    name: 'Contour',
    domains: ['projectcontour.io'],
    docs: 'https://projectcontour.io/docs/main/config/gateway-api/',
    extensions: [{ group: 'projectcontour.io' }],
  },
  {
    id: 'kgateway',
    name: 'kgateway',
    domains: ['kgateway.dev'],
    docs: 'https://kgateway.dev/docs/',
    extensions: [{ group: 'gateway.kgateway.dev' }],
  },
  {
    id: 'gloo',
    name: 'Gloo Gateway',
    domains: ['solo.io'],
    docs: 'https://docs.solo.io/gateway/latest/',
    extensions: [{ group: 'gateway.solo.io' }],
  },
  {
    id: 'agentgateway',
    name: 'agentgateway',
    domains: ['agentgateway.dev'],
    docs: 'https://agentgateway.dev/docs/',
    extensions: [{ group: 'agentgateway.dev' }],
  },
  {
    id: 'gke',
    name: 'GKE Gateway',
    domains: ['networking.gke.io'],
    docs: 'https://cloud.google.com/kubernetes-engine/docs/concepts/gateway-api',
    extensions: [
      {
        group: 'networking.gke.io',
        kinds: [
          'GCPBackendPolicy',
          'GCPGatewayPolicy',
          'HealthCheckPolicy',
          'GCPTrafficDistributionPolicy',
        ],
      },
    ],
  },
  {
    id: 'aws-lattice',
    name: 'AWS Gateway API Controller',
    domains: ['application-networking.k8s.aws'],
    docs: 'https://www.gateway-api-controller.eks.aws.dev/',
    extensions: [{ group: 'application-networking.k8s.aws' }],
  },
  {
    id: 'aws-lbc',
    name: 'AWS Load Balancer Controller',
    domains: ['gateway.k8s.aws'],
    docs: 'https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/gateway/gateway/',
    extensions: [{ group: 'gateway.k8s.aws' }],
  },
  {
    id: 'azure-agc',
    name: 'Application Gateway for Containers',
    domains: ['alb.networking.azure.io'],
    docs: 'https://learn.microsoft.com/azure/application-gateway/for-containers/',
    extensions: [{ group: 'alb.networking.azure.io' }],
  },
  {
    id: 'consul',
    name: 'Consul API Gateway',
    domains: ['consul.hashicorp.com'],
    docs: 'https://developer.hashicorp.com/consul/docs/north-south/api-gateway',
    extensions: [
      {
        group: 'consul.hashicorp.com',
        kinds: [
          'GatewayClassConfig',
          'RouteAuthFilter',
          'RouteRetryFilter',
          'RouteTimeoutFilter',
          'GatewayPolicy',
        ],
      },
    ],
  },
  {
    id: 'apisix',
    name: 'Apache APISIX',
    domains: ['apisix.apache.org'],
    docs: 'https://apisix.apache.org/docs/ingress-controller/',
    extensions: [{ group: 'apisix.apache.org' }],
  },
  {
    id: 'haproxy',
    name: 'HAProxy',
    domains: ['haproxy.org', 'haproxy-ingress.github.io'],
    docs: 'https://www.haproxy.com/documentation/kubernetes-ingress/gateway-api/',
    extensions: [],
  },
];

const BY_ID = new Map(IMPLEMENTATIONS.map((i) => [i.id, i]));

/** `gateway.envoyproxy.io` of `gateway.envoyproxy.io/gatewayclass-controller`. */
export function controllerDomain(controllerName: string): string {
  const name = controllerName.trim();
  const slash = name.indexOf('/');
  return (slash < 0 ? name : name.slice(0, slash)).toLowerCase();
}

/** The implementation behind a controller name, or `null` for an unknown controller. */
export function implementationFor(controllerName: string): GatewayImplementation | null {
  const domain = controllerDomain(controllerName);
  if (!domain) return null;
  return (
    IMPLEMENTATIONS.find((impl) =>
      impl.domains.some((d) => domain === d || domain.endsWith(`.${d}`)),
    ) ?? null
  );
}

export function implementationById(id: ImplementationId): GatewayImplementation | undefined {
  return BY_ID.get(id);
}

/** Display name: the product, else the controller's domain (data, never translated). */
export function implementationName(controllerName: string): string {
  return implementationFor(controllerName)?.name ?? controllerDomain(controllerName);
}

/** The served policy and extension kinds of an implementation, one per kind key. */
export function servedExtensions(
  impl: GatewayImplementation,
  apiResources: readonly ApiResourceInfo[] | null | undefined,
): ApiResourceInfo[] {
  const seen = new Set<string>();
  const out: ApiResourceInfo[] = [];
  for (const ext of impl.extensions) {
    for (const r of apiResources ?? []) {
      if (r.group !== ext.group || (ext.kinds && !ext.kinds.includes(r.kind))) continue;
      const key = kindKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out.sort((a, b) => a.group.localeCompare(b.group) || a.kind.localeCompare(b.kind));
}

/**
 * Implementations whose extension CRDs are served although no GatewayClass
 * names them yet (installed, but no class created) — shown so their kinds
 * are still reachable from the overview.
 */
export function implementationsServing(
  apiResources: readonly ApiResourceInfo[] | null | undefined,
): GatewayImplementation[] {
  return IMPLEMENTATIONS.filter((impl) => servedExtensions(impl, apiResources).length > 0);
}
