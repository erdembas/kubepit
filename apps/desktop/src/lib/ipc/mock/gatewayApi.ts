import YAML from 'yaml';
import type {
  EnvoyAdminEndpoint,
  EnvoyAdminResponse,
  GatewayApiCrdsManifest,
  KubeObject,
} from '@/types';
import { sleep } from './bus';
import { crdObject } from './fixtures/crds';
import { find, getDb, list, type ClusterDb } from './fixtures/db';
import {
  DEMO_BUNDLE_VERSION,
  gatewayChannelCrds,
  markGatewayApiInstalled,
} from './fixtures/gateway';
import { handlers, register, type MockArgs } from './registry';

/**
 * Demo Gateway API commands: `gateway_api_crds_manifest` serves a release
 * manifest built from the demo CRDs (with the backend's version checks),
 * applying it (`resource_apply_yaml`) makes the cluster serve the Gateway
 * API like the real install, and `envoy_admin` answers for Envoy Gateway's
 * proxy pods with a config dump, clusters and stats derived from the demo
 * Gateways, routes and endpoints.
 */

const GROUP = 'gateway.networking.k8s.io';
const OWNING_NAME = 'gateway.envoyproxy.io/owning-gateway-name';
const OWNING_NS = 'gateway.envoyproxy.io/owning-gateway-namespace';

function checkVersion(version: string) {
  const m = /^v(\d+)\.(\d+)\.(\d+)(-rc\.\d+)?$/.exec(version);
  if (!m)
    throw new Error(
      `invalid Gateway API version "${version}": expected vX.Y.Z (for example v1.7.0)`,
    );
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major < 1 || (major === 1 && minor < 1))
    throw new Error(`Gateway API ${version} is not supported: install v1.1.0 or later`);
}

register({
  gateway_api_crds_manifest: async ({
    channel,
    version,
  }: MockArgs): Promise<GatewayApiCrdsManifest> => {
    await sleep(700);
    const v = String(version).trim();
    checkVersion(v);
    if (channel !== 'standard' && channel !== 'experimental')
      throw new Error(`unknown channel "${channel}"`);
    const crds = gatewayChannelCrds(channel, v, 0).map(crdObject);
    for (const c of crds) {
      delete (c as { status?: unknown }).status;
      c.metadata = {
        name: c.metadata.name,
        annotations: c.metadata.annotations,
      } as KubeObject['metadata'];
    }
    const yaml = crds.map((c) => YAML.stringify(c, { lineWidth: 0 })).join('---\n');
    return {
      version: v,
      channel,
      url: `https://github.com/kubernetes-sigs/gateway-api/releases/download/${v}/${channel}-install.yaml`,
      yaml,
      bytes: yaml.length,
      crds: crds.map((c) => c.metadata.name),
      others: [],
    };
  },
});

// Applying the Gateway API CRDs makes the demo cluster serve them (discovery reads the flag).
const applyYaml = handlers.resource_apply_yaml!;
register({
  resource_apply_yaml: async (args: MockArgs) => {
    const result = (await applyYaml(args)) as KubeObject[];
    const crd = result.find(
      (o) =>
        o.kind === 'CustomResourceDefinition' &&
        (o.spec as { group?: string } | undefined)?.group === GROUP,
    );
    if (crd) {
      const a = crd.metadata.annotations ?? {};
      const channel =
        a['gateway.networking.k8s.io/channel'] === 'experimental' ? 'experimental' : 'standard';
      markGatewayApiInstalled(
        getDb(args.clusterId),
        channel,
        a['gateway.networking.k8s.io/bundle-version'] ?? DEMO_BUNDLE_VERSION,
      );
    }
    return result;
  },
});

// ---------------------------------------------------------------------------
// Envoy admin
// ---------------------------------------------------------------------------

const VERSION = 'b6bf3d2e4f7b1e5a9c3d8f0e2a4b6c8d1e3f5a7b/1.36.2/Clean/RELEASE/BoringSSL';

interface Ctx {
  db: ClusterDb;
  pod: KubeObject;
  gateway: KubeObject;
  routes: KubeObject[];
}

const nsOf = (o: KubeObject) => o.metadata.namespace ?? '';
const host = (h: string) => h.replace(/\*/g, 'wildcard').replace(/\./g, '_');

function routesFor(db: ClusterDb, gw: KubeObject): KubeObject[] {
  const kinds = ['httproutes', 'grpcroutes', 'tlsroutes', 'tcproutes', 'udproutes'].map(
    (p) => `${p}.${GROUP}`,
  );
  return (
    kinds
      .flatMap((k) => list(db, k))
      .filter((r) =>
        (
          (r.spec as { parentRefs?: Array<{ name?: string; namespace?: string }> }).parentRefs ?? []
        ).some((p) => p.name === gw.metadata.name && (p.namespace ?? nsOf(r)) === nsOf(gw)),
      )
      // Only routes the controller accepted are programmed.
      .filter((r) =>
        (
          (
            r.status as
              | { parents?: Array<{ conditions?: Array<{ type: string; status: string }> }> }
              | undefined
          )?.parents ?? []
        ).some((p) => p.conditions?.some((c) => c.type === 'Accepted' && c.status === 'True')),
      )
  );
}

interface Listener {
  name: string;
  port: number;
  protocol: string;
  hostname?: string;
  tls?: { certificateRefs?: Array<{ name: string; namespace?: string }> };
}

const listenersOf = (gw: KubeObject) => (gw.spec as { listeners?: Listener[] }).listeners ?? [];

interface Rule {
  matches?: Array<{
    path?: { type?: string; value?: string };
    method?: { service?: string; method?: string };
  }>;
  backendRefs?: Array<{ name: string; namespace?: string; port?: number; weight?: number }>;
  filters?: Array<{ type: string }>;
}

const rulesOf = (r: KubeObject) => (r.spec as { rules?: Rule[] }).rules ?? [];
const clusterName = (r: KubeObject, i: number) =>
  `${r.kind.toLowerCase()}/${nsOf(r)}/${r.metadata.name}/rule/${i}`;

function configDump(c: Ctx) {
  const gwNs = nsOf(c.gateway);
  const gwName = c.gateway.metadata.name;
  const listeners = listenersOf(c.gateway);
  const lname = (l: Listener) => `${gwNs}/${gwName}/${l.name}`;
  const http = (l: Listener) => l.protocol === 'HTTP' || l.protocol === 'HTTPS';
  const routeConfigs = listeners.filter(http).map((l) => {
    const attached = c.routes.filter(
      (r) =>
        (r.kind === 'HTTPRoute' || r.kind === 'GRPCRoute') &&
        ((r.spec as { parentRefs?: Array<{ sectionName?: string }> }).parentRefs ?? []).some(
          (p) => !p.sectionName || p.sectionName === l.name,
        ),
    );
    const hosts = new Map<string, Array<Record<string, unknown>>>();
    for (const r of attached) {
      const names = ((r.spec as { hostnames?: string[] }).hostnames ?? []) as string[];
      for (const h of names.length ? names : [l.hostname ?? '*']) {
        const routes = hosts.get(h) ?? [];
        rulesOf(r).forEach((rule, i) => {
          const redirect = rule.filters?.some((f) => f.type === 'RequestRedirect');
          (rule.matches?.length ? rule.matches : [{}]).forEach((m, j) => {
            const match =
              r.kind === 'GRPCRoute'
                ? { prefix: `/${m.method?.service ?? ''}/` }
                : m.path?.type === 'Exact'
                  ? { path: m.path.value }
                  : {
                      path_separated_prefix:
                        m.path?.value && m.path.value !== '/' ? m.path.value : undefined,
                      prefix: m.path?.value === '/' || !m.path ? '/' : undefined,
                    };
            const backends = rule.backendRefs ?? [];
            routes.push({
              name: `${r.kind.toLowerCase()}/${nsOf(r)}/${r.metadata.name}/rule/${i}/match/${j}/${host(h)}`,
              match: JSON.parse(JSON.stringify(match)),
              ...(redirect
                ? { redirect: { scheme_redirect: 'https', response_code: 'MOVED_PERMANENTLY' } }
                : backends.length > 1
                  ? {
                      route: {
                        weighted_clusters: {
                          clusters: backends.map((b, k) => ({
                            name: `${clusterName(r, i)}/backend/${k}`,
                            weight: b.weight ?? 1,
                          })),
                        },
                      },
                    }
                  : { route: { cluster: clusterName(r, i), timeout: '15s' } }),
            });
          });
        });
        hosts.set(h, routes);
      }
    }
    return {
      route_config: {
        '@type': 'type.googleapis.com/envoy.config.route.v3.RouteConfiguration',
        name: lname(l),
        virtual_hosts: [...hosts.entries()].map(([h, routes]) => ({
          name: `${lname(l)}/${host(h)}`,
          domains: [h === '*' ? '*' : h],
          routes,
        })),
        ignore_port_in_host_matching: true,
      },
      last_updated: new Date(Date.now() - 3600_000).toISOString(),
    };
  });
  const clusters = c.routes.flatMap((r) =>
    rulesOf(r).map((rule, i) => ({
      cluster: {
        '@type': 'type.googleapis.com/envoy.config.cluster.v3.Cluster',
        name: clusterName(r, i),
        type: 'EDS',
        eds_cluster_config: {
          eds_config: { ads: {}, resource_api_version: 'V3' },
          service_name: clusterName(r, i),
        },
        connect_timeout: '10s',
        lb_policy: 'LEAST_REQUEST',
        ...(rule.backendRefs?.length
          ? {}
          : { load_assignment: { cluster_name: clusterName(r, i) } }),
      },
      last_updated: new Date(Date.now() - 3600_000).toISOString(),
    })),
  );
  const secrets = listeners.flatMap((l) =>
    (l.tls?.certificateRefs ?? []).map((ref) => ({
      name: `${ref.namespace ?? gwNs}/${ref.name}`,
      last_updated: new Date(Date.now() - 86_400_000).toISOString(),
      secret: {
        '@type': 'type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
        name: `${ref.namespace ?? gwNs}/${ref.name}`,
        tls_certificate: {
          certificate_chain: { inline_bytes: 'W3JlZGFjdGVkXQ==' },
          private_key: { inline_bytes: 'W3JlZGFjdGVkXQ==' },
        },
      },
    })),
  );
  return {
    configs: [
      {
        '@type': 'type.googleapis.com/envoy.admin.v3.BootstrapConfigDump',
        bootstrap: {
          node: {
            id: `${c.pod.metadata.name}.${nsOf(c.pod)}`,
            cluster: `${gwNs}/${gwName}`,
            user_agent_name: 'envoy',
            user_agent_build_version: { version: { major_number: 1, minor_number: 36, patch: 2 } },
          },
          admin: { address: { socket_address: { address: '127.0.0.1', port_value: 19000 } } },
          dynamic_resources: {
            ads_config: { api_type: 'DELTA_GRPC' },
            lds_config: { ads: {} },
            cds_config: { ads: {} },
          },
        },
      },
      {
        '@type': 'type.googleapis.com/envoy.admin.v3.ListenersConfigDump',
        static_listeners: [
          {
            listener: {
              name: 'envoy-gateway-proxy-ready-0.0.0.0-19001',
              address: { socket_address: { address: '0.0.0.0', port_value: 19001 } },
              filter_chains: [
                { filters: [{ name: 'envoy.filters.network.http_connection_manager' }] },
              ],
            },
          },
        ],
        dynamic_listeners: listeners.map((l) => ({
          name: lname(l),
          active_state: {
            version_info: 'd5a3e1f0',
            listener: {
              '@type': 'type.googleapis.com/envoy.config.listener.v3.Listener',
              name: lname(l),
              address: { socket_address: { address: '0.0.0.0', port_value: 10000 + l.port } },
              filter_chains: [
                {
                  ...(l.hostname && (l.protocol === 'HTTPS' || l.protocol === 'TLS')
                    ? { filter_chain_match: { server_names: [l.hostname] } }
                    : {}),
                  filters: [
                    {
                      name: http(l)
                        ? 'envoy.filters.network.http_connection_manager'
                        : l.protocol === 'UDP'
                          ? 'envoy.filters.udp_listener.udp_proxy'
                          : 'envoy.filters.network.tcp_proxy',
                    },
                  ],
                },
              ],
            },
            last_updated: new Date(Date.now() - 3600_000).toISOString(),
          },
        })),
      },
      {
        '@type': 'type.googleapis.com/envoy.admin.v3.ClustersConfigDump',
        version_info: 'd5a3e1f0',
        static_clusters: [
          {
            cluster: {
              '@type': 'type.googleapis.com/envoy.config.cluster.v3.Cluster',
              name: 'xds_cluster',
              type: 'STRICT_DNS',
              connect_timeout: '10s',
            },
          },
        ],
        dynamic_active_clusters: clusters,
      },
      {
        '@type': 'type.googleapis.com/envoy.admin.v3.RoutesConfigDump',
        dynamic_route_configs: routeConfigs,
      },
      {
        '@type': 'type.googleapis.com/envoy.admin.v3.SecretsConfigDump',
        dynamic_active_secrets: secrets,
      },
    ],
  };
}

/** Pods behind a backend Service (selector match), with their IPs. */
function endpointsOf(db: ClusterDb, namespace: string, name: string) {
  const svc = find(db, 'services', namespace, name);
  const selector = (svc?.spec as { selector?: Record<string, string> } | undefined)?.selector;
  if (!selector) return [];
  return list(db, 'pods').filter(
    (p) =>
      nsOf(p) === namespace &&
      Object.entries(selector).every(([k, v]) => p.metadata.labels?.[k] === v),
  );
}

function seed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Counters that grow with time, deterministic per name. */
function counter(name: string, perMinute: number): number {
  const minutes = Math.floor(Date.now() / 60_000) % 100_000;
  return Math.round(((seed(name) % 1000) + 1000) * (perMinute / 10) + minutes * perMinute);
}

function clusters(c: Ctx) {
  return {
    cluster_statuses: c.routes.flatMap((r) =>
      rulesOf(r).map((rule, i) => {
        const hosts = (rule.backendRefs ?? []).flatMap((b) =>
          endpointsOf(c.db, b.namespace ?? nsOf(r), b.name).map((pod) => {
            const ip = (pod.status as { podIP?: string } | undefined)?.podIP ?? '10.0.0.1';
            const ready = (
              (pod.status as { conditions?: Array<{ type: string; status: string }> } | undefined)
                ?.conditions ?? []
            ).some((cond) => cond.type === 'Ready' && cond.status === 'True');
            const key = `${clusterName(r, i)}|${pod.metadata.name}`;
            const total = counter(key, 40);
            return {
              address: { socket_address: { address: ip, port_value: b.port ?? 80 } },
              stats: [
                { name: 'cx_active', type: 'GAUGE', value: String(seed(key) % 24) },
                { name: 'rq_total', value: String(total) },
                {
                  name: 'rq_error',
                  value: String(ready ? Math.floor(total / 900) : Math.floor(total / 20)),
                },
                { name: 'rq_success', value: String(total - Math.floor(total / 900)) },
              ],
              health_status: ready
                ? { eds_health_status: 'HEALTHY' }
                : { eds_health_status: 'HEALTHY', failed_outlier_check: true },
              weight: b.weight ?? 1,
              locality: {},
            };
          }),
        );
        return { name: clusterName(r, i), added_via_api: true, host_statuses: hosts };
      }),
    ),
  };
}

function stats(c: Ctx, filter: string | null) {
  const listeners = listenersOf(c.gateway);
  const out: Array<{ name: string; value: number }> = [
    { name: 'server.state', value: 0 },
    { name: 'server.live', value: 1 },
    {
      name: 'server.uptime',
      value:
        Math.floor((Date.now() - Date.parse(c.pod.metadata.creationTimestamp ?? '')) / 1000) ||
        3600,
    },
    {
      name: 'server.memory_allocated',
      value: 48_000_000 + (seed(c.pod.metadata.name) % 8_000_000),
    },
    {
      name: 'cluster_manager.active_clusters',
      value: 1 + c.routes.reduce((n, r) => n + rulesOf(r).length, 0),
    },
    { name: 'listener_manager.total_listeners_active', value: listeners.length + 1 },
  ];
  for (const l of listeners) {
    const prefix = `http.${l.name}`;
    const total = counter(`${c.pod.metadata.name}|${l.name}`, 120);
    out.push(
      { name: `${prefix}.downstream_rq_total`, value: total },
      { name: `${prefix}.downstream_rq_2xx`, value: Math.floor(total * 0.97) },
      { name: `${prefix}.downstream_rq_4xx`, value: Math.floor(total * 0.025) },
      { name: `${prefix}.downstream_rq_5xx`, value: Math.floor(total * 0.004) },
      { name: `${prefix}.downstream_rq_active`, value: seed(prefix) % 40 },
      { name: `${prefix}.downstream_cx_active`, value: seed(`${prefix}cx`) % 120 },
    );
  }
  for (const r of c.routes)
    rulesOf(r).forEach((_, i) => {
      const name = clusterName(r, i);
      const total = counter(`${c.pod.metadata.name}|${name}`, 60);
      out.push(
        { name: `cluster.${name}.upstream_rq_total`, value: total },
        { name: `cluster.${name}.upstream_rq_5xx`, value: Math.floor(total / 800) },
        { name: `cluster.${name}.upstream_cx_active`, value: seed(name) % 30 },
        { name: `cluster.${name}.membership_healthy`, value: 2 },
      );
    });
  const re = filter ? new RegExp(filter) : null;
  return {
    stats: [
      ...out.filter((s) => !re || re.test(s.name)),
      {
        histograms: {
          supported_quantiles: [0, 25, 50, 75, 90, 95, 99, 99.5, 99.9, 100],
          details: [],
        },
      },
    ],
  };
}

function body(c: Ctx, endpoint: EnvoyAdminEndpoint, filter: string | null): string {
  switch (endpoint) {
    case 'server_info':
      return JSON.stringify({
        version: VERSION,
        state: 'LIVE',
        hot_restart_version: 'disabled',
        command_line_options: {
          service_cluster: `${nsOf(c.gateway)}/${c.gateway.metadata.name}`,
          service_node: c.pod.metadata.name,
          log_level: 'warn',
          concurrency: 2,
        },
        uptime_current_epoch: `${Math.max(60, Math.floor((Date.now() - Date.parse(c.pod.metadata.creationTimestamp ?? '')) / 1000))}s`,
        uptime_all_epochs: `${Math.max(60, Math.floor((Date.now() - Date.parse(c.pod.metadata.creationTimestamp ?? '')) / 1000))}s`,
        node: {
          id: `${c.pod.metadata.name}.${nsOf(c.pod)}`,
          cluster: `${nsOf(c.gateway)}/${c.gateway.metadata.name}`,
        },
      });
    case 'config_dump':
      return JSON.stringify(configDump(c));
    case 'clusters':
      return JSON.stringify(clusters(c));
    case 'stats':
      return JSON.stringify(stats(c, filter));
    case 'listeners':
      return JSON.stringify({
        listener_statuses: listenersOf(c.gateway).map((l) => ({
          name: `${nsOf(c.gateway)}/${c.gateway.metadata.name}/${l.name}`,
          local_address: { socket_address: { address: '0.0.0.0', port_value: 10000 + l.port } },
        })),
      });
    case 'ready':
      return 'LIVE\n';
    default:
      return JSON.stringify({ certificates: [] });
  }
}

register({
  envoy_admin: async ({
    clusterId,
    namespace,
    pod,
    port,
    endpoint,
    filter,
  }: MockArgs): Promise<EnvoyAdminResponse> => {
    await sleep(endpoint === 'config_dump' ? 450 : 220);
    const db = getDb(clusterId);
    const p = find(db, 'pods', namespace, pod);
    const remote = typeof port === 'number' ? port : 19000;
    if (!p)
      throw new Error(
        `Envoy admin port-forward to pod ${namespace}/${pod} failed: pods "${pod}" not found`,
      );
    const gwName = p.metadata.labels?.[OWNING_NAME];
    const gwNs = p.metadata.labels?.[OWNING_NS];
    const gateway = gwName && gwNs ? find(db, `gateways.${GROUP}`, gwNs, gwName) : undefined;
    if (!gateway || remote !== 19000)
      throw new Error(
        `port-forward to pod ${namespace}/${pod}:${remote}: error forwarding port ${remote} to pod: failed to connect to localhost:${remote} inside namespace: dial tcp4 127.0.0.1:${remote}: connect: connection refused`,
      );
    const text = body(
      { db, pod: p, gateway, routes: routesFor(db, gateway) },
      endpoint as EnvoyAdminEndpoint,
      (filter as string | null) ?? null,
    );
    return {
      endpoint,
      namespace,
      pod,
      port: remote,
      status: 200,
      body: text,
      bytes: text.length,
    };
  },
});
