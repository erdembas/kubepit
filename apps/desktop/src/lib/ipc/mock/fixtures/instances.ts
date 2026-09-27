import { put, type ClusterDb } from './db';
import { DAY, hexId, HOUR, meta, obj } from './util';

/** Custom resource instances for the demo CRDs. */

const readyCondition = (ok: boolean, message: string) => ({
  type: 'Ready',
  status: ok ? 'True' : 'False',
  reason: ok ? 'Ready' : 'Pending',
  message,
  lastTransitionTime: new Date(Date.now() - 3 * DAY).toISOString(),
  observedGeneration: 1,
});

export function buildInstances(db: ClusterDb) {
  const p = db.profile;
  for (const [name, server] of [
    ['letsencrypt-prod', 'https://acme-v02.api.letsencrypt.org/directory'],
    ['letsencrypt-staging', 'https://acme-staging-v02.api.letsencrypt.org/directory'],
  ] as const) {
    put(
      db,
      obj('cert-manager.io/v1', 'ClusterIssuer', meta({ name, age: 140 * DAY }), {
        spec: {
          acme: {
            email: 'platform@acme.io',
            server,
            privateKeySecretRef: { name: `${name}-account-key` },
            solvers: [{ http01: { ingress: { ingressClassName: 'nginx' } } }],
          },
        },
        status: {
          acme: { uri: `${server.replace('/directory', '')}/acme/acct/${hexId(db.rand, 9)}` },
          conditions: [
            readyCondition(true, 'The ACME account was registered with the ACME server'),
          ],
        },
      }),
    );
  }
  put(
    db,
    obj(
      'cert-manager.io/v1',
      'Issuer',
      meta({ name: 'selfsigned', namespace: 'cert-manager', age: 140 * DAY }),
      { spec: { selfSigned: {} }, status: { conditions: [readyCondition(true, '')] } },
    ),
  );
  const certs: Array<[string, string, string, boolean]> = [
    ['web', 'storefront-tls', `shop.${p.domain}`, true],
    ['monitoring', 'grafana-tls', `grafana.${p.domain}`, !p.troubled],
  ];
  if (p.argocd) certs.push(['argocd', 'argocd-server-tls', `argocd.${p.domain}`, true]);
  for (const [namespace, secretName, host, ok] of certs) {
    put(
      db,
      obj(
        'cert-manager.io/v1',
        'Certificate',
        meta({ name: secretName, namespace, age: 90 * DAY }),
        {
          spec: {
            secretName,
            dnsNames: [host],
            issuerRef: {
              group: 'cert-manager.io',
              kind: 'ClusterIssuer',
              name: 'letsencrypt-prod',
            },
            privateKey: { algorithm: 'ECDSA', size: 256, rotationPolicy: 'Always' },
            usages: ['digital signature', 'key encipherment'],
          },
          status: ok
            ? {
                conditions: [readyCondition(true, 'Certificate is up to date and has not expired')],
                notBefore: new Date(Date.now() - 20 * DAY).toISOString(),
                notAfter: new Date(Date.now() + 70 * DAY).toISOString(),
                renewalTime: new Date(Date.now() + 40 * DAY).toISOString(),
                revision: 4,
              }
            : {
                conditions: [
                  readyCondition(
                    false,
                    'Issuing certificate as Secret was previously issued by "Issuer.cert-manager.io/selfsigned"',
                  ),
                ],
                revision: 3,
              },
        },
      ),
    );
  }
  if (p.argocd) {
    put(
      db,
      obj(
        'argoproj.io/v1alpha1',
        'AppProject',
        meta({ name: 'default', namespace: 'argocd', age: 100 * DAY }),
        {
          spec: {
            sourceRepos: ['*'],
            destinations: [{ namespace: '*', server: '*' }],
            clusterResourceWhitelist: [{ group: '*', kind: '*' }],
          },
        },
      ),
    );
    put(
      db,
      obj(
        'argoproj.io/v1alpha1',
        'AppProject',
        meta({ name: 'platform', namespace: 'argocd', age: 100 * DAY }),
        {
          spec: {
            description: 'Shared platform components',
            sourceRepos: ['https://github.com/acme/gitops.git'],
            destinations: [{ namespace: '*', server: 'https://kubernetes.default.svc' }],
          },
        },
      ),
    );
    const apps: Array<[string, string, string, string, string]> = [
      ['storefront', 'web', 'Synced', 'Healthy', 'default'],
      [
        'payment-api',
        'checkout',
        p.troubled ? 'Synced' : 'Synced',
        p.troubled ? 'Degraded' : 'Healthy',
        'default',
      ],
      [
        'monitoring-stack',
        'monitoring',
        p.troubled ? 'OutOfSync' : 'Synced',
        p.troubled ? 'Progressing' : 'Healthy',
        'platform',
      ],
      ['cert-manager', 'cert-manager', 'Synced', 'Healthy', 'platform'],
      ['ingress-nginx', 'ingress-nginx', 'Synced', 'Healthy', 'platform'],
    ];
    for (const [name, namespace, sync, health, project] of apps) {
      const revision = hexId(db.rand, 40);
      put(
        db,
        obj(
          'argoproj.io/v1alpha1',
          'Application',
          meta({
            name,
            namespace: 'argocd',
            age: 95 * DAY,
            finalizers: ['resources-finalizer.argocd.argoproj.io'],
          }),
          {
            spec: {
              project,
              source: {
                repoURL: 'https://github.com/acme/gitops.git',
                path: `apps/${name}/overlays/${p.id.replace('c-', '')}`,
                targetRevision: 'main',
              },
              destination: { server: 'https://kubernetes.default.svc', namespace },
              syncPolicy: {
                automated: { prune: true, selfHeal: true },
                syncOptions: ['CreateNamespace=true'],
              },
            },
            status: {
              sync: {
                status: sync,
                revision,
                comparedTo: {
                  source: { repoURL: 'https://github.com/acme/gitops.git', targetRevision: 'main' },
                },
              },
              health: {
                status: health,
                ...(health === 'Degraded'
                  ? { message: 'Deployment "payment-api" exceeded its progress deadline' }
                  : {}),
              },
              reconciledAt: new Date(Date.now() - 2 * 60_000).toISOString(),
              operationState: {
                phase: 'Succeeded',
                message: 'successfully synced (all tasks run)',
                finishedAt: new Date(Date.now() - 5 * HOUR).toISOString(),
                startedAt: new Date(Date.now() - 5 * HOUR - 40_000).toISOString(),
              },
              summary: { images: [`ghcr.io/acme/${name}:latest`] },
            },
          },
        ),
      );
    }
  }
  for (const [namespace, name, port] of [
    ['checkout', 'payment-api', 'metrics'],
    ['web', 'storefront', 'http'],
    ['monitoring', 'node-exporter', 'metrics'],
    ['monitoring', 'kube-state-metrics', 'http'],
    ['ingress-nginx', 'ingress-nginx-controller', 'metrics'],
  ] as const) {
    put(
      db,
      obj(
        'monitoring.coreos.com/v1',
        'ServiceMonitor',
        meta({ name, namespace, age: 60 * DAY, labels: { release: 'prometheus' } }),
        {
          spec: {
            selector: { matchLabels: { app: name } },
            endpoints: [{ port, interval: '30s', path: '/metrics', scheme: 'http' }],
            namespaceSelector: { matchNames: [namespace] },
          },
        },
      ),
    );
  }
  put(
    db,
    obj(
      'monitoring.coreos.com/v1',
      'PrometheusRule',
      meta({
        name: 'kubernetes-apps',
        namespace: 'monitoring',
        age: 60 * DAY,
        labels: { release: 'prometheus' },
      }),
      {
        spec: {
          groups: [
            {
              name: 'kubernetes-apps',
              rules: [
                {
                  alert: 'KubePodCrashLooping',
                  expr: 'max_over_time(kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff"}[5m]) >= 1',
                  for: '15m',
                  labels: { severity: 'warning' },
                  annotations: { summary: 'Pod is crash looping.' },
                },
                {
                  alert: 'KubeDeploymentReplicasMismatch',
                  expr: 'kube_deployment_spec_replicas != kube_deployment_status_replicas_available',
                  for: '15m',
                  labels: { severity: 'warning' },
                },
              ],
            },
          ],
        },
      },
    ),
  );
}
