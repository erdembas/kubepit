import YAML from 'yaml';
import type { HelmRelease } from '@/types';
import { helmKey, put, type ClusterDb } from './db';
import { syncHelmSecrets } from './helm';
import { DAY, HOUR, meta, obj } from './util';

/**
 * Demo data for upgrade readiness: objects last applied or still written
 * through deprecated API versions, a Helm release whose stored manifest
 * uses removed ones, and a CRD serving a deprecated version. Spread over
 * the clusters so the fleet summary shows blockers, warnings and a clean
 * cluster (kind).
 */

const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';

/** `managedFields` are stripped from objects the UI sees; the demo scanner reads them here. */
const managedFields = new WeakMap<
  ClusterDb,
  Map<string, Array<{ manager: string; apiVersion: string }>>
>();

export function demoManagedFields(db: ClusterDb, uid: string) {
  return managedFields.get(db)?.get(uid) ?? [];
}

/** Legacy objects per cluster (profile id). */
const PLAN: Record<string, Array<'helm' | 'ingress' | 'pdb' | 'cronjob' | 'hpa' | 'crd'>> = {
  'c-prod-eu': ['helm', 'ingress', 'pdb', 'cronjob', 'hpa', 'crd'],
  'c-prod-us': ['helm', 'ingress', 'crd'],
  'c-staging': ['cronjob', 'hpa', 'crd'],
  'c-dev': ['crd'],
};

function lastApplied(apiVersion: string, kind: string, name: string, namespace: string) {
  return JSON.stringify({ apiVersion, kind, metadata: { name, namespace } });
}

function legacyManifest(domain: string): string {
  const docs: Array<[string, Record<string, unknown>]> = [
    [
      'acme-portal/templates/service.yaml',
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'legacy-portal', labels: { app: 'legacy-portal' } },
        spec: { selector: { app: 'legacy-portal' }, ports: [{ port: 80, targetPort: 8080 }] },
      },
    ],
    [
      'acme-portal/templates/ingress.yaml',
      {
        apiVersion: 'extensions/v1beta1',
        kind: 'Ingress',
        metadata: { name: 'legacy-portal', labels: { app: 'legacy-portal' } },
        spec: {
          rules: [
            {
              host: `portal.${domain}`,
              http: {
                paths: [{ path: '/', backend: { serviceName: 'legacy-portal', servicePort: 80 } }],
              },
            },
          ],
        },
      },
    ],
    [
      'acme-portal/templates/pdb.yaml',
      {
        apiVersion: 'policy/v1beta1',
        kind: 'PodDisruptionBudget',
        metadata: { name: 'legacy-portal' },
        spec: { minAvailable: 1, selector: { matchLabels: { app: 'legacy-portal' } } },
      },
    ],
    [
      'acme-portal/templates/cronjob.yaml',
      {
        apiVersion: 'batch/v1beta1',
        kind: 'CronJob',
        metadata: { name: 'nightly-report' },
        spec: {
          schedule: '0 2 * * *',
          jobTemplate: {
            spec: {
              template: {
                spec: {
                  restartPolicy: 'OnFailure',
                  containers: [{ name: 'report', image: 'ghcr.io/acme/portal-report:0.9.1' }],
                },
              },
            },
          },
        },
      },
    ],
  ];
  return docs
    .map(([source, doc]) => `---\n# Source: ${source}\n${YAML.stringify(doc, { lineWidth: 0 })}`)
    .join('');
}

export function buildUpgradeDemo(db: ClusterDb) {
  const plan = PLAN[db.profile.id];
  if (!plan) return;
  const ns = 'web';
  const fields = new Map<string, Array<{ manager: string; apiVersion: string }>>();
  managedFields.set(db, fields);
  const domain = db.profile.domain;

  if (plan.includes('ingress'))
    put(
      db,
      obj(
        'networking.k8s.io/v1',
        'Ingress',
        meta({
          name: 'legacy-portal',
          namespace: ns,
          age: 900 * DAY,
          labels: { app: 'legacy-portal' },
          annotations: {
            [LAST_APPLIED]: lastApplied('extensions/v1beta1', 'Ingress', 'legacy-portal', ns),
          },
        }),
        {
          spec: {
            ingressClassName: 'nginx',
            rules: [
              {
                host: `portal.${domain}`,
                http: {
                  paths: [
                    {
                      path: '/',
                      pathType: 'Prefix',
                      backend: { service: { name: 'legacy-portal', port: { number: 80 } } },
                    },
                  ],
                },
              },
            ],
          },
          status: { loadBalancer: {} },
        },
      ),
    );

  if (plan.includes('pdb'))
    put(
      db,
      obj(
        'policy/v1',
        'PodDisruptionBudget',
        meta({
          name: 'legacy-portal',
          namespace: ns,
          age: 900 * DAY,
          annotations: {
            [LAST_APPLIED]: lastApplied(
              'policy/v1beta1',
              'PodDisruptionBudget',
              'legacy-portal',
              ns,
            ),
          },
        }),
        {
          spec: { minAvailable: 1, selector: { matchLabels: { app: 'legacy-portal' } } },
          status: {
            currentHealthy: 0,
            desiredHealthy: 1,
            disruptionsAllowed: 0,
            expectedPods: 0,
            observedGeneration: 1,
          },
        },
      ),
    );

  if (plan.includes('cronjob')) {
    const cron = put(
      db,
      obj('batch/v1', 'CronJob', meta({ name: 'nightly-report', namespace: ns, age: 700 * DAY }), {
        spec: {
          schedule: '0 2 * * *',
          concurrencyPolicy: 'Forbid',
          suspend: false,
          jobTemplate: {
            spec: {
              template: {
                spec: {
                  restartPolicy: 'OnFailure',
                  containers: [{ name: 'report', image: 'ghcr.io/acme/portal-report:0.9.1' }],
                },
              },
            },
          },
        },
        status: { lastScheduleTime: new Date(Date.now() - 20 * HOUR).toISOString() },
      }),
    );
    fields.set(cron.metadata.uid, [
      { manager: 'jenkins-deployer', apiVersion: 'batch/v1beta1' },
      { manager: 'kube-controller-manager', apiVersion: 'batch/v1' },
    ]);
  }

  if (plan.includes('hpa')) {
    const hpa = put(
      db,
      obj(
        'autoscaling/v2',
        'HorizontalPodAutoscaler',
        meta({ name: 'legacy-portal', namespace: ns, age: 500 * DAY }),
        {
          spec: {
            scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'legacy-portal' },
            minReplicas: 2,
            maxReplicas: 6,
            metrics: [
              {
                type: 'Resource',
                resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 75 } },
              },
            ],
          },
          status: { currentReplicas: 2, desiredReplicas: 2 },
        },
      ),
    );
    fields.set(hpa.metadata.uid, [
      { manager: 'argocd-application-controller', apiVersion: 'autoscaling/v2beta2' },
    ]);
  }

  if (plan.includes('crd'))
    put(
      db,
      obj(
        'apiextensions.k8s.io/v1',
        'CustomResourceDefinition',
        meta({ name: 'widgets.legacy.acme.io', age: 600 * DAY }),
        {
          spec: {
            group: 'legacy.acme.io',
            names: {
              kind: 'Widget',
              listKind: 'WidgetList',
              plural: 'widgets',
              singular: 'widget',
            },
            scope: 'Namespaced',
            versions: [
              {
                name: 'v1alpha1',
                served: true,
                storage: false,
                deprecated: true,
                deprecationWarning:
                  'legacy.acme.io/v1alpha1 Widget is deprecated; use legacy.acme.io/v1',
                schema: {
                  openAPIV3Schema: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
                },
              },
              {
                name: 'v1',
                served: true,
                storage: true,
                schema: {
                  openAPIV3Schema: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
                },
              },
            ],
          },
          status: {
            acceptedNames: { kind: 'Widget', plural: 'widgets' },
            storedVersions: ['v1alpha1', 'v1'],
          },
        },
      ),
    );

  if (plan.includes('helm')) {
    const updated = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();
    const history: HelmRelease[] = [
      {
        name: 'legacy-portal',
        namespace: ns,
        revision: 1,
        status: 'superseded',
        chart: 'acme-portal',
        chart_version: '0.8.3',
        app_version: '3.2.0',
        updated: updated(1100),
        description: 'Install complete',
      },
      {
        name: 'legacy-portal',
        namespace: ns,
        revision: 2,
        status: 'deployed',
        chart: 'acme-portal',
        chart_version: '0.9.1',
        app_version: '3.4.2',
        updated: updated(820),
        description: 'Upgrade complete',
      },
    ];
    const values = YAML.stringify({
      replicaCount: 2,
      ingress: { enabled: true, host: `portal.${domain}` },
    });
    db.helm.set(helmKey(ns, 'legacy-portal'), {
      history,
      values: [values, values],
      manifest: legacyManifest(domain),
      notes: 'The ACME portal is available at http://portal.' + domain + '\n',
      computed: YAML.stringify({
        replicaCount: 2,
        image: { repository: 'ghcr.io/acme/portal', tag: '3.4.2' },
        ingress: { enabled: true, host: `portal.${domain}` },
      }),
    });
    syncHelmSecrets(db, ns, 'legacy-portal');
  }
}
