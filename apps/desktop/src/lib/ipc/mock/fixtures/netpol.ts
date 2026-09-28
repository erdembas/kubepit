import type { CrdInput } from './crds';
import { buildDaemonSet } from './builders';
import { list, put, type ClusterDb } from './db';
import { tpl } from './template';
import { DAY, meta, obj } from './util';

/**
 * NetworkPolicy simulator demo: default-deny namespaces, allow rules by
 * labels, namespaces, ipBlocks and named ports, DNS egress allowances, and
 * Cilium (with its own policies, which the simulator does not evaluate)
 * on the AKS cluster. Runs last so the other fixtures stay unchanged.
 */

const NP = 'networking.k8s.io/v1';
const CILIUM = 'cilium.io';
const NAME = 'kubernetes.io/metadata.name';

/** The AKS demo cluster runs "Azure CNI powered by Cilium". */
function hasCilium(db: ClusterDb) {
  return db.profile.platform === 'AKS';
}

export function netpolCrds(db: ClusterDb): CrdInput[] {
  if (!hasCilium(db)) return [];
  return [
    {
      group: CILIUM,
      kind: 'CiliumNetworkPolicy',
      plural: 'ciliumnetworkpolicies',
      singular: 'ciliumnetworkpolicy',
      shortNames: ['cnp', 'ciliumnp'],
      scope: 'Namespaced',
      versions: ['v2'],
      categories: ['cilium', 'ciliumpolicy'],
      age: 180 * DAY,
    },
    {
      group: CILIUM,
      kind: 'CiliumClusterwideNetworkPolicy',
      plural: 'ciliumclusterwidenetworkpolicies',
      singular: 'ciliumclusterwidenetworkpolicy',
      shortNames: ['ccnp'],
      scope: 'Cluster',
      versions: ['v2'],
      categories: ['cilium', 'ciliumpolicy'],
      age: 180 * DAY,
    },
  ];
}

function policy(db: ClusterDb, namespace: string, name: string, spec: Record<string, unknown>) {
  put(db, obj(NP, 'NetworkPolicy', meta({ name, namespace, age: 60 * DAY }), { spec }));
}

const DNS_PEER = {
  namespaceSelector: { matchLabels: { [NAME]: 'kube-system' } },
  podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
};
const DNS_PORTS = [
  { protocol: 'UDP', port: 53 },
  { protocol: 'TCP', port: 53 },
];
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

function hasNamespace(db: ClusterDb, name: string) {
  return list(db, 'namespaces').some((n) => n.metadata.name === name);
}

function checkoutPolicies(db: ClusterDb) {
  const ns = 'checkout';
  policy(db, ns, 'default-deny-egress', { podSelector: {}, policyTypes: ['Egress'] });
  policy(db, ns, 'allow-dns', {
    podSelector: {},
    policyTypes: ['Egress'],
    egress: [{ to: [DNS_PEER], ports: DNS_PORTS }],
  });
  policy(db, ns, 'payment-api-egress', {
    podSelector: { matchLabels: { app: 'payment-api' } },
    policyTypes: ['Egress'],
    egress: [
      {
        to: [
          {
            namespaceSelector: { matchLabels: { [NAME]: 'data' } },
            podSelector: { matchLabels: { app: 'postgres' } },
          },
        ],
        ports: [{ port: 'tcp-postgresql' }],
      },
      { to: [{ ipBlock: { cidr: '203.0.113.0/24' } }], ports: [{ protocol: 'TCP', port: 443 }] },
    ],
  });
  policy(db, ns, 'cart-service-egress', {
    podSelector: { matchLabels: { app: 'cart-service' } },
    policyTypes: ['Egress'],
    egress: [
      {
        to: [
          {
            namespaceSelector: { matchLabels: { [NAME]: 'data' } },
            podSelector: { matchLabels: { app: 'redis' } },
          },
        ],
        ports: [{ port: 'redis' }],
      },
    ],
  });
  policy(db, ns, 'checkout-web-egress', {
    podSelector: { matchLabels: { app: 'checkout-web' } },
    policyTypes: ['Egress'],
    egress: [
      {
        to: [
          {
            podSelector: {
              matchExpressions: [
                { key: 'app', operator: 'In', values: ['payment-api', 'cart-service'] },
              ],
            },
          },
        ],
        ports: [{ protocol: 'TCP', port: 8080 }],
      },
    ],
  });
  policy(db, ns, 'allow-ingress-nginx', {
    podSelector: { matchLabels: { app: 'checkout-web' } },
    policyTypes: ['Ingress'],
    ingress: [
      {
        from: [{ namespaceSelector: { matchLabels: { [NAME]: 'ingress-nginx' } } }],
        ports: [{ port: 'proxy' }],
      },
    ],
  });
  policy(db, ns, 'cart-from-web', {
    podSelector: { matchLabels: { app: 'cart-service' } },
    policyTypes: ['Ingress'],
    ingress: [
      {
        from: [{ podSelector: { matchLabels: { app: 'checkout-web' } } }],
        ports: [{ protocol: 'TCP', port: 8080 }],
      },
    ],
  });
  policy(db, ns, 'allow-prometheus-scrape', {
    podSelector: {},
    policyTypes: ['Ingress'],
    ingress: [
      {
        from: [
          {
            namespaceSelector: { matchLabels: { [NAME]: 'monitoring' } },
            podSelector: { matchLabels: { app: 'prometheus-server' } },
          },
        ],
        ports: [{ port: 'metrics' }],
      },
    ],
  });
}

function dataPolicies(db: ClusterDb) {
  const ns = 'data';
  policy(db, ns, 'default-deny-ingress', { podSelector: {}, policyTypes: ['Ingress'] });
  policy(db, ns, 'redis-from-cart', {
    podSelector: { matchLabels: { app: 'redis' } },
    policyTypes: ['Ingress'],
    ingress: [
      {
        from: [
          {
            namespaceSelector: { matchLabels: { [NAME]: 'checkout' } },
            podSelector: { matchLabels: { app: 'cart-service' } },
          },
        ],
        ports: [{ port: 'redis' }],
      },
    ],
  });
  policy(db, ns, 'allow-metrics-scrape', {
    podSelector: {},
    policyTypes: ['Ingress'],
    ingress: [
      {
        from: [{ namespaceSelector: { matchLabels: { [NAME]: 'monitoring' } } }],
        ports: [{ port: 'http-metrics' }],
      },
    ],
  });
}

/** First team: default deny both ways plus explicit allows; the second stays open. */
function teamPolicies(db: ClusterDb) {
  const team = db.profile.teams[0];
  if (!team) return;
  const ns = `team-${team}`;
  const app = (svc: string) => `${team}-${svc}`;
  policy(db, ns, 'default-deny-all', { podSelector: {}, policyTypes: ['Ingress', 'Egress'] });
  policy(db, ns, 'allow-dns', {
    podSelector: {},
    policyTypes: ['Egress'],
    egress: [{ to: [DNS_PEER], ports: DNS_PORTS }],
  });
  policy(db, ns, 'api-clients', {
    podSelector: { matchLabels: { app: app('api') } },
    policyTypes: ['Ingress'],
    ingress: [
      {
        from: [
          {
            podSelector: {
              matchExpressions: [
                { key: 'app', operator: 'In', values: [app('web'), app('gateway')] },
              ],
            },
          },
          {
            podSelector: {
              matchExpressions: [
                {
                  key: 'app',
                  operator: 'In',
                  values: [app('worker'), app('consumer'), app('scheduler')],
                },
              ],
            },
          },
        ],
        ports: [{ port: 'http' }],
      },
    ],
  });
  policy(db, ns, 'gateway-from-ingress', {
    podSelector: { matchLabels: { app: app('gateway') } },
    policyTypes: ['Ingress'],
    ingress: [
      {
        from: [
          { namespaceSelector: { matchLabels: { [NAME]: 'ingress-nginx' } } },
          { ipBlock: { cidr: '198.51.100.0/24', except: ['198.51.100.128/25'] } },
        ],
        ports: [{ protocol: 'TCP', port: 8080 }],
      },
    ],
  });
  policy(db, ns, 'clients-to-api', {
    podSelector: {
      matchExpressions: [
        {
          key: 'app',
          operator: 'In',
          values: [app('web'), app('gateway'), app('worker'), app('consumer'), app('scheduler')],
        },
      ],
    },
    policyTypes: ['Egress'],
    egress: [
      {
        to: [{ podSelector: { matchLabels: { app: app('api') } } }],
        ports: [{ port: 'http' }],
      },
    ],
  });
  policy(db, ns, 'api-egress', {
    podSelector: { matchLabels: { app: app('api') } },
    policyTypes: ['Egress'],
    egress: [
      {
        to: [
          {
            namespaceSelector: { matchLabels: { [NAME]: 'data' } },
            podSelector: { matchLabels: { app: 'postgres' } },
          },
        ],
        ports: [{ port: 'tcp-postgresql' }],
      },
      {
        to: [{ ipBlock: { cidr: '0.0.0.0/0', except: PRIVATE } }],
        ports: [{ protocol: 'TCP', port: 443 }],
      },
    ],
  });
  const third = db.profile.teams[2];
  if (third)
    policy(db, `team-${third}`, 'deny-all-ingress', { podSelector: {}, policyTypes: ['Ingress'] });
}

function ciliumDemo(db: ClusterDb) {
  buildDaemonSet(db, {
    namespace: 'kube-system',
    name: 'cilium',
    age: 180 * DAY,
    template: tpl(
      'cilium',
      [
        {
          name: 'cilium-agent',
          image: 'mcr.microsoft.com/oss/cilium/cilium:1.16.6',
          command: ['cilium-agent'],
          args: ['--config-dir=/tmp/cilium/config-map'],
          cpu: ['100m'],
          mem: ['256Mi'],
        },
      ],
      {
        hostNetwork: true,
        sa: 'cilium',
        priorityClassName: 'system-node-critical',
        labels: { 'k8s-app': 'cilium' },
      },
    ),
  });
  put(
    db,
    obj(
      `${CILIUM}/v2`,
      'CiliumNetworkPolicy',
      meta({ name: 'payment-api-l7', namespace: 'checkout', age: 40 * DAY }),
      {
        spec: {
          endpointSelector: { matchLabels: { app: 'payment-api' } },
          ingress: [
            {
              fromEndpoints: [{ matchLabels: { app: 'checkout-web' } }],
              toPorts: [
                {
                  ports: [{ port: '8080', protocol: 'TCP' }],
                  rules: { http: [{ method: 'POST', path: '/api/v1/payments' }] },
                },
              ],
            },
          ],
        },
      },
    ),
  );
  put(
    db,
    obj(
      `${CILIUM}/v2`,
      'CiliumClusterwideNetworkPolicy',
      meta({ name: 'deny-cloud-metadata', age: 90 * DAY }),
      {
        spec: {
          endpointSelector: {},
          egressDeny: [{ toCIDR: ['169.254.169.254/32'] }],
        },
      },
    ),
  );
}

export function buildNetpolDemo(db: ClusterDb) {
  if (hasNamespace(db, 'checkout')) checkoutPolicies(db);
  if (hasNamespace(db, 'data')) dataPolicies(db);
  teamPolicies(db);
  if (hasCilium(db)) ciliumDemo(db);
}
