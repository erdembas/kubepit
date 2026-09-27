import YAML from 'yaml';
import type { HelmRelease } from '@/types';
import { find, helmKey, list, put, type ClusterDb, type HelmRecord } from './db';
import { b64, DAY, HOUR, meta, obj } from './util';

/** Helm releases (history, values, manifest, notes) plus their release secrets. */

interface ReleaseInput {
  name: string;
  namespace: string;
  chart: string;
  versions: Array<[string, string | null]>;
  values: Record<string, unknown>;
  objects: Array<[string, string]>;
  notes: string;
  lastStatus?: string;
  ageDays: number;
}

function manifestFor(db: ClusterDb, namespace: string, objects: Array<[string, string]>) {
  const docs: string[] = [];
  for (const [key, name] of objects) {
    const o = find(db, key, namespace, name) ?? find(db, key, null, name);
    if (!o) continue;
    const clean = {
      apiVersion: o.apiVersion,
      kind: o.kind,
      metadata: {
        name: o.metadata.name,
        ...(o.metadata.namespace ? { namespace: o.metadata.namespace } : {}),
        labels: o.metadata.labels,
      },
      ...(o.spec ? { spec: o.spec } : {}),
      ...(o.data ? { data: o.data } : {}),
    };
    docs.push(`---\n# Source: ${key.split('.')[0]}/${name}.yaml\n${YAML.stringify(clean)}`);
  }
  return docs.join('');
}

function record(db: ClusterDb, input: ReleaseInput): HelmRecord {
  const history: HelmRelease[] = input.versions.map(([chartVersion, appVersion], i) => {
    const last = i === input.versions.length - 1;
    const updated = new Date(
      Date.now() -
        (input.versions.length - i) * (input.ageDays / input.versions.length) * DAY +
        HOUR,
    ).toISOString();
    return {
      name: input.name,
      namespace: input.namespace,
      revision: i + 1,
      status: last ? (input.lastStatus ?? 'deployed') : 'superseded',
      chart: input.chart,
      chart_version: chartVersion,
      app_version: appVersion,
      updated,
      description:
        i === 0
          ? 'Install complete'
          : last && input.lastStatus === 'failed'
            ? `Upgrade "${input.name}" failed: context deadline exceeded`
            : 'Upgrade complete',
    };
  });
  const valuesYaml = YAML.stringify(input.values);
  return {
    history,
    values: history.map(() => valuesYaml),
    manifest: manifestFor(db, input.namespace, input.objects),
    notes: input.notes,
    computed: YAML.stringify({
      ...input.values,
      global: { imageRegistry: '', imagePullSecrets: [] },
      nameOverride: '',
      fullnameOverride: '',
    }),
  };
}

export function helmSecrets(db: ClusterDb, namespace: string, name: string) {
  return list(db, 'secrets').filter(
    (s) =>
      s.metadata.namespace === namespace &&
      s.metadata.labels?.owner === 'helm' &&
      s.metadata.labels.name === name,
  );
}

export function syncHelmSecrets(db: ClusterDb, namespace: string, name: string) {
  const rec = db.helm.get(helmKey(namespace, name));
  if (!rec) return;
  for (const rel of rec.history) {
    const secretName = `sh.helm.release.v1.${name}.v${rel.revision}`;
    const existing = find(db, 'secrets', namespace, secretName);
    const labels = {
      name,
      owner: 'helm',
      status: rel.status,
      version: String(rel.revision),
      modifiedAt: String(Math.floor(Date.parse(rel.updated ?? '') / 1000)),
    };
    if (existing) {
      existing.metadata.labels = labels;
      put(db, existing);
    } else {
      put(
        db,
        obj(
          'v1',
          'Secret',
          meta({
            name: secretName,
            namespace,
            age: Date.now() - Date.parse(rel.updated ?? new Date().toISOString()),
            labels,
          }),
          {
            type: 'helm.sh/release.v1',
            data: { release: b64(`H4sIAAAAAAAC/demo-release-${name}-${rel.revision}`) },
          },
        ),
      );
    }
  }
}

export function buildHelm(db: ClusterDb) {
  const p = db.profile;
  const releases: ReleaseInput[] = [
    {
      name: 'ingress-nginx',
      namespace: 'ingress-nginx',
      chart: 'ingress-nginx',
      versions: [
        ['4.10.1', '1.10.1'],
        ['4.11.3', '1.11.3'],
        ['4.12.0', '1.12.0'],
      ],
      values: {
        controller: {
          replicaCount: p.platform === 'kind' ? 1 : 2,
          service: { type: p.platform === 'kind' ? 'NodePort' : 'LoadBalancer' },
          metrics: { enabled: true },
          config: { 'use-forwarded-headers': 'true' },
        },
      },
      objects: [
        ['deployments.apps', 'ingress-nginx-controller'],
        ['services', 'ingress-nginx-controller'],
        ['configmaps', 'ingress-nginx-controller'],
      ],
      notes:
        "The ingress-nginx controller has been installed.\nIt may take a few minutes for the load balancer IP to be available.\nYou can watch the status by running 'kubectl get service --namespace ingress-nginx ingress-nginx-controller --output wide --watch'\n",
      ageDays: 200,
    },
    {
      name: 'cert-manager',
      namespace: 'cert-manager',
      chart: 'cert-manager',
      versions: [
        ['v1.15.3', 'v1.15.3'],
        ['v1.16.2', 'v1.16.2'],
      ],
      values: {
        crds: { enabled: true },
        replicaCount: 1,
        prometheus: { enabled: true, servicemonitor: { enabled: true } },
      },
      objects: [
        ['deployments.apps', 'cert-manager'],
        ['deployments.apps', 'cert-manager-webhook'],
        ['deployments.apps', 'cert-manager-cainjector'],
      ],
      notes:
        "cert-manager v1.16.2 has been deployed successfully!\n\nIn order to begin issuing certificates, you will need to set up a ClusterIssuer\nor Issuer resource (for example, by creating a 'letsencrypt-staging' issuer).\n",
      ageDays: 150,
    },
    {
      name: 'grafana',
      namespace: 'monitoring',
      chart: 'grafana',
      versions: [
        ['8.5.1', '11.2.0'],
        ['8.6.4', '11.3.1'],
        ['8.8.2', '11.4.0'],
      ],
      values: {
        replicas: 1,
        persistence: { enabled: true, size: '10Gi' },
        ingress: { enabled: p.platform !== 'kind', hosts: [`grafana.${p.domain}`] },
        admin: { existingSecret: 'grafana' },
      },
      objects: [
        ['deployments.apps', 'grafana'],
        ['services', 'grafana'],
        ['configmaps', 'grafana'],
      ],
      notes: `1. Get your 'admin' user password by running:\n\n   kubectl get secret --namespace monitoring grafana -o jsonpath="{.data.admin-password}" | base64 --decode ; echo\n\n2. The Grafana server can be accessed via port 80 on the following DNS name from within your cluster:\n\n   grafana.monitoring.svc.cluster.local\n`,
      lastStatus: p.troubled && p.id === 'c-staging' ? 'failed' : 'deployed',
      ageDays: 120,
    },
    {
      name: 'postgresql',
      namespace: 'data',
      chart: 'postgresql',
      versions: [
        ['15.5.38', '16.4.0'],
        ['16.2.5', '16.6.0'],
      ],
      values: {
        architecture: 'replication',
        auth: { existingSecret: 'postgres-credentials', database: 'payments' },
        primary: {
          persistence: { size: '100Gi' },
          resources: { requests: { cpu: '500m', memory: '1Gi' } },
        },
        readReplicas: { replicaCount: 2 },
        metrics: { enabled: true },
      },
      objects: [
        ['statefulsets.apps', 'postgres'],
        ['services', 'postgres'],
        ['services', 'postgres-headless'],
      ],
      notes:
        'CHART NAME: postgresql\nCHART VERSION: 16.2.5\nAPP VERSION: 16.6.0\n\n** Please be patient while the chart is being deployed **\n\nPostgreSQL can be accessed via port 5432 on the following DNS names from within your cluster:\n\n    postgres.data.svc.cluster.local - Read/Write connection\n',
      ageDays: 260,
    },
    {
      name: 'redis',
      namespace: 'data',
      chart: 'redis',
      versions: [
        ['20.1.4', '7.4.0'],
        ['20.6.2', '7.4.2'],
      ],
      values: {
        architecture: 'replication',
        auth: { enabled: true },
        replica: { replicaCount: 3, persistence: { size: '8Gi' } },
      },
      objects: [
        ['statefulsets.apps', 'redis'],
        ['services', 'redis'],
      ],
      notes:
        'Redis® can be accessed on the following DNS names from within your cluster:\n\n    redis.data.svc.cluster.local for read/write operations (port 6379)\n',
      ageDays: 240,
    },
  ];
  if (p.platform !== 'kind') {
    releases.push({
      name: 'payment-api',
      namespace: 'checkout',
      chart: 'acme-service',
      versions: [
        ['1.8.0', '2.12.0'],
        ['1.8.0', '2.13.1'],
        ['1.9.2', '2.14.0'],
        ['1.9.2', '2.14.3'],
      ],
      values: {
        image: { repository: 'ghcr.io/acme/payment-api', tag: '2.14.3' },
        replicaCount: 3,
        autoscaling: {
          enabled: true,
          minReplicas: 3,
          maxReplicas: 10,
          targetCPUUtilizationPercentage: 70,
        },
        resources: {
          requests: { cpu: '250m', memory: '512Mi' },
          limits: { cpu: '1', memory: '1Gi' },
        },
        envFrom: [{ secretRef: { name: 'payment-api-secrets' } }],
      },
      objects: [
        ['deployments.apps', 'payment-api'],
        ['services', 'payment-api'],
        ['configmaps', 'payment-api-config'],
        ['horizontalpodautoscalers.autoscaling', 'payment-api'],
      ],
      notes:
        'payment-api 2.14.3 deployed.\nDashboards: https://grafana.' +
        p.domain +
        '/d/payment-api\n',
      ageDays: 140,
    });
  }
  if (p.argocd) {
    releases.push({
      name: 'argo-cd',
      namespace: 'argocd',
      chart: 'argo-cd',
      versions: [
        ['7.6.12', 'v2.12.6'],
        ['7.7.11', 'v2.13.3'],
      ],
      values: {
        server: { replicas: 2, ingress: { enabled: true, hostname: `argocd.${p.domain}` } },
        repoServer: { replicas: 2 },
        configs: { params: { 'server.insecure': true } },
      },
      objects: [
        ['deployments.apps', 'argocd-server'],
        ['deployments.apps', 'argocd-repo-server'],
        ['statefulsets.apps', 'argocd-application-controller'],
      ],
      notes:
        'In order to access the server UI you have the following options:\n\n1. kubectl port-forward service/argocd-server -n argocd 8080:443\n\n    and then open the browser on http://localhost:8080 and accept the certificate\n',
      ageDays: 100,
    });
  }
  for (const r of releases) {
    db.helm.set(helmKey(r.namespace, r.name), record(db, r));
    syncHelmSecrets(db, r.namespace, r.name);
  }
}
