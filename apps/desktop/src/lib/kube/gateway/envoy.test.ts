import { describe, expect, it } from 'vitest';
import {
  envoyPatches,
  envoyProxySummary,
  isEnvoyGatewayClass,
  parametersRef,
  proxySelector,
  xdsOrigin,
} from './envoy';
import {
  filterStats,
  parseClusters,
  parseServerInfo,
  parseStats,
  prettyBody,
  statHighlights,
  summarizeConfigDump,
} from './envoyAdmin';
import { ENVOY_GROUP } from './kinds';
import { policyBucket, policyFeatures, policySelectors, policyTargets } from './model';
import { cond, gateway, gatewayClass, kobj } from './testing';

const EG = 'gateway.envoyproxy.io/gatewayclass-controller';

describe('Envoy Gateway', () => {
  it('recognises its classes and labels', () => {
    expect(isEnvoyGatewayClass(gatewayClass('eg', EG))).toBe(true);
    expect(isEnvoyGatewayClass(gatewayClass('istio', 'istio.io/gateway-controller'))).toBe(false);
    const gw = gateway('public', 'web', []);
    expect(proxySelector(gw, false)).toBe(
      'gateway.envoyproxy.io/owning-gateway-name=public,gateway.envoyproxy.io/owning-gateway-namespace=web',
    );
    expect(proxySelector(gw, true)).toBe('gateway.envoyproxy.io/owning-gatewayclass=eg');
  });

  it('reads parametersRef of classes and gateways', () => {
    const cls = kobj('gateway.networking.k8s.io/v1', 'GatewayClass', 'eg', null, {
      spec: {
        controllerName: EG,
        parametersRef: {
          group: ENVOY_GROUP,
          kind: 'EnvoyProxy',
          name: 'cfg',
          namespace: 'envoy-gateway-system',
        },
      },
    });
    expect(parametersRef(cls)).toEqual({
      group: ENVOY_GROUP,
      kind: 'EnvoyProxy',
      name: 'cfg',
      namespace: 'envoy-gateway-system',
    });
    const gw = kobj('gateway.networking.k8s.io/v1', 'Gateway', 'g', 'web', {
      spec: {
        infrastructure: {
          parametersRef: { group: ENVOY_GROUP, kind: 'EnvoyProxy', name: 'custom' },
        },
      },
    });
    expect(parametersRef(gw)?.namespace).toBe('web');
  });

  it('summarises an EnvoyProxy and EnvoyPatchPolicy', () => {
    const ep = kobj(`${ENVOY_GROUP}/v1alpha1`, 'EnvoyProxy', 'cfg', 'envoy-gateway-system', {
      spec: {
        provider: {
          type: 'Kubernetes',
          kubernetes: { envoyDeployment: { replicas: 3 }, envoyService: { type: 'NodePort' } },
        },
        logging: { level: { default: 'warn' } },
        telemetry: { metrics: {}, accessLog: {} },
      },
    });
    expect(envoyProxySummary(ep)).toMatchObject({
      workload: 'Deployment',
      replicas: 3,
      serviceType: 'NodePort',
      logLevel: 'warn',
      telemetry: ['accessLog', 'metrics'],
    });
    const epp = kobj(`${ENVOY_GROUP}/v1alpha1`, 'EnvoyPatchPolicy', 'p', 'web', {
      spec: {
        type: 'JSONPatch',
        jsonPatches: [
          {
            type: 'type.googleapis.com/envoy.config.listener.v3.Listener',
            name: 'web/public/http',
            operation: { op: 'add', path: '/default_filter_chain' },
          },
        ],
      },
    });
    expect(envoyPatches(epp)).toEqual([
      { type: 'Listener', name: 'web/public/http', op: 'add', path: '/default_filter_chain' },
    ]);
  });

  it('maps xDS names back to Gateway API objects', () => {
    expect(xdsOrigin('httproute/web/storefront/rule/1/match/0/api_shop_example_com')).toEqual({
      kind: 'HTTPRoute',
      namespace: 'web',
      name: 'storefront',
      section: '1',
    });
    expect(xdsOrigin('web/public/https')).toEqual({
      kind: 'Gateway',
      namespace: 'web',
      name: 'public',
      section: 'https',
    });
    expect(xdsOrigin('envoy-gateway-proxy-ready-0.0.0.0-19001')).toBeNull();
  });

  it('reads policy targets, selectors, features and status', () => {
    const p = kobj(`${ENVOY_GROUP}/v1alpha1`, 'SecurityPolicy', 'auth', 'web', {
      spec: {
        targetRefs: [{ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: 'storefront' }],
        targetSelectors: [{ kind: 'HTTPRoute', matchLabels: { team: 'shop' } }],
        jwt: { providers: [] },
        cors: {},
      },
      status: {
        ancestors: [
          {
            ancestorRef: { name: 'public' },
            controllerName: EG,
            conditions: [cond('Accepted', 'True')],
          },
        ],
      },
    });
    expect(policyTargets(p)).toEqual([
      {
        group: 'gateway.networking.k8s.io',
        kind: 'HTTPRoute',
        namespace: 'web',
        name: 'storefront',
        sectionName: null,
      },
    ]);
    expect(policySelectors(p)).toEqual(['HTTPRoute team=shop']);
    expect(policyFeatures(p)).toEqual(['cors', 'jwt']);
    expect(policyBucket(p)).toBe('accepted');
  });
});

describe('Envoy admin parsing', () => {
  it('reads server_info', () => {
    const info = parseServerInfo(
      JSON.stringify({
        version: 'abc/1.36.2/Clean/RELEASE/BoringSSL',
        state: 'LIVE',
        uptime_current_epoch: '3600s',
        node: { id: 'envoy-web-public-1', cluster: 'web/public' },
      }),
    );
    expect(info).toEqual({
      version: 'abc/1.36.2/Clean/RELEASE/BoringSSL',
      state: 'LIVE',
      uptimeSeconds: 3600,
      nodeId: 'envoy-web-public-1',
      cluster: 'web/public',
    });
    expect(parseServerInfo('not json')).toBeNull();
  });

  it('summarises a config dump without secret contents', () => {
    const dump = {
      configs: [
        {
          '@type': 'type.googleapis.com/envoy.admin.v3.BootstrapConfigDump',
          bootstrap: {
            node: {
              id: 'n1',
              user_agent_build_version: {
                version: { major_number: 1, minor_number: 36, patch: 2 },
              },
            },
          },
        },
        {
          '@type': 'type.googleapis.com/envoy.admin.v3.ListenersConfigDump',
          dynamic_listeners: [
            {
              name: 'web/public/https',
              active_state: {
                listener: {
                  name: 'web/public/https',
                  address: { socket_address: { address: '0.0.0.0', port_value: 10443 } },
                  filter_chains: [
                    {
                      filter_chain_match: { server_names: ['api.shop.example.com'] },
                      filters: [{ name: 'envoy.filters.network.http_connection_manager' }],
                    },
                  ],
                },
              },
            },
          ],
        },
        {
          '@type': 'type.googleapis.com/envoy.admin.v3.RoutesConfigDump',
          dynamic_route_configs: [
            {
              route_config: {
                name: 'web/public/https',
                virtual_hosts: [
                  {
                    name: 'web/public/https/api_shop_example_com',
                    domains: ['api.shop.example.com'],
                    routes: [
                      {
                        name: 'httproute/web/storefront/rule/0/match/0/x',
                        match: { prefix: '/api' },
                        route: { cluster: 'httproute/web/storefront/rule/0' },
                      },
                      {
                        name: 'redirect',
                        match: { path: '/old' },
                        redirect: { path_redirect: '/new' },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
        {
          '@type': 'type.googleapis.com/envoy.admin.v3.ClustersConfigDump',
          static_clusters: [{ cluster: { name: 'xds_cluster', type: 'STRICT_DNS' } }],
          dynamic_active_clusters: [
            { cluster: { name: 'httproute/web/storefront/rule/0', type: 'EDS' } },
          ],
        },
        {
          '@type': 'type.googleapis.com/envoy.admin.v3.SecretsConfigDump',
          dynamic_active_secrets: [
            {
              name: 'web/storefront-tls',
              secret: { tls_certificate: { private_key: { inline_bytes: '[redacted]' } } },
            },
          ],
        },
      ],
    };
    const s = summarizeConfigDump(JSON.stringify(dump))!;
    expect(s.version).toBe('1.36.2');
    expect(s.listeners[0]).toMatchObject({
      name: 'web/public/https',
      address: '0.0.0.0:10443',
      state: 'active',
    });
    expect(s.listeners[0]!.chains[0]).toEqual({
      serverNames: ['api.shop.example.com'],
      filters: ['http_connection_manager'],
    });
    expect(s.virtualHosts[0]!.routes).toEqual([
      {
        name: 'httproute/web/storefront/rule/0/match/0/x',
        match: 'prefix /api',
        action: '→ httproute/web/storefront/rule/0',
      },
      { name: 'redirect', match: 'path /old', action: 'redirect' },
    ]);
    expect(s.clusters.map((c) => [c.name, c.dynamic])).toEqual([
      ['httproute/web/storefront/rule/0', true],
      ['xds_cluster', false],
    ]);
    expect(s.secrets).toEqual(['web/storefront-tls']);
    expect(JSON.stringify(s)).not.toContain('redacted');
  });

  it('reads cluster host health and stats', () => {
    const clusters = parseClusters(
      JSON.stringify({
        cluster_statuses: [
          {
            name: 'httproute/web/storefront/rule/0',
            host_statuses: [
              {
                address: { socket_address: { address: '10.0.1.4', port_value: 8080 } },
                stats: [
                  { name: 'rq_total', value: '42' },
                  { name: 'rq_error', value: '2' },
                ],
                health_status: { eds_health_status: 'HEALTHY' },
                weight: 1,
              },
              {
                address: { socket_address: { address: '10.0.1.5', port_value: 8080 } },
                health_status: { failed_outlier_check: true, eds_health_status: 'HEALTHY' },
              },
            ],
          },
        ],
      }),
    )!;
    expect(clusters[0]).toMatchObject({ healthy: 1 });
    expect(clusters[0]!.hosts.map((h) => [h.address, h.health, h.requests, h.errors])).toEqual([
      ['10.0.1.4:8080', 'HEALTHY', 42, 2],
      ['10.0.1.5:8080', 'FAILED_OUTLIER_CHECK', 0, 0],
    ]);

    const stats = parseStats(
      JSON.stringify({
        stats: [
          { name: 'server.state', value: 0 },
          { name: 'http.https.downstream_rq_total', value: 120 },
          { name: 'http.http.downstream_rq_total', value: 30 },
          { name: 'http.https.downstream_rq_5xx', value: 4 },
          { name: 'cluster.httproute/web/storefront/rule/0.upstream_rq_total', value: 110 },
          { histograms: { supported_quantiles: [] } },
        ],
      }),
    )!;
    expect(stats).toHaveLength(5);
    expect(statHighlights(stats)).toMatchObject({
      live: true,
      downstreamRequests: 150,
      downstream5xx: 4,
      upstreamRequests: 110,
    });
    expect(filterStats(stats, 'https rq')).toHaveLength(2);
    expect(prettyBody('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyBody('LIVE')).toBe('LIVE');
  });
});
