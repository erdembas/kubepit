import type { KubeObject } from '@/types';
import { list, put, type ClusterDb } from './db';
import { between, DAY, hexId, meta, obj } from './util';

/** Services, Endpoints, EndpointSlices, Ingresses and NetworkPolicies. */

export interface ServicePort {
  name: string;
  port: number;
  targetPort?: number | string;
  nodePort?: number;
  protocol?: string;
}

export interface ServiceInput {
  namespace: string;
  name: string;
  type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer' | 'ExternalName' | 'Headless';
  selector?: Record<string, string>;
  ports: ServicePort[];
  externalName?: string;
  age?: number;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

function clusterIp(db: ClusterDb) {
  return `172.20.${between(db.rand, 0, 254)}.${between(db.rand, 1, 254)}`;
}

function matches(pod: KubeObject, selector: Record<string, string>) {
  return Object.entries(selector).every(([k, v]) => pod.metadata.labels?.[k] === v);
}

export function buildService(db: ClusterDb, input: ServiceInput) {
  const type = input.type ?? 'ClusterIP';
  const headless = type === 'Headless';
  const ip = headless ? 'None' : type === 'ExternalName' ? undefined : clusterIp(db);
  const spec: Record<string, unknown> =
    type === 'ExternalName'
      ? { type, externalName: input.externalName, sessionAffinity: 'None' }
      : {
          type: headless ? 'ClusterIP' : type,
          clusterIP: ip,
          clusterIPs: [ip],
          ipFamilies: ['IPv4'],
          ipFamilyPolicy: 'SingleStack',
          internalTrafficPolicy: 'Cluster',
          sessionAffinity: 'None',
          ...(input.selector ? { selector: input.selector } : {}),
          ports: input.ports.map((p) => ({
            name: p.name,
            port: p.port,
            protocol: p.protocol ?? 'TCP',
            targetPort: p.targetPort ?? p.port,
            ...(type === 'NodePort' || type === 'LoadBalancer'
              ? { nodePort: p.nodePort ?? between(db.rand, 30000, 32767) }
              : {}),
          })),
          ...(type === 'LoadBalancer'
            ? { externalTrafficPolicy: 'Local', allocateLoadBalancerNodePorts: true }
            : {}),
        };
  const status: Record<string, unknown> = { loadBalancer: {} };
  if (type === 'LoadBalancer') {
    const p = db.profile;
    status.loadBalancer = {
      ingress:
        p.platform === 'EKS'
          ? [
              {
                hostname: `a${hexId(db.rand, 31)}-${between(db.rand, 100000000, 999999999)}.elb.${p.region}.amazonaws.com`,
              },
            ]
          : p.platform === 'kind'
            ? []
            : [
                {
                  ip: `34.${between(db.rand, 60, 160)}.${between(db.rand, 1, 254)}.${between(db.rand, 1, 254)}`,
                  ipMode: 'VIP',
                },
              ],
    };
  }
  const svc = put(
    db,
    obj(
      'v1',
      'Service',
      meta({
        name: input.name,
        namespace: input.namespace,
        age: input.age ?? 60 * DAY,
        labels: input.labels ?? { app: input.name },
        annotations: input.annotations,
      }),
      {
        spec,
        status,
      },
    ),
  );
  if (input.selector) buildEndpoints(db, svc, input.selector, input.ports);
  return svc;
}

function buildEndpoints(
  db: ClusterDb,
  svc: KubeObject,
  selector: Record<string, string>,
  ports: ServicePort[],
) {
  const pods = list(db, 'pods').filter(
    (p) =>
      p.metadata.namespace === svc.metadata.namespace && matches(p, selector) && p.status?.podIP,
  );
  const ready = (p: KubeObject) =>
    (p.status?.conditions as Array<{ type: string; status: string }> | undefined)?.some(
      (c) => c.type === 'Ready' && c.status === 'True',
    );
  const address = (p: KubeObject) => ({
    ip: String(p.status?.podIP),
    nodeName: p.spec?.nodeName,
    targetRef: {
      kind: 'Pod',
      name: p.metadata.name,
      namespace: p.metadata.namespace,
      uid: p.metadata.uid,
    },
  });
  const epPorts = ports.map((p) => ({
    name: p.name,
    port: typeof p.targetPort === 'number' ? p.targetPort : p.port,
    protocol: p.protocol ?? 'TCP',
  }));
  const readyPods = pods.filter(ready);
  const notReady = pods.filter((p) => !ready(p));
  put(
    db,
    obj(
      'v1',
      'Endpoints',
      meta({
        name: svc.metadata.name,
        namespace: svc.metadata.namespace,
        age: 60 * DAY,
        labels: svc.metadata.labels,
      }),
      {
        subsets: pods.length
          ? [
              {
                ...(readyPods.length ? { addresses: readyPods.map(address) } : {}),
                ...(notReady.length ? { notReadyAddresses: notReady.map(address) } : {}),
                ports: epPorts,
              },
            ]
          : [],
      },
    ),
  );
  put(
    db,
    obj(
      'discovery.k8s.io/v1',
      'EndpointSlice',
      meta({
        name: `${svc.metadata.name}-${hexId(db.rand, 5)}`,
        namespace: svc.metadata.namespace,
        age: 60 * DAY,
        labels: {
          'kubernetes.io/service-name': svc.metadata.name,
          'endpointslice.kubernetes.io/managed-by': 'endpointslice-controller.k8s.io',
        },
        owner: svc,
      }),
      {
        addressType: 'IPv4',
        endpoints: pods.map((p) => ({
          addresses: [String(p.status?.podIP)],
          conditions: {
            ready: !!ready(p),
            serving: !!ready(p),
            terminating: !!p.metadata.deletionTimestamp,
          },
          nodeName: p.spec?.nodeName,
          targetRef: {
            kind: 'Pod',
            name: p.metadata.name,
            namespace: p.metadata.namespace,
            uid: p.metadata.uid,
          },
          ...(p.metadata.labels?.['topology.kubernetes.io/zone'] ? {} : {}),
        })),
        ports: epPorts,
      },
    ),
  );
}

export function buildIngress(
  db: ClusterDb,
  input: {
    namespace: string;
    name: string;
    host: string;
    paths: Array<[string, string, number]>;
    tls?: string;
    className?: string;
  },
) {
  const lb =
    list(db, 'services').find((s) => s.metadata.name === 'ingress-nginx-controller')?.status
      ?.loadBalancer ?? {};
  return put(
    db,
    obj(
      'networking.k8s.io/v1',
      'Ingress',
      meta({
        name: input.name,
        namespace: input.namespace,
        age: 90 * DAY,
        labels: { app: input.name },
        annotations: {
          'nginx.ingress.kubernetes.io/proxy-body-size': '16m',
          ...(input.tls ? { 'cert-manager.io/cluster-issuer': 'letsencrypt-prod' } : {}),
        },
      }),
      {
        spec: {
          ingressClassName: input.className ?? 'nginx',
          ...(input.tls ? { tls: [{ hosts: [input.host], secretName: input.tls }] } : {}),
          rules: [
            {
              host: input.host,
              http: {
                paths: input.paths.map(([path, service, port]) => ({
                  path,
                  pathType: 'Prefix',
                  backend: { service: { name: service, port: { number: port } } },
                })),
              },
            },
          ],
        },
        status: { loadBalancer: lb },
      },
    ),
  );
}

export function buildNetworkPolicies(db: ClusterDb) {
  put(
    db,
    obj(
      'networking.k8s.io/v1',
      'NetworkPolicy',
      meta({ name: 'default-deny-ingress', namespace: 'checkout', age: 120 * DAY }),
      {
        spec: { podSelector: {}, policyTypes: ['Ingress'] },
      },
    ),
  );
  put(
    db,
    obj(
      'networking.k8s.io/v1',
      'NetworkPolicy',
      meta({ name: 'allow-from-web', namespace: 'checkout', age: 120 * DAY }),
      {
        spec: {
          podSelector: { matchLabels: { app: 'payment-api' } },
          policyTypes: ['Ingress'],
          ingress: [
            {
              from: [
                { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'web' } } },
                { podSelector: { matchLabels: { app: 'checkout-web' } } },
              ],
              ports: [{ protocol: 'TCP', port: 8080 }],
            },
          ],
        },
      },
    ),
  );
  put(
    db,
    obj(
      'networking.k8s.io/v1',
      'NetworkPolicy',
      meta({ name: 'allow-ingress-controller', namespace: 'web', age: 100 * DAY }),
      {
        spec: {
          podSelector: { matchLabels: { app: 'storefront' } },
          policyTypes: ['Ingress', 'Egress'],
          ingress: [
            {
              from: [
                {
                  namespaceSelector: {
                    matchLabels: { 'kubernetes.io/metadata.name': 'ingress-nginx' },
                  },
                },
              ],
            },
          ],
          egress: [{ to: [{ ipBlock: { cidr: '0.0.0.0/0', except: ['169.254.169.254/32'] } }] }],
        },
      },
    ),
  );
  put(
    db,
    obj(
      'networking.k8s.io/v1',
      'NetworkPolicy',
      meta({ name: 'postgres-clients', namespace: 'data', age: 100 * DAY }),
      {
        spec: {
          podSelector: { matchLabels: { app: 'postgres' } },
          policyTypes: ['Ingress'],
          ingress: [
            {
              from: [
                {
                  namespaceSelector: {
                    matchLabels: { 'pod-security.kubernetes.io/enforce': 'baseline' },
                  },
                },
              ],
              ports: [{ protocol: 'TCP', port: 5432 }],
            },
          ],
        },
      },
    ),
  );
}
