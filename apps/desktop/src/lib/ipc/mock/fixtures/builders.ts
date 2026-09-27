import type { KubeObject } from '@/types';
import { put, type ClusterDb } from './db';
import { makePod, type PodTemplate, type PodVariant } from './pods';
import { cond, syncReplicaSet, syncStatefulSet, syncDaemonSet, eligibleNodes } from './controllers';
import { ago, DAY, hexId, meta, MIN, obj } from './util';

/** Workload builders: Deployment → ReplicaSet → Pod, StatefulSets, DaemonSets, CronJobs, Jobs. */

export interface WorkloadInput {
  namespace: string;
  name: string;
  age: number;
  replicas?: number;
  template: PodTemplate;
  labels?: Record<string, string>;
  rsHash?: string;
  podNames?: string[];
  variants?: Record<number, PodVariant>;
  restarts?: Record<number, number>;
  oldRevisions?: number;
  annotations?: Record<string, string>;
}

function workloadMeta(input: WorkloadInput, extra: Record<string, string> = {}) {
  return meta({
    name: input.name,
    namespace: input.namespace,
    age: input.age,
    labels: { 'app.kubernetes.io/name': input.name, ...input.labels },
    annotations: { ...extra, ...input.annotations },
  });
}

export function buildDeployment(db: ClusterDb, input: WorkloadInput) {
  const replicas = input.replicas ?? 1;
  const revision = (input.oldRevisions ?? 1) + 1;
  const dep = obj(
    'apps/v1',
    'Deployment',
    workloadMeta(input, { 'deployment.kubernetes.io/revision': String(revision) }),
    {
      spec: {
        replicas,
        selector: { matchLabels: { app: input.name } },
        template: input.template,
        strategy: {
          type: 'RollingUpdate',
          rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' },
        },
        revisionHistoryLimit: 10,
        progressDeadlineSeconds: 600,
      },
      status: {},
    },
  );
  dep.metadata.generation = revision;
  put(db, dep);
  for (let r = 1; r < revision; r++) {
    const old = replicaSet(dep, input, hexId(db.rand, 10), r, 0, input.age - r * DAY * 0.2);
    put(db, old);
    syncReplicaSet(db, old);
  }
  const hash = input.rsHash ?? hexId(db.rand, 10);
  const rs = replicaSet(dep, input, hash, revision, replicas, Math.min(input.age, 6 * DAY));
  put(db, rs);
  for (let i = 0; i < replicas; i++) {
    const name = input.podNames?.[i] ? `${rs.metadata.name}-${input.podNames[i]}` : undefined;
    put(
      db,
      makePod(db, {
        namespace: input.namespace,
        name,
        generateName: `${rs.metadata.name}-`,
        owner: rs,
        template: rs.spec.template,
        age: Math.min(input.age, 6 * DAY) - i * 7 * MIN,
        variant: input.variants?.[i],
        restarts: input.restarts?.[i],
      }),
    );
  }
  syncReplicaSet(db, rs);
  return dep;
}

function replicaSet(
  dep: KubeObject,
  input: WorkloadInput,
  hash: string,
  revision: number,
  replicas: number,
  age: number,
) {
  const template: PodTemplate = structuredClone(input.template);
  template.metadata.labels = { ...template.metadata.labels, 'pod-template-hash': hash };
  const rs = obj(
    'apps/v1',
    'ReplicaSet',
    meta({
      name: `${input.name}-${hash}`,
      namespace: input.namespace,
      age,
      labels: { ...template.metadata.labels },
      annotations: {
        'deployment.kubernetes.io/revision': String(revision),
        'deployment.kubernetes.io/desired-replicas': String(input.replicas ?? 1),
        'deployment.kubernetes.io/max-replicas': String(Math.ceil((input.replicas ?? 1) * 1.25)),
      },
      owner: dep,
    }),
    {
      spec: {
        replicas,
        selector: { matchLabels: { app: input.name, 'pod-template-hash': hash } },
        template,
      },
      status: {},
    },
  );
  rs.metadata.generation = 1;
  return rs;
}

export function buildStatefulSet(
  db: ClusterDb,
  input: WorkloadInput & { serviceName: string; storage?: string; storageClass?: string },
) {
  const replicas = input.replicas ?? 1;
  const sts = obj('apps/v1', 'StatefulSet', workloadMeta(input), {
    spec: {
      replicas,
      serviceName: input.serviceName,
      selector: { matchLabels: { app: input.name } },
      template: input.template,
      podManagementPolicy: 'OrderedReady',
      updateStrategy: { type: 'RollingUpdate', rollingUpdate: { partition: 0 } },
      revisionHistoryLimit: 10,
      persistentVolumeClaimRetentionPolicy: { whenDeleted: 'Retain', whenScaled: 'Retain' },
      ...(input.storage
        ? {
            volumeClaimTemplates: [
              {
                apiVersion: 'v1',
                kind: 'PersistentVolumeClaim',
                metadata: { name: 'data' },
                spec: {
                  accessModes: ['ReadWriteOnce'],
                  storageClassName: input.storageClass,
                  resources: { requests: { storage: input.storage } },
                  volumeMode: 'Filesystem',
                },
              },
            ],
          }
        : {}),
    },
    status: {},
  });
  sts.metadata.generation = 1;
  put(db, sts);
  for (let i = 0; i < replicas; i++) {
    put(
      db,
      makePod(db, {
        namespace: input.namespace,
        name: `${input.name}-${i}`,
        owner: sts,
        template: input.template,
        age: input.age - i * 3 * MIN,
        variant: input.variants?.[i],
        restarts: input.restarts?.[i],
        extraLabels: {
          'apps.kubernetes.io/pod-index': String(i),
          'statefulset.kubernetes.io/pod-name': `${input.name}-${i}`,
          'controller-revision-hash': `${input.name}-${hexId(db.rand, 10)}`,
        },
      }),
    );
  }
  syncStatefulSet(db, sts);
  return sts;
}

export function buildDaemonSet(db: ClusterDb, input: WorkloadInput) {
  input.template.spec.tolerations = [{ operator: 'Exists' }];
  const ds = obj(
    'apps/v1',
    'DaemonSet',
    workloadMeta(input, { 'deprecated.daemonset.template.generation': '1' }),
    {
      spec: {
        selector: { matchLabels: { app: input.name } },
        template: input.template,
        updateStrategy: {
          type: 'RollingUpdate',
          rollingUpdate: { maxUnavailable: 1, maxSurge: 0 },
        },
        revisionHistoryLimit: 10,
      },
      status: {},
    },
  );
  ds.metadata.generation = 1;
  put(db, ds);
  eligibleNodes(db, ds).forEach((node, i) => {
    put(
      db,
      makePod(db, {
        namespace: input.namespace,
        generateName: `${input.name}-`,
        owner: ds,
        template: input.template,
        age:
          Math.min(input.age, Date.now() - Date.parse(node.metadata.creationTimestamp ?? ago(0))) -
          2 * MIN,
        node: node.metadata.name,
        variant: input.variants?.[i],
        extraLabels: {
          'controller-revision-hash': hexId(db.rand, 10),
          'pod-template-generation': '1',
        },
      }),
    );
  });
  syncDaemonSet(db, ds);
  return ds;
}

export interface CronInput {
  namespace: string;
  name: string;
  schedule: string;
  age: number;
  template: PodTemplate;
  runs: Array<'completed' | 'failed'>;
  suspend?: boolean;
  intervalMs: number;
}

export function buildCronJob(db: ClusterDb, input: CronInput) {
  const cj = obj(
    'batch/v1',
    'CronJob',
    meta({
      name: input.name,
      namespace: input.namespace,
      age: input.age,
      labels: { app: input.name },
    }),
    {
      spec: {
        schedule: input.schedule,
        timeZone: 'Etc/UTC',
        concurrencyPolicy: 'Forbid',
        suspend: input.suspend ?? false,
        successfulJobsHistoryLimit: 3,
        failedJobsHistoryLimit: 1,
        startingDeadlineSeconds: 200,
        jobTemplate: {
          spec: { backoffLimit: 2, ttlSecondsAfterFinished: 86400, template: input.template },
        },
      },
      status: {},
    },
  );
  put(db, cj);
  let last = '';
  input.runs.forEach((result, i) => {
    const age = (input.runs.length - i) * input.intervalMs - 2 * MIN;
    const job = buildJob(db, {
      namespace: input.namespace,
      name: `${input.name}-${Math.floor((Date.now() - age) / MIN)}`,
      age,
      template: input.template,
      owner: cj,
      result,
    });
    last = job.metadata.creationTimestamp ?? last;
  });
  cj.status = { lastScheduleTime: last || undefined, lastSuccessfulTime: last || undefined };
  put(db, cj);
  return cj;
}

export function buildJob(
  db: ClusterDb,
  input: {
    namespace: string;
    name: string;
    age: number;
    template: PodTemplate;
    owner?: KubeObject;
    result: 'completed' | 'failed' | 'running';
  },
) {
  const uidLabel = hexId(db.rand, 8);
  const template: PodTemplate = structuredClone(input.template);
  template.metadata.labels = {
    ...template.metadata.labels,
    'batch.kubernetes.io/job-name': input.name,
    'batch.kubernetes.io/controller-uid': uidLabel,
  };
  template.spec.restartPolicy = 'Never';
  const job = obj(
    'batch/v1',
    'Job',
    meta({
      name: input.name,
      namespace: input.namespace,
      age: input.age,
      labels: { ...template.metadata.labels },
      owner: input.owner,
    }),
    {
      spec: {
        completions: 1,
        parallelism: 1,
        backoffLimit: 2,
        completionMode: 'NonIndexed',
        suspend: false,
        selector: { matchLabels: { 'batch.kubernetes.io/controller-uid': uidLabel } },
        template,
      },
      status: {},
    },
  );
  put(db, job);
  const start = ago(input.age - 5000);
  if (input.result !== 'running') {
    put(
      db,
      makePod(db, {
        namespace: input.namespace,
        generateName: `${input.name}-`,
        owner: job,
        template,
        age: input.age - 3000,
        variant: input.result,
      }),
    );
  }
  const done = ago(input.age - 64_000);
  job.status =
    input.result === 'completed'
      ? {
          startTime: start,
          completionTime: done,
          succeeded: 1,
          ready: 0,
          terminating: 0,
          conditions: [
            cond(
              'SuccessCriteriaMet',
              true,
              'CompletionsReached',
              'Reached expected number of succeeded pods',
              done,
            ),
            cond(
              'Complete',
              true,
              'CompletionsReached',
              'Reached expected number of succeeded pods',
              done,
            ),
          ],
        }
      : input.result === 'failed'
        ? {
            startTime: start,
            failed: 1,
            ready: 0,
            terminating: 0,
            conditions: [
              cond(
                'FailureTarget',
                true,
                'BackoffLimitExceeded',
                'Job has reached the specified backoff limit',
                done,
              ),
              cond(
                'Failed',
                true,
                'BackoffLimitExceeded',
                'Job has reached the specified backoff limit',
                done,
              ),
            ],
          }
        : { startTime: start, active: 1, ready: 0 };
  put(db, job);
  return job;
}
