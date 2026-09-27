import { find, list, put, type ClusterDb } from './db';
import { between, DAY, meta, obj } from './util';

/** ResourceQuotas, LimitRanges, HorizontalPodAutoscalers and PodDisruptionBudgets. */

export function buildPolicies(db: ClusterDb) {
  const p = db.profile;
  for (const [ns, cpu, memory, pods] of [
    ['checkout', '40', '96Gi', '100'],
    ['web', '32', '64Gi', '80'],
    ['data', '64', '256Gi', '60'],
  ] as const) {
    const nsPods = list(db, 'pods').filter((x) => x.metadata.namespace === ns);
    put(
      db,
      obj('v1', 'ResourceQuota', meta({ name: `${ns}-quota`, namespace: ns, age: 150 * DAY }), {
        spec: {
          hard: {
            'requests.cpu': cpu,
            'requests.memory': memory,
            'limits.cpu': String(Number(cpu) * 2),
            'limits.memory': memory,
            pods,
            'services.loadbalancers': '0',
            persistentvolumeclaims: '20',
          },
        },
        status: {
          hard: {
            'requests.cpu': cpu,
            'requests.memory': memory,
            'limits.cpu': String(Number(cpu) * 2),
            'limits.memory': memory,
            pods,
            'services.loadbalancers': '0',
            persistentvolumeclaims: '20',
          },
          used: {
            'requests.cpu': `${nsPods.length * 350}m`,
            'requests.memory': `${nsPods.length * 640}Mi`,
            'limits.cpu': `${nsPods.length * 1100}m`,
            'limits.memory': `${nsPods.length * 1200}Mi`,
            pods: String(nsPods.length),
            'services.loadbalancers': '0',
            persistentvolumeclaims: ns === 'data' ? '7' : '0',
          },
        },
      }),
    );
  }
  put(
    db,
    obj(
      'v1',
      'LimitRange',
      meta({ name: 'container-defaults', namespace: 'checkout', age: 150 * DAY }),
      {
        spec: {
          limits: [
            {
              type: 'Container',
              default: { cpu: '500m', memory: '512Mi' },
              defaultRequest: { cpu: '100m', memory: '128Mi' },
              max: { cpu: '4', memory: '8Gi' },
              min: { cpu: '10m', memory: '16Mi' },
            },
            { type: 'PersistentVolumeClaim', max: { storage: '200Gi' }, min: { storage: '1Gi' } },
          ],
        },
      },
    ),
  );
  put(
    db,
    obj(
      'v1',
      'LimitRange',
      meta({ name: 'container-defaults', namespace: 'web', age: 150 * DAY }),
      {
        spec: {
          limits: [
            {
              type: 'Container',
              default: { cpu: '500m', memory: '256Mi' },
              defaultRequest: { cpu: '50m', memory: '64Mi' },
            },
          ],
        },
      },
    ),
  );

  const hpa = (
    ns: string,
    name: string,
    min: number,
    max: number,
    target: number,
    currentPct: number | null,
    extraMemory = false,
  ) => {
    const dep = find(db, 'deployments.apps', ns, name);
    if (!dep) return;
    const replicas = Number(dep.spec?.replicas ?? 1);
    put(
      db,
      obj(
        'autoscaling/v2',
        'HorizontalPodAutoscaler',
        meta({ name, namespace: ns, age: 100 * DAY }),
        {
          spec: {
            scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name },
            minReplicas: min,
            maxReplicas: max,
            metrics: [
              {
                type: 'Resource',
                resource: {
                  name: 'cpu',
                  target: { type: 'Utilization', averageUtilization: target },
                },
              },
              ...(extraMemory
                ? [
                    {
                      type: 'Resource',
                      resource: {
                        name: 'memory',
                        target: { type: 'AverageValue', averageValue: '400Mi' },
                      },
                    },
                  ]
                : []),
            ],
            behavior: {
              scaleDown: {
                stabilizationWindowSeconds: 300,
                policies: [{ type: 'Percent', value: 50, periodSeconds: 60 }],
              },
            },
          },
          status: {
            currentReplicas: replicas,
            desiredReplicas: replicas,
            lastScaleTime: new Date(Date.now() - between(db.rand, 1, 48) * 3600_000).toISOString(),
            currentMetrics:
              currentPct === null
                ? []
                : [
                    {
                      type: 'Resource',
                      resource: {
                        name: 'cpu',
                        current: {
                          averageUtilization: currentPct,
                          averageValue: `${currentPct * 3}m`,
                        },
                      },
                    },
                    ...(extraMemory
                      ? [
                          {
                            type: 'Resource',
                            resource: { name: 'memory', current: { averageValue: '312Mi' } },
                          },
                        ]
                      : []),
                  ],
            conditions: [
              {
                type: 'AbleToScale',
                status: 'True',
                reason: 'ReadyForNewScale',
                message: 'recommended size matches current size',
                lastTransitionTime: new Date(Date.now() - 3 * 86400_000).toISOString(),
              },
              currentPct === null
                ? {
                    type: 'ScalingActive',
                    status: 'False',
                    reason: 'FailedGetResourceMetric',
                    message:
                      'the HPA was unable to compute the replica count: failed to get cpu utilization: unable to get metrics for resource cpu: no metrics returned from resource metrics API',
                    lastTransitionTime: new Date(Date.now() - 86400_000).toISOString(),
                  }
                : {
                    type: 'ScalingActive',
                    status: 'True',
                    reason: 'ValidMetricFound',
                    message:
                      'the HPA was able to successfully calculate a replica count from cpu resource utilization (percentage of request)',
                    lastTransitionTime: new Date(Date.now() - 3 * 86400_000).toISOString(),
                  },
              {
                type: 'ScalingLimited',
                status: replicas <= min ? 'True' : 'False',
                reason: replicas <= min ? 'TooFewReplicas' : 'DesiredWithinRange',
                message:
                  replicas <= min
                    ? 'the desired replica count is less than the minimum replica count'
                    : 'the desired count is within the acceptable range',
                lastTransitionTime: new Date(Date.now() - 86400_000).toISOString(),
              },
            ],
          },
        },
      ),
    );
  };
  const metrics = p.metrics;
  hpa('checkout', 'payment-api', p.platform === 'kind' ? 2 : 3, 10, 70, metrics ? 42 : null, true);
  hpa('web', 'storefront', p.platform === 'kind' ? 2 : 3, 12, 70, metrics ? 58 : null);
  hpa('web', 'image-resizer', 2, 8, 60, metrics ? 23 : null);

  const pdb = (
    ns: string,
    name: string,
    rule: Record<string, number | string>,
    expected: number,
    healthy: number,
  ) =>
    put(
      db,
      obj('policy/v1', 'PodDisruptionBudget', meta({ name, namespace: ns, age: 100 * DAY }), {
        spec: {
          ...rule,
          selector: { matchLabels: { app: name } },
          unhealthyPodEvictionPolicy: 'AlwaysAllow',
        },
        status: {
          currentHealthy: healthy,
          desiredHealthy:
            'minAvailable' in rule
              ? Number(rule.minAvailable)
              : expected - Number(rule.maxUnavailable ?? 1),
          disruptionsAllowed: Math.max(
            0,
            healthy -
              ('minAvailable' in rule
                ? Number(rule.minAvailable)
                : expected - Number(rule.maxUnavailable ?? 1)),
          ),
          expectedPods: expected,
          observedGeneration: 1,
          conditions: [
            {
              type: 'DisruptionAllowed',
              status: healthy > expected - 1 ? 'True' : 'False',
              reason: healthy > expected - 1 ? 'SufficientPods' : 'InsufficientPods',
              message: '',
              lastTransitionTime: new Date(Date.now() - 86400_000).toISOString(),
              observedGeneration: 1,
            },
          ],
        },
      }),
    );
  const count = (ns: string, app: string) =>
    list(db, 'pods').filter((x) => x.metadata.namespace === ns && x.metadata.labels?.app === app);
  const ready = (ns: string, app: string) =>
    count(ns, app).filter((x) =>
      (x.status?.conditions as Array<{ type: string; status: string }> | undefined)?.some(
        (c) => c.type === 'Ready' && c.status === 'True',
      ),
    ).length;
  pdb(
    'checkout',
    'payment-api',
    { minAvailable: 2 },
    count('checkout', 'payment-api').length,
    ready('checkout', 'payment-api'),
  );
  pdb(
    'web',
    'storefront',
    { maxUnavailable: 1 },
    count('web', 'storefront').length,
    ready('web', 'storefront'),
  );
  pdb(
    'data',
    'postgres',
    { maxUnavailable: 1 },
    count('data', 'postgres').length,
    ready('data', 'postgres'),
  );
  pdb('kube-system', p.platform === 'GKE' ? 'kube-dns' : 'coredns', { maxUnavailable: 1 }, 2, 2);
}
