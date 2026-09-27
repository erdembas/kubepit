import { buildDeployment } from './builders';
import { DEMO_TLS_KEY, LEGACY_LEAF, issuerCa, stamped } from './certs';
import { put, type ClusterDb } from './db';
import { buildIngress, buildService } from './network';
import { tpl } from './template';
import { b64, DAY, hexId, meta, obj } from './util';

/**
 * Leftovers that make the health view interesting on the troubled demo
 * clusters: a forgotten legacy shop (`:latest`, no probes, expired TLS
 * certificate, wrong ingress port, HPA without CPU requests, orphaned
 * budget, config and volume), a privileged debug pod, a digest pulled with
 * `Always`, a canary Service that selects nothing and an HPA whose target
 * was deleted.
 */
export function buildHealthDemo(db: ClusterDb) {
  const p = db.profile;
  if (!p.troubled) return;
  const ns = 'web';

  buildDeployment(db, {
    namespace: ns,
    name: 'legacy-shop',
    age: 400 * DAY,
    replicas: 1,
    labels: { team: 'web', tier: 'frontend' },
    template: tpl('legacy-shop', [
      { name: 'shop', image: 'ghcr.io/acme/legacy-shop:latest', ports: [8080] },
    ]),
  });
  buildService(db, {
    namespace: ns,
    name: 'legacy-shop',
    selector: { app: 'legacy-shop' },
    ports: [{ name: 'http', port: 80, targetPort: 8080 }],
  });
  buildIngress(db, {
    namespace: ns,
    name: 'legacy-shop',
    host: `legacy.${p.domain}`,
    tls: 'legacy-tls',
    paths: [
      ['/', 'legacy-shop', 80],
      ['/admin', 'legacy-shop', 8443],
    ],
  });
  put(
    db,
    obj(
      'v1',
      'Secret',
      meta({ name: 'legacy-tls', namespace: ns, age: 374 * DAY, labels: { app: 'legacy-shop' } }),
      {
        type: 'kubernetes.io/tls',
        data: {
          // Issued 374 days ago for a year: expired 9 days ago.
          'tls.crt': b64(stamped(LEGACY_LEAF, 374, -9) + issuerCa()),
          'tls.key': b64(DEMO_TLS_KEY),
        },
      },
    ),
  );
  put(
    db,
    obj(
      'autoscaling/v2',
      'HorizontalPodAutoscaler',
      meta({ name: 'legacy-shop', namespace: ns, age: 200 * DAY }),
      {
        spec: {
          scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'legacy-shop' },
          minReplicas: 1,
          maxReplicas: 4,
          metrics: [
            {
              type: 'Resource',
              resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } },
            },
          ],
        },
        status: {
          currentReplicas: 1,
          desiredReplicas: 1,
          conditions: [
            {
              type: 'ScalingActive',
              status: 'False',
              reason: 'FailedGetResourceMetric',
              message:
                'the HPA was unable to compute the replica count: missing request for cpu in container shop',
            },
          ],
        },
      },
    ),
  );
  put(
    db,
    obj(
      'policy/v1',
      'PodDisruptionBudget',
      meta({ name: 'legacy-shop-v1', namespace: ns, age: 380 * DAY }),
      {
        spec: { minAvailable: 1, selector: { matchLabels: { app: 'legacy-shop-v1' } } },
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
  put(
    db,
    obj('v1', 'ConfigMap', meta({ name: 'legacy-shop-config-v1', namespace: ns, age: 390 * DAY }), {
      data: { 'shop.properties': 'checkout.provider=legacy\ncache.ttl=300\n' },
    }),
  );
  put(
    db,
    obj(
      'v1',
      'PersistentVolumeClaim',
      meta({ name: 'legacy-shop-uploads', namespace: ns, age: 395 * DAY }),
      {
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: '50Gi' } },
          volumeName: `pvc-${hexId(db.rand, 8)}-legacy-uploads`,
          volumeMode: 'Filesystem',
        },
        status: { phase: 'Bound', accessModes: ['ReadWriteOnce'], capacity: { storage: '50Gi' } },
      },
    ),
  );
  put(
    db,
    obj('v1', 'Secret', meta({ name: 'legacy-shop-db', namespace: ns, age: 390 * DAY }), {
      type: 'Opaque',
      data: { DATABASE_URL: b64('mysql://shop:demo-password@legacy-db.web:3306/shop') },
    }),
  );

  // A debug pod someone forgot: privileged, root, docker socket from the host.
  const toolbox = tpl(
    'debug-toolbox',
    [{ name: 'toolbox', image: 'docker.io/library/busybox', command: ['sleep', 'infinity'] }],
    {
      volumes: [
        { name: 'docker-sock', hostPath: { path: '/var/run/docker.sock', type: 'Socket' } },
      ],
    },
  );
  toolbox.spec.securityContext = {};
  const box = (toolbox.spec.containers as Array<Record<string, unknown>>)[0]!;
  box.securityContext = { privileged: true, runAsUser: 0 };
  box.volumeMounts = [{ name: 'docker-sock', mountPath: '/var/run/docker.sock' }];
  buildDeployment(db, {
    namespace: 'default',
    name: 'debug-toolbox',
    age: 12 * DAY,
    replicas: 1,
    template: toolbox,
  });

  // Pinned by digest but pulled on every start.
  const exporter = tpl('sql-exporter', [
    {
      name: 'exporter',
      image:
        'ghcr.io/acme/sql-exporter@sha256:5b0bcabd1ed22e9fb1310cf6c2dec7cdef19f0ad69efa1f392e94a4333501270',
      ports: [9399],
      cpu: ['50m', '200m'],
      mem: ['64Mi', '128Mi'],
      probe: 'http',
    },
  ]);
  const ex = (exporter.spec.containers as Array<Record<string, unknown>>)[0]!;
  ex.imagePullPolicy = 'Always';
  ex.securityContext = { allowPrivilegeEscalation: false, runAsUser: 65534 };
  buildDeployment(db, {
    namespace: 'data',
    name: 'sql-exporter',
    age: 60 * DAY,
    replicas: 2,
    template: exporter,
  });

  buildService(db, {
    namespace: ns,
    name: 'storefront-canary',
    selector: { app: 'storefront', track: 'canary' },
    ports: [{ name: 'http', port: 80, targetPort: 3000 }],
  });
  put(
    db,
    obj(
      'autoscaling/v2',
      'HorizontalPodAutoscaler',
      meta({ name: 'report-api', namespace: 'data', age: 150 * DAY }),
      {
        spec: {
          scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'report-api' },
          minReplicas: 2,
          maxReplicas: 6,
          metrics: [
            {
              type: 'Resource',
              resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 60 } },
            },
          ],
        },
        status: {
          currentReplicas: 0,
          desiredReplicas: 0,
          conditions: [
            {
              type: 'AbleToScale',
              status: 'False',
              reason: 'FailedGetScale',
              message: 'deployments/scale.apps "report-api" not found',
            },
          ],
        },
      },
    ),
  );
}
