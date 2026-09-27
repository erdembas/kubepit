import { list, put, type ClusterDb } from './db';
import { buildCronJob, buildDeployment, buildJob, buildStatefulSet } from './builders';
import { buildService } from './network';
import { makePod, type PodVariant } from './pods';
import { tpl } from './template';
import { between, DAY, HOUR, meta, MIN, obj, pick } from './util';

/** Data namespace (databases, batch jobs), legacy controllers and filler team namespaces. */

export function buildData(db: ClusterDb) {
  const p = db.profile;
  const ns = 'data';
  const small = p.platform === 'kind';
  const sc =
    p.platform === 'EKS'
      ? 'gp3'
      : p.platform === 'GKE'
        ? 'standard-rwo'
        : p.platform === 'AKS'
          ? 'managed-csi'
          : 'standard';
  buildStatefulSet(db, {
    namespace: ns,
    name: 'postgres',
    serviceName: 'postgres-headless',
    age: 260 * DAY,
    replicas: small ? 1 : 3,
    storage: small ? '5Gi' : '100Gi',
    storageClass: sc,
    restarts: { 1: 2 },
    template: tpl(
      'postgres',
      [
        {
          name: 'postgres',
          image: 'docker.io/bitnami/postgresql:16.6.0-debian-12-r2',
          ports: [{ name: 'tcp-postgresql', port: 5432 }],
          cpu: ['500m', '2'],
          mem: ['1Gi', '4Gi'],
          probe: 'exec',
          env: [
            ['POSTGRES_USER', 'app'],
            ['POSTGRES_PASSWORD', { secret: ['postgres-credentials', 'password'] }],
            ['PGDATA', '/bitnami/postgresql/data'],
          ],
          mounts: [
            ['data', '/bitnami/postgresql'],
            ['dshm', '/dev/shm'],
          ],
        },
        {
          name: 'metrics',
          image: 'docker.io/bitnami/postgres-exporter:0.16.0',
          ports: [{ name: 'http-metrics', port: 9187 }],
          cpu: ['10m', '100m'],
          mem: ['32Mi', '64Mi'],
        },
      ],
      {
        sa: 'postgres',
        init: [
          {
            name: 'init-permissions',
            image: 'docker.io/bitnami/os-shell:12-debian-12-r34',
            command: ['/bin/bash', '-ec', 'chown -R 1001:1001 /bitnami/postgresql'],
          },
        ],
        volumes: [{ name: 'dshm', emptyDir: { medium: 'Memory', sizeLimit: '1Gi' } }],
      },
    ),
  });
  buildService(db, {
    namespace: ns,
    name: 'postgres',
    selector: { app: 'postgres' },
    ports: [{ name: 'tcp-postgresql', port: 5432 }],
  });
  buildService(db, {
    namespace: ns,
    name: 'postgres-headless',
    type: 'Headless',
    selector: { app: 'postgres' },
    ports: [{ name: 'tcp-postgresql', port: 5432 }],
  });
  buildStatefulSet(db, {
    namespace: ns,
    name: 'redis',
    serviceName: 'redis-headless',
    age: 240 * DAY,
    replicas: small ? 1 : 3,
    storage: '8Gi',
    storageClass: sc,
    template: tpl(
      'redis',
      [
        {
          name: 'redis',
          image: 'docker.io/bitnami/redis:7.4.2-debian-12-r0',
          ports: [{ name: 'redis', port: 6379 }],
          cpu: ['100m', '500m'],
          mem: ['256Mi', '512Mi'],
          probe: 'tcp',
          mounts: [['data', '/data']],
        },
      ],
      { sa: 'redis' },
    ),
  });
  buildService(db, {
    namespace: ns,
    name: 'redis',
    selector: { app: 'redis' },
    ports: [{ name: 'tcp-redis', port: 6379 }],
  });
  buildService(db, {
    namespace: ns,
    name: 'redis-headless',
    type: 'Headless',
    selector: { app: 'redis' },
    ports: [{ name: 'tcp-redis', port: 6379 }],
  });
  buildDeployment(db, {
    namespace: ns,
    name: 'etl-worker',
    age: 120 * DAY,
    replicas: 2,
    rsHash: '5d7f9c8b4',
    podNames: ['v9k2s', 'mm2lz'],
    variants: p.troubled ? { 0: 'oom', 1: 'pending' } : {},
    oldRevisions: 4,
    template: tpl(
      'etl-worker',
      [
        {
          name: 'etl-worker',
          image: 'ghcr.io/acme/etl-worker:4.0.1',
          cpu: ['1', '2'],
          mem: ['6Gi', '8Gi'],
          env: [
            ['QUEUE_URL', 'redis://redis:6379/2'],
            ['BATCH_SIZE', '5000'],
          ],
        },
      ],
      { priorityClassName: 'batch-low' },
    ),
  });
  const backup = tpl('nightly-backup', [
    {
      name: 'pg-dump',
      image: 'docker.io/bitnami/postgresql:16.6.0-debian-12-r2',
      command: ['/bin/sh', '-c', 'pg_dumpall | gzip > /backup/$(date +%F).sql.gz'],
      env: [['PGPASSWORD', { secret: ['postgres-credentials', 'password'] }]],
    },
  ]);
  buildCronJob(db, {
    namespace: ns,
    name: 'nightly-backup',
    schedule: '0 2 * * *',
    age: 200 * DAY,
    template: backup,
    runs: ['completed', 'completed', 'completed'],
    intervalMs: DAY,
  });
  buildCronJob(db, {
    namespace: ns,
    name: 'metrics-rollup',
    schedule: '*/1 * * * *',
    age: 30 * DAY,
    template: tpl('metrics-rollup', [
      { name: 'rollup', image: 'ghcr.io/acme/metrics-rollup:0.4.2', args: ['--window=1m'] },
    ]),
    runs: ['completed', 'completed'],
    intervalMs: MIN,
  });
  if (!small) {
    buildCronJob(db, {
      namespace: ns,
      name: 'report-generator',
      schedule: '30 6 * * 1-5',
      age: 90 * DAY,
      template: tpl('report-generator', [
        {
          name: 'report',
          image: 'ghcr.io/acme/report-generator:2.1.0',
          cpu: ['500m'],
          mem: ['1Gi'],
        },
      ]),
      runs: p.troubled ? ['completed', 'failed'] : ['completed', 'completed'],
      intervalMs: DAY,
    });
    buildCronJob(db, {
      namespace: ns,
      name: 'vacuum-analyze',
      schedule: '0 4 * * 0',
      age: 150 * DAY,
      suspend: true,
      template: tpl('vacuum-analyze', [
        {
          name: 'vacuum',
          image: 'docker.io/bitnami/postgresql:16.6.0-debian-12-r2',
          command: ['vacuumdb', '--all', '--analyze'],
        },
      ]),
      runs: ['completed'],
      intervalMs: 7 * DAY,
    });
    buildJob(db, {
      namespace: ns,
      name: 'db-migrate-20250912',
      age: 15 * DAY,
      template: tpl('db-migrate', [
        {
          name: 'migrate',
          image: 'ghcr.io/acme/payment-api:2.14.3',
          command: ['./bin/migrate', 'up'],
        },
      ]),
      result: 'completed',
    });
  }
}

export function buildLegacy(db: ClusterDb) {
  if (!['c-kind', 'c-dev'].includes(db.profile.id)) return;
  const template = tpl('legacy-nginx', [
    { name: 'nginx', image: 'docker.io/library/nginx:1.21', ports: [80] },
  ]);
  const rc = put(
    db,
    obj(
      'v1',
      'ReplicationController',
      meta({
        name: 'legacy-nginx',
        namespace: 'default',
        age: 400 * DAY,
        labels: { app: 'legacy-nginx' },
      }),
      {
        spec: { replicas: 2, selector: { app: 'legacy-nginx' }, template },
        status: {
          replicas: 2,
          readyReplicas: 2,
          availableReplicas: 2,
          fullyLabeledReplicas: 2,
          observedGeneration: 1,
        },
      },
    ),
  );
  for (let i = 0; i < 2; i++)
    put(
      db,
      makePod(db, {
        namespace: 'default',
        generateName: 'legacy-nginx-',
        owner: rc,
        template,
        age: 40 * DAY,
      }),
    );
  buildService(db, {
    namespace: 'default',
    name: 'legacy-nginx',
    type: 'NodePort',
    selector: { app: 'legacy-nginx' },
    ports: [{ name: 'http', port: 80, nodePort: 31080 }],
  });
}

const TEAM_SERVICES = ['api', 'worker', 'web', 'consumer', 'scheduler', 'gateway'];

/** Tops the cluster up to its profile pod count with plausible team services. */
export function buildTeams(db: ClusterDb) {
  const p = db.profile;
  if (!p.teams.length) return;
  const remaining = Math.max(0, p.pods - list(db, 'pods').length);
  const slots = p.teams.length * TEAM_SERVICES.length;
  const perDeployment = Math.max(1, Math.round(remaining / slots));
  let failures = p.id === 'c-prod-us' ? 3 : 0;
  for (const team of p.teams) {
    const ns = `team-${team}`;
    for (const svc of TEAM_SERVICES) {
      const name = `${team}-${svc}`;
      const replicas = Math.max(1, perDeployment + between(db.rand, -1, 1));
      const variants: Record<number, PodVariant> = {};
      if (failures > 0 && svc === 'consumer') {
        variants[0] = 'crashloop';
        failures--;
      }
      const port = svc === 'worker' || svc === 'consumer' ? undefined : 8080;
      buildDeployment(db, {
        namespace: ns,
        name,
        age: between(db.rand, 20, 300) * DAY + between(db.rand, 0, 23) * HOUR,
        replicas,
        variants,
        restarts: { 0: pick(db.rand, [0, 0, 0, 1, 2]) },
        oldRevisions: between(db.rand, 1, 6),
        labels: { team },
        template: tpl(
          name,
          [
            {
              name: svc,
              image: `ghcr.io/acme/${name}:${between(db.rand, 1, 4)}.${between(db.rand, 0, 20)}.${between(db.rand, 0, 9)}`,
              ...(port ? { ports: [port] } : {}),
              cpu: [pick(db.rand, ['50m', '100m', '250m']), pick(db.rand, ['500m', '1'])],
              mem: [pick(db.rand, ['128Mi', '256Mi', '512Mi']), pick(db.rand, ['512Mi', '1Gi'])],
              ...(port ? { probe: 'http' as const } : {}),
              env: [
                ['TEAM', team],
                ['LOG_LEVEL', 'info'],
              ],
            },
          ],
          { labels: { team } },
        ),
      });
      if (port)
        buildService(db, {
          namespace: ns,
          name,
          selector: { app: name },
          ports: [{ name: 'http', port: 80, targetPort: port }],
        });
    }
  }
}
