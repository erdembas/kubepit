import YAML from 'yaml';
import { parseApiVersion } from '@/lib/kube/catalog';
import { replicaCounts } from '@/lib/kube/workloads';
import type { KubeObject } from '@/types';
import { buildDeployment } from './builders';
import type { CrdInput } from './crds';
import { find, keyOf, list, put, type ClusterDb } from './db';
import { buildService } from './network';
import { tpl } from './template';
import { ago, DAY, hexId, HOUR, meta, MIN, obj } from './util';

/**
 * GitOps demo data: richer Argo CD Applications (Synced/Healthy, OutOfSync,
 * Degraded, Missing, a running sync, an app-of-apps and an ApplicationSet)
 * on the Argo CD clusters, and a Flux installation (sources, Kustomizations,
 * HelmReleases — one suspended, some failing) on staging and dev. Managed
 * objects carry the tracking annotations / labels the real controllers set.
 */

export const FLUX_CLUSTERS = new Set(['c-staging', 'c-dev']);

export function hasFlux(db: ClusterDb): boolean {
  return FLUX_CLUSTERS.has(db.profile.id);
}

const ARGO = 'argoproj.io';
const FLUX_KS = 'kustomize.toolkit.fluxcd.io';
const FLUX_HELM = 'helm.toolkit.fluxcd.io';
const FLUX_SRC = 'source.toolkit.fluxcd.io';
const FLUX_NOTIFY = 'notification.toolkit.fluxcd.io';
const GITOPS_REPO = 'https://github.com/acme/gitops.git';
const TRACKING = 'argocd.argoproj.io/tracking-id';
const KS_NAME = 'kustomize.toolkit.fluxcd.io/name';
const KS_NS = 'kustomize.toolkit.fluxcd.io/namespace';
const HR_NAME = 'helm.toolkit.fluxcd.io/name';
const HR_NS = 'helm.toolkit.fluxcd.io/namespace';

// ---------------------------------------------------------------------------
// CRDs
// ---------------------------------------------------------------------------

const readyCols = [
  { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
  { name: 'Ready', type: 'string', jsonPath: '.status.conditions[?(@.type=="Ready")].status' },
  {
    name: 'Status',
    type: 'string',
    jsonPath: '.status.conditions[?(@.type=="Ready")].message',
  },
];

function fluxCrd(
  group: string,
  kind: string,
  plural: string,
  versions: string[],
  shortNames: string[] = [],
  extra: CrdInput['columns'] = [],
): CrdInput {
  return {
    group,
    kind,
    plural,
    singular: kind.toLowerCase(),
    shortNames,
    scope: 'Namespaced',
    versions,
    categories: ['flux'],
    columns: [...(extra ?? []), ...readyCols],
    age: 180 * DAY,
  };
}

/** ApplicationSet (Argo CD clusters) and the Flux CRDs (Flux clusters). */
export function gitopsCrds(db: ClusterDb): CrdInput[] {
  const out: CrdInput[] = [];
  if (db.profile.argocd)
    out.push({
      group: ARGO,
      kind: 'ApplicationSet',
      plural: 'applicationsets',
      singular: 'applicationset',
      shortNames: ['appset', 'appsets'],
      scope: 'Namespaced',
      versions: ['v1alpha1'],
      age: 100 * DAY,
    });
  if (hasFlux(db)) {
    const url = { name: 'URL', type: 'string', jsonPath: '.spec.url' };
    out.push(
      fluxCrd(FLUX_KS, 'Kustomization', 'kustomizations', ['v1beta2', 'v1'], ['ks']),
      fluxCrd(FLUX_HELM, 'HelmRelease', 'helmreleases', ['v2beta2', 'v2'], ['hr']),
      fluxCrd(FLUX_SRC, 'GitRepository', 'gitrepositories', ['v1beta2', 'v1'], ['gitrepo'], [url]),
      fluxCrd(
        FLUX_SRC,
        'HelmRepository',
        'helmrepositories',
        ['v1beta2', 'v1'],
        ['helmrepo'],
        [url],
      ),
      fluxCrd(FLUX_SRC, 'OCIRepository', 'ocirepositories', ['v1beta2', 'v1'], ['ocirepo'], [url]),
      fluxCrd(
        FLUX_SRC,
        'HelmChart',
        'helmcharts',
        ['v1beta2', 'v1'],
        ['hc'],
        [
          { name: 'Chart', type: 'string', jsonPath: '.spec.chart' },
          { name: 'Version', type: 'string', jsonPath: '.spec.version' },
        ],
      ),
      fluxCrd(
        FLUX_SRC,
        'Bucket',
        'buckets',
        ['v1beta2', 'v1'],
        [],
        [{ name: 'Endpoint', type: 'string', jsonPath: '.spec.endpoint' }],
      ),
      fluxCrd(FLUX_NOTIFY, 'Alert', 'alerts', ['v1beta3']),
      fluxCrd(FLUX_NOTIFY, 'Provider', 'providers', ['v1beta3']),
      fluxCrd(FLUX_NOTIFY, 'Receiver', 'receivers', ['v1']),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Kinds a GitOps tool typically applies (top-level objects only). */
const MANAGED_KEYS = [
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'services',
  'configmaps',
  'serviceaccounts',
  'ingresses.networking.k8s.io',
  'cronjobs.batch',
  'horizontalpodautoscalers.autoscaling',
  'poddisruptionbudgets.policy',
  'networkpolicies.networking.k8s.io',
];

function topLevel(db: ClusterDb, namespace: string): KubeObject[] {
  return MANAGED_KEYS.flatMap((key) =>
    list(db, key).filter(
      (o) =>
        o.metadata.namespace === namespace &&
        !o.metadata.ownerReferences?.length &&
        !(o.kind === 'ConfigMap' && o.metadata.name === 'kube-root-ca.crt') &&
        !(o.kind === 'ServiceAccount' && o.metadata.name === 'default'),
    ),
  );
}

function fluxManaged(o: KubeObject) {
  const l = o.metadata.labels ?? {};
  return !!(l[KS_NAME] || l[HR_NAME]);
}

function label(db: ClusterDb, o: KubeObject, labels: Record<string, string>) {
  o.metadata.labels = { ...o.metadata.labels, ...labels };
  put(db, o);
}

function condition(
  type: string,
  status: 'True' | 'False' | 'Unknown',
  reason: string,
  message: string,
  since: number,
  observedGeneration = 1,
) {
  return {
    type,
    status,
    reason,
    message,
    lastTransitionTime: ago(since),
    observedGeneration,
  };
}

// ---------------------------------------------------------------------------
// Argo CD
// ---------------------------------------------------------------------------

function health(o: KubeObject): { status: string; message?: string } | undefined {
  if (['Deployment', 'StatefulSet', 'DaemonSet'].includes(o.kind)) {
    const c = replicaCounts(o);
    if (c.desired === 0 || c.ready >= c.desired) return { status: 'Healthy' };
    if (c.ready === 0)
      return {
        status: 'Degraded',
        message: `${o.kind} "${o.metadata.name}" has no ready replicas`,
      };
    return {
      status: 'Progressing',
      message: `Waiting for rollout to finish: ${c.ready} of ${c.desired} updated replicas are available...`,
    };
  }
  if (['Service', 'Ingress', 'PersistentVolumeClaim', 'Application'].includes(o.kind))
    return { status: 'Healthy' };
  return undefined;
}

function resourceEntry(o: KubeObject, status = 'Synced') {
  const { group, version } = parseApiVersion(o.apiVersion);
  const h =
    o.kind === 'Application'
      ? {
          status: String(
            (o.status as { health?: { status?: string } })?.health?.status ?? 'Healthy',
          ),
        }
      : health(o);
  return {
    group,
    version,
    kind: o.kind,
    ...(o.metadata.namespace ? { namespace: o.metadata.namespace } : {}),
    name: o.metadata.name,
    status,
    ...(h ? { health: h } : {}),
  };
}

function track(db: ClusterDb, app: string, o: KubeObject) {
  if (fluxManaged(o) || o.metadata.annotations?.[TRACKING]) return;
  const { group } = parseApiVersion(o.apiVersion);
  o.metadata.annotations = {
    ...o.metadata.annotations,
    [TRACKING]: `${app}:${group}/${o.kind}:${o.metadata.namespace ?? ''}/${o.metadata.name}`,
  };
  put(db, o);
}

function history(
  db: ClusterDb,
  count: number,
  current: string,
  source: Record<string, unknown>,
  automated: boolean,
) {
  return Array.from({ length: count }, (_, i) => {
    const age = (count - i) * 2.5 * DAY - 3 * HOUR;
    return {
      id: i + 1,
      revision: i === count - 1 ? current : hexId(db.rand, 40),
      deployedAt: ago(age),
      deployStartedAt: ago(age + 45_000),
      source,
      initiatedBy: automated ? { automated: true } : { username: 'admin' },
    };
  });
}

interface AppShape {
  sync: string;
  health: string;
  healthMessage?: string;
  automated: boolean;
  outOfSync?: number;
}

function enrichApplication(db: ClusterDb, app: KubeObject, shape: AppShape) {
  const s = (app.spec ?? {}) as Record<string, unknown>;
  const st = (app.status ?? {}) as Record<string, unknown>;
  const dest = (s.destination ?? {}) as { namespace?: string };
  const ns = dest.namespace ?? '';
  const managed = ns ? topLevel(db, ns).filter((o) => !fluxManaged(o)) : [];
  managed.forEach((o) => track(db, app.metadata.name, o));
  let drift = shape.outOfSync ?? (shape.sync === 'OutOfSync' ? 2 : 0);
  const resources = managed.map((o) => {
    const outOfSync = drift > 0 && ['ConfigMap', 'Deployment'].includes(o.kind);
    if (outOfSync) drift--;
    return resourceEntry(o, outOfSync ? 'OutOfSync' : 'Synced');
  });
  const revision =
    ((st.sync as { revision?: string } | undefined)?.revision ?? '') || hexId(db.rand, 40);
  if (!shape.automated) s.syncPolicy = { syncOptions: ['CreateNamespace=true'] };
  app.status = {
    ...st,
    sync: { ...(st.sync as object), status: shape.sync, revision },
    health: {
      status: shape.health,
      ...(shape.healthMessage ? { message: shape.healthMessage } : {}),
    },
    resources,
    history: history(db, 4, revision, s.source as Record<string, unknown>, shape.automated),
    sourceType: 'Kustomize',
  };
  put(db, app);
}

function application(
  db: ClusterDb,
  name: string,
  namespace: string,
  project: string,
  path: string,
  extra: { owner?: KubeObject | null; age?: number } = {},
): KubeObject {
  return obj(
    `${ARGO}/v1alpha1`,
    'Application',
    meta({
      name,
      namespace: 'argocd',
      age: extra.age ?? 60 * DAY,
      owner: extra.owner ?? null,
      finalizers: ['resources-finalizer.argocd.argoproj.io'],
    }),
    {
      spec: {
        project,
        source: { repoURL: GITOPS_REPO, path, targetRevision: 'main' },
        destination: { server: 'https://kubernetes.default.svc', namespace },
        syncPolicy: {
          automated: { prune: true, selfHeal: true },
          syncOptions: ['CreateNamespace=true'],
        },
      },
      status: {
        sync: { status: 'Synced', revision: hexId(db.rand, 40) },
        health: { status: 'Healthy' },
        reconciledAt: ago(3 * MIN),
        operationState: {
          phase: 'Succeeded',
          message: 'successfully synced (all tasks run)',
          startedAt: ago(9 * HOUR + 50_000),
          finishedAt: ago(9 * HOUR),
        },
      },
    },
  );
}

function buildArgoApps(db: ClusterDb) {
  const p = db.profile;
  const env = p.id.replace('c-', '');
  const apps = () => list(db, `applications.${ARGO}`);
  const byName = (name: string) => apps().find((a) => a.metadata.name === name);

  // Existing demo apps (instances.ts) get resources, history and distinct states.
  const storefront = byName('storefront');
  if (storefront)
    enrichApplication(db, storefront, { sync: 'Synced', health: 'Healthy', automated: true });
  const payment = byName('payment-api');
  if (payment)
    enrichApplication(db, payment, {
      sync: 'Synced',
      health: p.troubled ? 'Degraded' : 'Healthy',
      healthMessage: p.troubled
        ? 'Deployment "payment-api" exceeded its progress deadline'
        : undefined,
      automated: true,
    });
  const monitoring = byName('monitoring-stack');
  if (monitoring) {
    const chartRev = '66.3.1';
    const { source: _single, ...rest } = (monitoring.spec ?? {}) as Record<string, unknown>;
    void _single;
    monitoring.spec = {
      ...rest,
      sources: [
        {
          repoURL: 'https://prometheus-community.github.io/helm-charts',
          chart: 'kube-prometheus-stack',
          targetRevision: chartRev,
          helm: { valueFiles: ['$values/platform/monitoring/values.yaml'] },
        },
        { repoURL: GITOPS_REPO, targetRevision: 'main', ref: 'values' },
      ],
    };
    enrichApplication(db, monitoring, {
      sync: 'OutOfSync',
      health: 'Healthy',
      automated: false,
      outOfSync: 2,
    });
    const st = monitoring.status as Record<string, unknown>;
    st.sync = { ...(st.sync as object), revisions: [chartRev, hexId(db.rand, 40)] };
    st.sourceType = 'Helm';
    put(db, monitoring);
  }
  for (const name of ['cert-manager', 'ingress-nginx']) {
    const app = byName(name);
    if (app) enrichApplication(db, app, { sync: 'Synced', health: 'Healthy', automated: true });
  }

  // A manually synced app whose resources are missing, one of them needing a prune.
  const legacy = put(
    db,
    application(db, 'legacy-crm', 'default', 'default', `apps/legacy-crm/${env}`, {
      age: 200 * DAY,
    }),
  );
  const flags = put(
    db,
    obj(
      'v1',
      'ConfigMap',
      meta({ name: 'legacy-crm-flags', namespace: 'default', age: 190 * DAY }),
      {
        data: { 'crm.beta': 'false' },
      },
    ),
  );
  track(db, 'legacy-crm', flags);
  legacy.spec = { ...legacy.spec, syncPolicy: { syncOptions: ['CreateNamespace=true'] } };
  const legacyRev = hexId(db.rand, 40);
  legacy.status = {
    sync: { status: 'OutOfSync', revision: legacyRev },
    health: { status: 'Missing' },
    reconciledAt: ago(4 * MIN),
    resources: [
      {
        group: 'apps',
        version: 'v1',
        kind: 'Deployment',
        namespace: 'default',
        name: 'legacy-crm',
        status: 'OutOfSync',
        health: { status: 'Missing' },
      },
      {
        group: '',
        version: 'v1',
        kind: 'Service',
        namespace: 'default',
        name: 'legacy-crm',
        status: 'OutOfSync',
        health: { status: 'Missing' },
      },
      { ...resourceEntry(flags, 'OutOfSync'), requiresPruning: true },
    ],
    conditions: [
      {
        type: 'OrphanedResourceWarning',
        message: 'Application has 1 orphaned resources',
        lastTransitionTime: ago(6 * DAY),
      },
    ],
    history: history(
      db,
      2,
      hexId(db.rand, 40),
      legacy.spec.source as Record<string, unknown>,
      false,
    ),
    operationState: {
      phase: 'Failed',
      message:
        'one or more objects failed to apply, reason: Deployment.apps "legacy-crm" is invalid: spec.template.spec.containers[0].image: Required value',
      startedAt: ago(6 * DAY + 60_000),
      finishedAt: ago(6 * DAY),
      operation: { sync: { revision: legacyRev }, initiatedBy: { username: 'admin' } },
    },
  };
  put(db, legacy);

  // ApplicationSet generating one app per team (the first one is mid-sync).
  const teams = p.teams.slice(0, 2);
  if (teams.length) {
    const appset = put(
      db,
      obj(
        `${ARGO}/v1alpha1`,
        'ApplicationSet',
        meta({ name: 'team-apps', namespace: 'argocd', age: 80 * DAY }),
        {
          spec: {
            goTemplate: true,
            generators: [{ list: { elements: teams.map((team) => ({ team, env })) } }],
            template: {
              metadata: { name: 'team-{{.team}}' },
              spec: {
                project: 'default',
                source: {
                  repoURL: GITOPS_REPO,
                  path: 'teams/{{.team}}/overlays/{{.env}}',
                  targetRevision: 'main',
                },
                destination: {
                  server: 'https://kubernetes.default.svc',
                  namespace: 'team-{{.team}}',
                },
                syncPolicy: { automated: { prune: true, selfHeal: true } },
              },
            },
            syncPolicy: { preserveResourcesOnDeletion: true },
          },
          status: {
            conditions: [
              condition(
                'ParametersGenerated',
                'True',
                'ParametersGenerated',
                'Successfully generated parameters for all Applications',
                20 * DAY,
              ),
              condition(
                'ResourcesUpToDate',
                'True',
                'ApplicationSetUpToDate',
                'All applications have been generated successfully',
                20 * DAY,
              ),
            ],
            resources: [] as unknown[],
          },
        },
      ),
    );
    teams.forEach((team, i) => {
      const app = put(
        db,
        application(
          db,
          `team-${team}`,
          `team-${team}`,
          'default',
          `teams/${team}/overlays/${env}`,
          { owner: appset },
        ),
      );
      enrichApplication(db, app, {
        sync: i === 0 ? 'OutOfSync' : 'Synced',
        health: i === 0 ? 'Progressing' : 'Healthy',
        automated: true,
        outOfSync: i === 0 ? 1 : 0,
      });
      if (i === 0) {
        const target = hexId(db.rand, 40);
        const workload = topLevel(db, `team-${team}`).find((o) => o.kind === 'Deployment');
        const operation = {
          sync: { revision: target, syncStrategy: { hook: {} } },
          initiatedBy: { automated: true },
          retry: { limit: 5 },
        };
        app.operation = operation;
        app.status = {
          ...app.status,
          operationState: {
            operation,
            phase: 'Running',
            message: workload
              ? `waiting for healthy state of apps/Deployment/${workload.metadata.name}`
              : 'one or more tasks are running',
            startedAt: ago(70_000),
          },
        };
        put(db, app);
      }
      (appset.status as { resources: unknown[] }).resources.push({
        group: ARGO,
        version: 'v1alpha1',
        kind: 'Application',
        namespace: 'argocd',
        name: app.metadata.name,
        status: i === 0 ? 'Progressing' : 'Healthy',
        health: { status: i === 0 ? 'Progressing' : 'Healthy' },
      });
    });
    put(db, appset);
  }

  // App of apps: manages every top-level Application and the ApplicationSet.
  const root = put(
    db,
    application(db, 'root', 'argocd', 'default', `clusters/${env}/apps`, { age: 100 * DAY }),
  );
  const children = [
    ...apps().filter((a) => a.metadata.name !== 'root' && !a.metadata.ownerReferences?.length),
    ...list(db, `applicationsets.${ARGO}`),
  ];
  children.forEach((c) => track(db, 'root', c));
  const rootRev = hexId(db.rand, 40);
  root.status = {
    ...root.status,
    sync: { status: 'Synced', revision: rootRev },
    resources: children.map((c) => resourceEntry(c)),
    history: history(db, 6, rootRev, root.spec.source as Record<string, unknown>, true),
  };
  put(db, root);
}

// ---------------------------------------------------------------------------
// Flux
// ---------------------------------------------------------------------------

interface HelmReleaseShape {
  namespace: string;
  name: string;
  chart: string;
  version: string;
  repo: string;
  state: 'ready' | 'failing' | 'suspended';
  appVersion: string;
  previous?: string;
}

function inventoryEntry(o: KubeObject) {
  const { group, version } = parseApiVersion(o.apiVersion);
  const name = o.metadata.name.replace(/:/g, '__');
  return { id: `${o.metadata.namespace ?? ''}_${name}_${group}_${o.kind}`, v: version };
}

function fluxControllers(db: ClusterDb) {
  const ns = 'flux-system';
  const labels = {
    'app.kubernetes.io/part-of': 'flux',
    'app.kubernetes.io/instance': 'flux-system',
  };
  const controllers: Array<[string, string, number]> = [
    ['source-controller', 'ghcr.io/fluxcd/source-controller:v1.6.2', 9090],
    ['kustomize-controller', 'ghcr.io/fluxcd/kustomize-controller:v1.6.1', 8080],
    ['helm-controller', 'ghcr.io/fluxcd/helm-controller:v1.3.0', 8080],
    ['notification-controller', 'ghcr.io/fluxcd/notification-controller:v1.6.0', 9090],
  ];
  for (const [name, image, port] of controllers) {
    buildDeployment(db, {
      namespace: ns,
      name,
      age: 180 * DAY,
      replicas: 1,
      oldRevisions: 3,
      labels: { ...labels, 'app.kubernetes.io/component': name },
      template: tpl(
        name,
        [
          {
            name: 'manager',
            image,
            ports: [
              { name: 'http-prom', port: 8080 },
              ...(port !== 8080 ? [{ name: 'http', port }] : []),
            ],
            args: [
              '--events-addr=http://notification-controller.flux-system.svc.cluster.local./',
              '--watch-all-namespaces=true',
              '--log-level=info',
            ],
            cpu: ['100m', '1'],
            mem: ['64Mi', '1Gi'],
            probe: 'http',
          },
        ],
        { sa: name, labels },
      ),
    });
  }
  buildService(db, {
    namespace: ns,
    name: 'source-controller',
    selector: { app: 'source-controller' },
    ports: [{ name: 'http', port: 80, targetPort: 9090 }],
  });
  buildService(db, {
    namespace: ns,
    name: 'notification-controller',
    selector: { app: 'notification-controller' },
    ports: [{ name: 'http', port: 80, targetPort: 9090 }],
  });
}

function source(
  db: ClusterDb,
  kind: 'GitRepository' | 'HelmRepository' | 'OCIRepository' | 'HelmChart',
  name: string,
  spec: Record<string, unknown>,
  revision: string,
  age = 180 * DAY,
): KubeObject {
  return put(
    db,
    obj(
      `${FLUX_SRC}/v1`,
      kind,
      meta({ name, namespace: 'flux-system', age, finalizers: ['finalizers.fluxcd.io'] }),
      {
        spec,
        status: {
          observedGeneration: 1,
          artifact: {
            revision,
            digest: `sha256:${hexId(db.rand, 64)}`,
            lastUpdateTime: ago(between(db, 2, 50) * MIN),
            path: `${kind.toLowerCase()}/flux-system/${name}/${hexId(db.rand, 12)}.tar.gz`,
            size: between(db, 4_000, 90_000),
            url: `http://source-controller.flux-system.svc.cluster.local./${kind.toLowerCase()}/flux-system/${name}/latest.tar.gz`,
          },
          conditions: [
            condition(
              'Ready',
              'True',
              'Succeeded',
              `stored artifact for revision '${revision}'`,
              3 * DAY,
            ),
            condition(
              'ArtifactInStorage',
              'True',
              'Succeeded',
              `stored artifact for revision '${revision}'`,
              3 * DAY,
            ),
          ],
        },
      },
    ),
  );
}

function between(db: ClusterDb, min: number, max: number) {
  return min + Math.floor(db.rand() * (max - min + 1));
}

/** Objects of a Helm release (from the demo release manifest) get helm-controller's labels. */
function labelHelmRelease(db: ClusterDb, hr: KubeObject) {
  const ns = hr.metadata.namespace ?? 'default';
  const record = db.helm.get(`${ns}/${hr.metadata.name}`);
  if (!record) return;
  for (const doc of YAML.parseAllDocuments(record.manifest)) {
    const m = doc.toJS() as {
      apiVersion?: string;
      kind?: string;
      metadata?: { name?: string };
    } | null;
    if (!m?.apiVersion || !m.kind || !m.metadata?.name) continue;
    const o = find(db, keyOf(db, { apiVersion: m.apiVersion, kind: m.kind }), ns, m.metadata.name);
    if (o) label(db, o, { [HR_NAME]: hr.metadata.name, [HR_NS]: ns });
  }
}

function helmRelease(db: ClusterDb, r: HelmReleaseShape): KubeObject {
  const failing = r.state === 'failing';
  const deployedVersion = failing ? (r.previous ?? r.version) : r.version;
  const revisionNo = between(db, 3, 9);
  const historyEntries = [
    ...(failing
      ? [
          {
            chartName: r.chart,
            chartVersion: r.version,
            appVersion: r.appVersion,
            configDigest: `sha256:${hexId(db.rand, 64)}`,
            digest: `sha256:${hexId(db.rand, 64)}`,
            firstDeployed: ago(260 * DAY),
            lastDeployed: ago(2 * HOUR),
            name: r.name,
            namespace: r.namespace,
            status: 'failed',
            version: revisionNo + 1,
          },
        ]
      : []),
    {
      chartName: r.chart,
      chartVersion: deployedVersion,
      appVersion: r.appVersion,
      configDigest: `sha256:${hexId(db.rand, 64)}`,
      digest: `sha256:${hexId(db.rand, 64)}`,
      firstDeployed: ago(260 * DAY),
      lastDeployed: ago(between(db, 3, 30) * DAY),
      name: r.name,
      namespace: r.namespace,
      status: 'deployed',
      version: revisionNo,
    },
  ];
  const ready = failing
    ? condition(
        'Ready',
        'False',
        'UpgradeFailed',
        `Helm upgrade failed for release ${r.namespace}/${r.name} with chart ${r.chart}@${r.version}: context deadline exceeded`,
        2 * HOUR,
        3,
      )
    : condition(
        'Ready',
        'True',
        'UpgradeSucceeded',
        `Helm upgrade succeeded for release ${r.namespace}/${r.name}.v${revisionNo} with chart ${r.chart}@${r.version}`,
        between(db, 3, 30) * DAY,
        3,
      );
  const hr = put(
    db,
    obj(
      `${FLUX_HELM}/v2`,
      'HelmRelease',
      meta({
        name: r.name,
        namespace: r.namespace,
        age: 240 * DAY,
        finalizers: ['finalizers.fluxcd.io'],
      }),
      {
        spec: {
          interval: r.state === 'suspended' ? '1h' : '30m',
          chart: {
            spec: {
              chart: r.chart,
              version: r.version,
              sourceRef: { kind: 'HelmRepository', name: r.repo, namespace: 'flux-system' },
              interval: '12h',
            },
          },
          install: { remediation: { retries: 3 } },
          upgrade: { remediation: { retries: 3, remediateLastFailure: false } },
          ...(r.name === 'redis' ? { driftDetection: { mode: 'enabled' } } : {}),
          ...(r.state === 'suspended' ? { suspend: true } : {}),
          values: {},
        },
        status: {
          observedGeneration: 3,
          lastAttemptedRevision: r.version,
          lastAttemptedConfigDigest: `sha256:${hexId(db.rand, 64)}`,
          lastAttemptedGeneration: 3,
          lastAttemptedReleaseAction: 'upgrade',
          helmChart: `flux-system/${r.namespace}-${r.name}`,
          storageNamespace: r.namespace,
          history: historyEntries,
          ...(failing ? { failures: 3, upgradeFailures: 3 } : {}),
          conditions: failing
            ? [
                ready,
                condition('Released', 'False', 'UpgradeFailed', ready.message, 2 * HOUR, 3),
                condition(
                  'Stalled',
                  'True',
                  'RetriesExceeded',
                  'Failed to upgrade after 3 attempt(s)',
                  HOUR,
                  3,
                ),
              ]
            : [
                ready,
                condition('Released', 'True', 'UpgradeSucceeded', ready.message, 10 * DAY, 3),
              ],
        },
      },
    ),
  );
  source(
    db,
    'HelmChart',
    `${r.namespace}-${r.name}`,
    {
      chart: r.chart,
      version: r.version,
      sourceRef: { kind: 'HelmRepository', name: r.repo },
      interval: '12h',
      reconcileStrategy: 'ChartVersion',
    },
    r.version,
  );
  labelHelmRelease(db, hr);
  return hr;
}

function kustomization(
  db: ClusterDb,
  name: string,
  spec: Record<string, unknown>,
  inventory: KubeObject[],
  state: { applied: string; attempted?: string; failure?: [string, string] },
): KubeObject {
  const failure = state.failure;
  const conditions = failure
    ? [
        condition('Ready', 'False', failure[0], failure[1], 25 * MIN, 2),
        condition('Healthy', 'Unknown', 'Progressing', 'reconciliation in progress', 25 * MIN, 2),
      ]
    : [
        condition(
          'Ready',
          'True',
          'ReconciliationSucceeded',
          `Applied revision: ${state.applied}`,
          between(db, 1, 20) * HOUR,
          2,
        ),
        condition(
          'Healthy',
          'True',
          'Succeeded',
          'Health check passed',
          between(db, 1, 20) * HOUR,
          2,
        ),
      ];
  const ks = put(
    db,
    obj(
      `${FLUX_KS}/v1`,
      'Kustomization',
      meta({
        name,
        namespace: 'flux-system',
        age: 180 * DAY,
        finalizers: ['finalizers.fluxcd.io'],
      }),
      {
        spec: {
          interval: '10m',
          retryInterval: '2m',
          timeout: '5m',
          prune: true,
          sourceRef: { kind: 'GitRepository', name: 'flux-system' },
          ...spec,
        },
        status: {
          observedGeneration: 2,
          lastAppliedRevision: state.applied,
          lastAttemptedRevision: state.attempted ?? state.applied,
          conditions,
          inventory: { entries: inventory.map(inventoryEntry) },
        },
      },
    ),
  );
  ks.metadata.generation = 2;
  for (const o of inventory) label(db, o, { [KS_NAME]: name, [KS_NS]: 'flux-system' });
  return ks;
}

function namespaceObj(db: ClusterDb, name: string) {
  return find(db, 'namespaces', null, name);
}

function buildFlux(db: ClusterDb) {
  const p = db.profile;
  const env = p.id.replace('c-', '');
  const dev = p.id === 'c-dev';
  fluxControllers(db);

  const head = `main@sha1:${hexId(db.rand, 40)}`;
  const previous = `main@sha1:${hexId(db.rand, 40)}`;
  const fleet = source(
    db,
    'GitRepository',
    'flux-system',
    {
      url: 'ssh://git@github.com/acme/fleet-infra',
      ref: { branch: 'main' },
      interval: '1m0s',
      secretRef: { name: 'flux-system' },
    },
    head,
  );
  const repos = [
    source(
      db,
      'HelmRepository',
      'bitnami',
      { url: 'https://charts.bitnami.com/bitnami', interval: '1h' },
      `sha256:${hexId(db.rand, 64)}`,
    ),
    source(
      db,
      'HelmRepository',
      'grafana',
      { url: 'https://grafana.github.io/helm-charts', interval: '1h' },
      `sha256:${hexId(db.rand, 64)}`,
    ),
  ];
  if (dev)
    repos.push(
      source(
        db,
        'HelmRepository',
        'jetstack',
        { url: 'https://charts.jetstack.io', interval: '1h' },
        `sha256:${hexId(db.rand, 64)}`,
      ),
      source(
        db,
        'HelmRepository',
        'ingress-nginx',
        { url: 'https://kubernetes.github.io/ingress-nginx', interval: '1h' },
        `sha256:${hexId(db.rand, 64)}`,
      ),
    );
  const podinfo = source(
    db,
    'OCIRepository',
    'podinfo',
    {
      url: 'oci://ghcr.io/stefanprodan/manifests/podinfo',
      ref: { semver: '6.x' },
      interval: '10m',
    },
    `6.7.1@sha256:${hexId(db.rand, 64)}`,
    30 * DAY,
  );

  const releases: HelmReleaseShape[] = [
    {
      namespace: 'data',
      name: 'redis',
      chart: 'redis',
      version: '20.6.2',
      repo: 'bitnami',
      state: 'ready',
      appVersion: '7.4.2',
    },
    {
      namespace: 'data',
      name: 'postgresql',
      chart: 'postgresql',
      version: '16.4.0',
      previous: '16.2.5',
      repo: 'bitnami',
      state: 'failing',
      appVersion: '17.2.0',
    },
    {
      namespace: 'monitoring',
      name: 'grafana',
      chart: 'grafana',
      version: '8.8.2',
      repo: 'grafana',
      state: 'suspended',
      appVersion: '11.4.0',
    },
  ];
  if (dev)
    releases.push(
      {
        namespace: 'cert-manager',
        name: 'cert-manager',
        chart: 'cert-manager',
        version: 'v1.16.2',
        repo: 'jetstack',
        state: 'ready',
        appVersion: 'v1.16.2',
      },
      {
        namespace: 'ingress-nginx',
        name: 'ingress-nginx',
        chart: 'ingress-nginx',
        version: '4.12.0',
        repo: 'ingress-nginx',
        state: 'ready',
        appVersion: '1.12.0',
      },
    );
  const hrs = releases.map((r) => helmRelease(db, r));

  const nsObjects = (names: string[]) =>
    names.map((n) => namespaceObj(db, n)).filter((o): o is KubeObject => !!o);
  const infra = kustomization(
    db,
    'infrastructure',
    { path: `./infrastructure/${env}`, wait: true },
    [...nsObjects(['data', ...(dev ? ['cert-manager', 'ingress-nginx'] : [])]), ...hrs],
    { applied: head },
  );
  const kustomizations = [infra];
  if (dev) {
    const workloads = ['web', 'checkout']
      .flatMap((n) => topLevel(db, n))
      .filter((o) => !fluxManaged(o));
    kustomizations.push(
      kustomization(
        db,
        'apps',
        { path: `./apps/${env}`, dependsOn: [{ name: 'infrastructure' }] },
        workloads,
        { applied: head },
      ),
    );
  }
  kustomizations.push(
    kustomization(
      db,
      'tenants',
      { path: `./tenants/${env}`, dependsOn: [{ name: 'infrastructure' }] },
      nsObjects(p.teams.map((t) => `team-${t}`)),
      {
        applied: previous,
        attempted: head,
        failure: [
          'BuildFailed',
          `kustomize build failed: accumulating resources: accumulation err='accumulating resources from './${p.teams[0] ?? 'payments'}': '/tmp/kustomization-${hexId(db.rand, 9)}/tenants/${env}/${p.teams[0] ?? 'payments'}/rbac.yaml' must resolve to an object'`,
        ],
      },
    ),
  );
  kustomization(
    db,
    'flux-system',
    { path: `./clusters/${env}`, interval: '10m' },
    [...nsObjects(['flux-system']), fleet, ...repos, podinfo, ...kustomizations],
    { applied: head },
  );

  put(
    db,
    obj(
      `${FLUX_NOTIFY}/v1beta3`,
      'Provider',
      meta({ name: 'slack', namespace: 'flux-system', age: 150 * DAY }),
      {
        spec: { type: 'slack', channel: `#deploys-${env}`, secretRef: { name: 'slack-webhook' } },
      },
    ),
  );
  put(
    db,
    obj(
      `${FLUX_NOTIFY}/v1beta3`,
      'Alert',
      meta({ name: 'on-call', namespace: 'flux-system', age: 150 * DAY }),
      {
        spec: {
          providerRef: { name: 'slack' },
          eventSeverity: 'error',
          eventSources: [
            { kind: 'Kustomization', name: '*' },
            { kind: 'HelmRelease', name: '*' },
          ],
        },
      },
    ),
  );
}

/** Runs after Helm releases exist (their manifests identify HelmRelease-managed objects). */
export function buildGitOps(db: ClusterDb) {
  // Flux first: Argo CD leaves Flux-managed objects alone.
  if (hasFlux(db)) buildFlux(db);
  if (db.profile.argocd) buildArgoApps(db);
}
