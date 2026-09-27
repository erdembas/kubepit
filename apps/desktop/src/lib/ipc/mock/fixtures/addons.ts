import type { ClusterDb } from './db';
import { buildDeployment, buildStatefulSet } from './builders';
import { buildService } from './network';
import { tpl } from './template';
import { DAY } from './util';

/** Platform add-ons: ingress-nginx, cert-manager, Argo CD. */

export function buildIngressNginx(db: ClusterDb) {
  const ns = 'ingress-nginx';
  buildDeployment(db, {
    namespace: ns,
    name: 'ingress-nginx-controller',
    age: 200 * DAY,
    replicas: db.profile.platform === 'kind' ? 1 : 2,
    oldRevisions: 3,
    labels: {
      'app.kubernetes.io/component': 'controller',
      'app.kubernetes.io/instance': 'ingress-nginx',
    },
    template: tpl(
      'ingress-nginx-controller',
      [
        {
          name: 'controller',
          image:
            'registry.k8s.io/ingress-nginx/controller:v1.12.0@sha256:e6b8de175acda6ca913891f0f727bca4527e797d52688cbe9fec9040d6f6b6fa',
          ports: [
            { name: 'http', port: 80 },
            { name: 'https', port: 443 },
            { name: 'webhook', port: 8443 },
            { name: 'metrics', port: 10254 },
          ],
          cpu: ['100m'],
          mem: ['90Mi'],
          probe: 'http',
          probePath: '/healthz',
          args: [
            '/nginx-ingress-controller',
            '--publish-service=$(POD_NAMESPACE)/ingress-nginx-controller',
            '--election-id=ingress-nginx-leader',
            '--controller-class=k8s.io/ingress-nginx',
            '--ingress-class=nginx',
          ],
          env: [
            ['POD_NAME', { field: 'metadata.name' }],
            ['POD_NAMESPACE', { field: 'metadata.namespace' }],
            ['LD_PRELOAD', '/usr/local/lib/libmimalloc.so'],
          ],
        },
      ],
      { sa: 'ingress-nginx', labels: { 'app.kubernetes.io/component': 'controller' } },
    ),
  });
  buildService(db, {
    namespace: ns,
    name: 'ingress-nginx-controller',
    type: db.profile.platform === 'kind' ? 'NodePort' : 'LoadBalancer',
    selector: { app: 'ingress-nginx-controller' },
    ports: [
      { name: 'http', port: 80, targetPort: 'http', nodePort: 30080 },
      { name: 'https', port: 443, targetPort: 'https', nodePort: 30443 },
    ],
    annotations:
      db.profile.platform === 'EKS'
        ? {
            'service.beta.kubernetes.io/aws-load-balancer-type': 'nlb',
            'service.beta.kubernetes.io/aws-load-balancer-scheme': 'internet-facing',
          }
        : {},
  });
  buildService(db, {
    namespace: ns,
    name: 'ingress-nginx-controller-admission',
    selector: { app: 'ingress-nginx-controller' },
    ports: [{ name: 'https-webhook', port: 443, targetPort: 'webhook' }],
  });
}

export function buildCertManager(db: ClusterDb) {
  const ns = 'cert-manager';
  for (const [name, port] of [
    ['cert-manager', 9402],
    ['cert-manager-cainjector', 0],
    ['cert-manager-webhook', 10250],
  ] as const) {
    const component = name === 'cert-manager' ? 'controller' : name.replace('cert-manager-', '');
    buildDeployment(db, {
      namespace: ns,
      name,
      age: 150 * DAY,
      replicas: 1,
      oldRevisions: 2,
      labels: {
        'app.kubernetes.io/instance': 'cert-manager',
        'app.kubernetes.io/component': component,
      },
      template: tpl(
        name,
        [
          {
            name: `cert-manager-${component}`,
            image: `quay.io/jetstack/cert-manager-${component}:v1.16.2`,
            ...(port ? { ports: [port] } : {}),
            args: ['--v=2', `--leader-election-namespace=kube-system`],
          },
        ],
        { sa: name, labels: { 'app.kubernetes.io/instance': 'cert-manager' } },
      ),
    });
  }
  buildService(db, {
    namespace: ns,
    name: 'cert-manager',
    selector: { app: 'cert-manager' },
    ports: [{ name: 'tcp-prometheus-servicemonitor', port: 9402 }],
  });
  buildService(db, {
    namespace: ns,
    name: 'cert-manager-webhook',
    selector: { app: 'cert-manager-webhook' },
    ports: [{ name: 'https', port: 443, targetPort: 10250 }],
  });
}

export function buildArgo(db: ClusterDb) {
  if (!db.profile.argocd) return;
  const ns = 'argocd';
  const img = 'quay.io/argoproj/argocd:v2.13.3';
  const labels = { 'app.kubernetes.io/part-of': 'argocd' };
  buildDeployment(db, {
    namespace: ns,
    name: 'argocd-server',
    age: 100 * DAY,
    replicas: 2,
    oldRevisions: 5,
    labels,
    template: tpl(
      'argocd-server',
      [
        {
          name: 'argocd-server',
          image: img,
          ports: [8080, { name: 'metrics', port: 8083 }],
          args: ['/usr/local/bin/argocd-server'],
          probe: 'http',
        },
      ],
      { sa: 'argocd-server', labels },
    ),
  });
  buildDeployment(db, {
    namespace: ns,
    name: 'argocd-repo-server',
    age: 100 * DAY,
    replicas: 2,
    oldRevisions: 5,
    labels,
    template: tpl(
      'argocd-repo-server',
      [
        {
          name: 'argocd-repo-server',
          image: img,
          ports: [
            { name: 'server', port: 8081 },
            { name: 'metrics', port: 8084 },
          ],
          cpu: ['250m'],
          mem: ['256Mi', '1Gi'],
        },
      ],
      {
        sa: 'argocd-repo-server',
        labels,
        init: [
          {
            name: 'copyutil',
            image: img,
            command: [
              '/bin/cp',
              '-n',
              '/usr/local/bin/argocd',
              '/var/run/argocd/argocd-cmp-server',
            ],
          },
        ],
      },
    ),
  });
  buildDeployment(db, {
    namespace: ns,
    name: 'argocd-redis',
    age: 100 * DAY,
    replicas: 1,
    labels,
    template: tpl(
      'argocd-redis',
      [
        {
          name: 'redis',
          image: 'public.ecr.aws/docker/library/redis:7.4.1-alpine',
          ports: [6379],
          args: ['--save', '', '--appendonly', 'no'],
        },
      ],
      { sa: 'argocd-redis', labels },
    ),
  });
  buildDeployment(db, {
    namespace: ns,
    name: 'argocd-applicationset-controller',
    age: 100 * DAY,
    replicas: 1,
    labels,
    template: tpl(
      'argocd-applicationset-controller',
      [
        {
          name: 'argocd-applicationset-controller',
          image: img,
          ports: [
            { name: 'webhook', port: 7000 },
            { name: 'metrics', port: 8080 },
          ],
        },
      ],
      { sa: 'argocd-applicationset-controller', labels },
    ),
  });
  buildStatefulSet(db, {
    namespace: ns,
    name: 'argocd-application-controller',
    serviceName: 'argocd-application-controller',
    age: 100 * DAY,
    replicas: 1,
    labels,
    template: tpl(
      'argocd-application-controller',
      [
        {
          name: 'argocd-application-controller',
          image: img,
          ports: [{ name: 'metrics', port: 8082 }],
          cpu: ['250m'],
          mem: ['1Gi', '2Gi'],
        },
      ],
      { sa: 'argocd-application-controller', labels },
    ),
  });
  buildService(db, {
    namespace: ns,
    name: 'argocd-server',
    selector: { app: 'argocd-server' },
    ports: [
      { name: 'http', port: 80, targetPort: 8080 },
      { name: 'https', port: 443, targetPort: 8080 },
    ],
  });
  buildService(db, {
    namespace: ns,
    name: 'argocd-repo-server',
    selector: { app: 'argocd-repo-server' },
    ports: [{ name: 'server', port: 8081 }],
  });
  buildService(db, {
    namespace: ns,
    name: 'argocd-redis',
    selector: { app: 'argocd-redis' },
    ports: [{ name: 'tcp-redis', port: 6379 }],
  });
}
