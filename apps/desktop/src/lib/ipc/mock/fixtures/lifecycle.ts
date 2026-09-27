import type { KubeObject } from '@/types';
import {
  currentReplicaSet,
  eligibleNodes,
  podsOf,
  syncDaemonSet,
  syncJob,
  syncOwner,
  syncReplicaSet,
  syncStatefulSet,
} from './controllers';
import { byUid, drop, list, ownedBy, put, type ClusterDb } from './db';
import { emitEvent } from './events';
import { makePod, podIp, scheduleNode, setPodState, type PodTemplate } from './pods';
import { hexId, nowIso, SEC } from './util';

/** Live object lifecycles for mutations: spawn, terminate, reconcile, roll out. */

const alive = (p: KubeObject) => !p.metadata.deletionTimestamp;
const exists = (db: ClusterDb, o: KubeObject) => !!byUid(db, o.metadata.uid);

export function spawnPod(
  db: ClusterDb,
  owner: KubeObject | null,
  template: PodTemplate,
  opts: { namespace: string; name?: string; node?: string; job?: boolean; onDone?: () => void },
) {
  const pod = makePod(db, {
    namespace: opts.namespace,
    name: opts.name,
    generateName: `${owner?.metadata.name ?? 'pod'}-`,
    owner,
    template,
    age: 0,
    variant: 'creating',
    node: opts.node ?? null,
    extraLabels:
      owner?.kind === 'ReplicaSet'
        ? { 'pod-template-hash': owner.metadata.name.split('-').pop()! }
        : {},
  });
  delete (pod.spec as Record<string, unknown>).nodeName;
  pod.metadata.creationTimestamp = nowIso();
  pod.status = { phase: 'Pending', qosClass: pod.status?.qosClass, conditions: [] };
  put(db, pod);
  if (owner) syncOwner(db, pod);
  const node =
    opts.node ?? scheduleNode(db, template) ?? list(db, 'nodes')[0]?.metadata.name ?? 'node';
  window.setTimeout(() => {
    if (!exists(db, pod)) return;
    setPodState(pod, 'scheduled', node);
    put(db, pod);
    emitEvent(db, {
      target: pod,
      type: 'Normal',
      reason: 'Scheduled',
      message: `Successfully assigned ${pod.metadata.namespace}/${pod.metadata.name} to ${node}`,
      firstAgo: 0,
      component: 'default-scheduler',
    });
  }, 700);
  window.setTimeout(() => {
    if (!exists(db, pod)) return;
    setPodState(pod, 'running', node, podIp(db));
    put(db, pod);
    const c = (pod.spec?.containers as Array<{ name: string; image: string }> | undefined)?.[0];
    if (c) {
      emitEvent(db, {
        target: pod,
        type: 'Normal',
        reason: 'Pulled',
        message: `Container image "${c.image}" already present on machine`,
        firstAgo: 0,
        host: node,
      });
      emitEvent(db, {
        target: pod,
        type: 'Normal',
        reason: 'Started',
        message: `Started container ${c.name}`,
        firstAgo: 0,
        host: node,
      });
    }
    if (owner) syncOwner(db, pod);
  }, 2600);
  if (opts.job) {
    window.setTimeout(() => {
      if (!exists(db, pod)) return;
      setPodState(pod, 'succeeded');
      put(db, pod);
      if (owner) syncOwner(db, pod);
      opts.onDone?.();
    }, 7000);
  }
  return pod;
}

export function terminatePod(db: ClusterDb, pod: KubeObject, after?: () => void) {
  if (pod.metadata.deletionTimestamp) return;
  pod.metadata.deletionTimestamp = new Date(Date.now() + 30 * SEC).toISOString();
  put(db, pod);
  syncOwner(db, pod);
  emitEvent(db, {
    target: pod,
    type: 'Normal',
    reason: 'Killing',
    message: `Stopping container ${(pod.spec?.containers as Array<{ name: string }> | undefined)?.[0]?.name ?? ''}`,
    firstAgo: 0,
    host: String(pod.spec?.nodeName ?? ''),
  });
  window.setTimeout(() => {
    drop(db, pod);
    syncOwner(db, pod);
    after?.();
  }, 1600);
}

export function reconcile(db: ClusterDb, owner: KubeObject) {
  if (!exists(db, owner)) return;
  const ns = owner.metadata.namespace!;
  if (owner.kind === 'Deployment') {
    const rs = currentReplicaSet(db, owner);
    if (!rs) return;
    rs.spec.replicas = Number(owner.spec?.replicas ?? 1);
    put(db, rs);
    reconcile(db, rs);
    return;
  }
  if (owner.kind === 'ReplicaSet' || owner.kind === 'ReplicationController') {
    const desired = Number(owner.spec?.replicas ?? 0);
    const pods = podsOf(db, owner).filter(alive);
    for (let i = pods.length; i < desired; i++)
      spawnPod(db, owner, owner.spec.template, { namespace: ns });
    pods
      .sort(
        (a, b) =>
          Date.parse(b.metadata.creationTimestamp!) - Date.parse(a.metadata.creationTimestamp!),
      )
      .slice(0, Math.max(0, pods.length - desired))
      .forEach((p) => terminatePod(db, p));
    if (owner.kind === 'ReplicaSet') syncReplicaSet(db, owner);
    return;
  }
  if (owner.kind === 'StatefulSet') {
    const desired = Number(owner.spec?.replicas ?? 1);
    const pods = podsOf(db, owner).filter(alive);
    const names = new Set(pods.map((p) => p.metadata.name));
    for (let i = 0; i < desired; i++) {
      const name = `${owner.metadata.name}-${i}`;
      if (!names.has(name)) spawnPod(db, owner, owner.spec.template, { namespace: ns, name });
    }
    for (const p of pods) {
      if (Number(p.metadata.name.split('-').pop()) >= desired) terminatePod(db, p);
    }
    syncStatefulSet(db, owner);
    return;
  }
  if (owner.kind === 'DaemonSet') {
    const pods = podsOf(db, owner).filter(alive);
    for (const node of eligibleNodes(db, owner)) {
      if (!pods.some((p) => p.spec?.nodeName === node.metadata.name))
        spawnPod(db, owner, owner.spec.template, { namespace: ns, node: node.metadata.name });
    }
    syncDaemonSet(db, owner);
  }
}

export function ownerOf(db: ClusterDb, o: KubeObject) {
  const ref =
    o.metadata.ownerReferences?.find((r) => r.controller) ?? o.metadata.ownerReferences?.[0];
  return ref ? byUid(db, ref.uid) : undefined;
}

export function rolloutRestart(db: ClusterDb, o: KubeObject) {
  const at = nowIso();
  const template = structuredClone(o.spec.template) as PodTemplate;
  template.metadata.annotations = {
    ...template.metadata.annotations,
    'kubectl.kubernetes.io/restartedAt': at,
  };
  o.spec.template = template;
  o.metadata.generation = (o.metadata.generation ?? 1) + 1;
  if (o.kind === 'Deployment') {
    const old = currentReplicaSet(db, o);
    const revision = Number(o.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 1) + 1;
    o.metadata.annotations = {
      ...o.metadata.annotations,
      'deployment.kubernetes.io/revision': String(revision),
    };
    put(db, o);
    const hash = hexId(db.rand, 10);
    const rsTemplate = structuredClone(template);
    rsTemplate.metadata.labels = { ...rsTemplate.metadata.labels, 'pod-template-hash': hash };
    const rs = put(db, {
      apiVersion: 'apps/v1',
      kind: 'ReplicaSet',
      metadata: {
        name: `${o.metadata.name}-${hash}`,
        namespace: o.metadata.namespace,
        uid: '',
        creationTimestamp: at,
        labels: rsTemplate.metadata.labels,
        annotations: {
          'deployment.kubernetes.io/revision': String(revision),
          'deployment.kubernetes.io/desired-replicas': String(o.spec.replicas ?? 1),
        },
        ownerReferences: [
          {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            name: o.metadata.name,
            uid: o.metadata.uid,
            controller: true,
          },
        ],
      },
      spec: {
        replicas: Number(o.spec.replicas ?? 1),
        selector: { matchLabels: { ...o.spec.selector?.matchLabels, 'pod-template-hash': hash } },
        template: rsTemplate,
      },
      status: {},
    });
    emitEvent(db, {
      target: o,
      type: 'Normal',
      reason: 'ScalingReplicaSet',
      message: `Scaled up replica set ${rs.metadata.name} from 0 to ${rs.spec.replicas}`,
      firstAgo: 0,
      component: 'deployment-controller',
    });
    reconcile(db, rs);
    window.setTimeout(() => {
      if (!old || !exists(db, old)) return;
      old.spec.replicas = 0;
      put(db, old);
      reconcile(db, old);
      emitEvent(db, {
        target: o,
        type: 'Normal',
        reason: 'ScalingReplicaSet',
        message: `Scaled down replica set ${old.metadata.name} from ${old.status?.replicas ?? 0} to 0`,
        firstAgo: 0,
        component: 'deployment-controller',
      });
    }, 3200);
    return;
  }
  put(db, o);
  const pods = podsOf(db, o).filter(alive);
  pods.forEach((pod, i) => {
    window.setTimeout(() => {
      if (!exists(db, pod)) return;
      terminatePod(db, pod, () => {
        if (!exists(db, o)) return;
        if (o.kind === 'StatefulSet')
          spawnPod(db, o, o.spec.template, {
            namespace: o.metadata.namespace!,
            name: pod.metadata.name,
          });
        else
          spawnPod(db, o, o.spec.template, {
            namespace: o.metadata.namespace!,
            node: String(pod.spec?.nodeName ?? '') || undefined,
          });
      });
    }, i * 3500);
  });
}

export function runJob(db: ClusterDb, cronJob: KubeObject, name: string) {
  const template = structuredClone(cronJob.spec.jobTemplate.spec.template) as PodTemplate;
  const uid = hexId(db.rand, 8);
  template.metadata = {
    ...template.metadata,
    labels: {
      ...template.metadata?.labels,
      'batch.kubernetes.io/job-name': name,
      'batch.kubernetes.io/controller-uid': uid,
    },
  };
  template.spec = { ...template.spec, restartPolicy: 'Never' };
  const job = put(db, {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name,
      namespace: cronJob.metadata.namespace,
      uid: '',
      creationTimestamp: nowIso(),
      labels: template.metadata.labels,
      ownerReferences: [
        {
          apiVersion: 'batch/v1',
          kind: 'CronJob',
          name: cronJob.metadata.name,
          uid: cronJob.metadata.uid,
          controller: true,
        },
      ],
    },
    spec: {
      completions: 1,
      parallelism: 1,
      backoffLimit: 2,
      selector: { matchLabels: { 'batch.kubernetes.io/controller-uid': uid } },
      template,
    },
    status: { startTime: nowIso(), active: 1 },
  });
  cronJob.status = {
    ...cronJob.status,
    active: [
      {
        apiVersion: 'batch/v1',
        kind: 'Job',
        name,
        namespace: job.metadata.namespace,
        uid: job.metadata.uid,
      },
    ],
    lastScheduleTime: nowIso(),
  };
  put(db, cronJob);
  emitEvent(db, {
    target: cronJob,
    type: 'Normal',
    reason: 'SuccessfulCreate',
    message: `Created job ${name}`,
    firstAgo: 0,
    component: 'cronjob-controller',
  });
  spawnPod(db, job, template, {
    namespace: job.metadata.namespace!,
    job: true,
    onDone: () => {
      syncJob(db, job);
      if (!exists(db, cronJob)) return;
      cronJob.status = { ...cronJob.status, active: undefined, lastSuccessfulTime: nowIso() };
      put(db, cronJob);
      emitEvent(db, {
        target: cronJob,
        type: 'Normal',
        reason: 'SawCompletedJob',
        message: `Saw completed job: ${name}, condition: Complete`,
        firstAgo: 0,
        component: 'cronjob-controller',
      });
      pruneJobs(db, cronJob);
    },
  });
  return job;
}

function pruneJobs(db: ClusterDb, cronJob: KubeObject) {
  const limit = Number(cronJob.spec?.successfulJobsHistoryLimit ?? 3);
  const jobs = ownedBy(db, 'jobs.batch', cronJob)
    .filter((j) =>
      (j.status?.conditions as Array<{ type: string }> | undefined)?.some(
        (c) => c.type === 'Complete',
      ),
    )
    .sort(
      (a, b) =>
        Date.parse(b.metadata.creationTimestamp!) - Date.parse(a.metadata.creationTimestamp!),
    );
  for (const job of jobs.slice(limit)) deleteCascade(db, job);
}

/** Background propagation: drop the object and everything it owns. */
export function deleteCascade(db: ClusterDb, o: KubeObject) {
  for (const key of ['replicasets.apps', 'jobs.batch', 'pods', 'endpointslices.discovery.k8s.io']) {
    for (const child of ownedBy(db, key, o)) {
      if (key === 'pods') terminatePod(db, child);
      else deleteCascade(db, child);
    }
  }
  drop(db, o);
}
