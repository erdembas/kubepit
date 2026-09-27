import type { KubeObject } from '@/types';
import { byUid, list, ownedBy, put, type ClusterDb } from './db';
import { hexId, nowIso } from './util';

/** Workload controller status sync (ReplicaSet, Deployment, StatefulSet, DaemonSet, Job). */

/** Workload controller builders (Deployment → ReplicaSet → Pod, …) and status sync. */

const alive = (p: KubeObject) => !p.metadata.deletionTimestamp;
const isReady = (p: KubeObject) =>
  (p.status?.conditions as Array<{ type: string; status: string }> | undefined)?.some(
    (c) => c.type === 'Ready' && c.status === 'True',
  ) ?? false;

export function cond(type: string, status: boolean, reason: string, message: string, at: string) {
  return {
    type,
    status: status ? 'True' : 'False',
    reason,
    message,
    lastUpdateTime: at,
    lastTransitionTime: at,
  };
}

export function podsOf(db: ClusterDb, owner: KubeObject) {
  return ownedBy(db, 'pods', owner);
}

// -- Status sync --------------------------------------------------------------

export function syncReplicaSet(db: ClusterDb, rs: KubeObject) {
  const pods = podsOf(db, rs).filter(alive);
  const ready = pods.filter(isReady).length;
  rs.status = {
    replicas: pods.length,
    fullyLabeledReplicas: pods.length,
    readyReplicas: ready,
    availableReplicas: ready,
    observedGeneration: rs.metadata.generation ?? 1,
  };
  put(db, rs);
  const ownerUid = rs.metadata.ownerReferences?.[0]?.uid;
  const dep = ownerUid ? byUid(db, ownerUid) : undefined;
  if (dep?.kind === 'Deployment') syncDeployment(db, dep);
}

export function currentReplicaSet(db: ClusterDb, dep: KubeObject) {
  const revision = (o: KubeObject) =>
    Number(o.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0);
  return ownedBy(db, 'replicasets.apps', dep).sort((a, b) => revision(b) - revision(a))[0];
}

export function syncDeployment(db: ClusterDb, dep: KubeObject) {
  const sets = ownedBy(db, 'replicasets.apps', dep);
  const current = currentReplicaSet(db, dep);
  let replicas = 0;
  let ready = 0;
  for (const rs of sets) {
    replicas += Number(rs.status?.replicas ?? 0);
    ready += Number(rs.status?.readyReplicas ?? 0);
  }
  const desired = Number(dep.spec?.replicas ?? 1);
  const updated = current ? Number(current.status?.replicas ?? 0) : 0;
  const at =
    (dep.status?.conditions as Array<{ lastTransitionTime: string }> | undefined)?.[0]
      ?.lastTransitionTime ??
    new Date(
      Math.min(Date.now(), Date.parse(dep.metadata.creationTimestamp ?? '') + 90_000 || Date.now()),
    ).toISOString();
  const available = ready >= Math.max(1, desired - Math.floor(desired / 4)) || desired === 0;
  dep.status = {
    observedGeneration: dep.metadata.generation ?? 1,
    replicas,
    updatedReplicas: updated,
    readyReplicas: ready,
    availableReplicas: ready,
    ...(replicas - ready > 0 ? { unavailableReplicas: replicas - ready } : {}),
    conditions: [
      cond(
        'Available',
        available,
        available ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable',
        available
          ? 'Deployment has minimum availability.'
          : 'Deployment does not have minimum availability.',
        at,
      ),
      cond(
        'Progressing',
        true,
        'NewReplicaSetAvailable',
        `ReplicaSet "${current?.metadata.name ?? dep.metadata.name}" has successfully progressed.`,
        at,
      ),
    ],
  };
  put(db, dep);
}

export function syncStatefulSet(db: ClusterDb, sts: KubeObject) {
  const pods = podsOf(db, sts).filter(alive);
  const ready = pods.filter(isReady).length;
  // Keep the revision the rollout recorded (see rollouts.ts) once there is one.
  const recorded = sts.status?.updateRevision as string | undefined;
  sts.status = {
    observedGeneration: sts.metadata.generation ?? 1,
    replicas: pods.length,
    readyReplicas: ready,
    currentReplicas: pods.length,
    updatedReplicas: pods.length,
    availableReplicas: ready,
    currentRevision: `${sts.metadata.name}-${hexId(db.rand, 10)}`,
    updateRevision: `${sts.metadata.name}-${hexId(db.rand, 10)}`,
    ...(recorded ? { currentRevision: recorded, updateRevision: recorded } : {}),
    collisionCount: 0,
  };
  put(db, sts);
}

export function syncDaemonSet(db: ClusterDb, ds: KubeObject) {
  const pods = podsOf(db, ds).filter(alive);
  const ready = pods.filter(isReady).length;
  const desired = eligibleNodes(db, ds).length;
  ds.status = {
    currentNumberScheduled: pods.length,
    desiredNumberScheduled: desired,
    numberAvailable: ready,
    numberMisscheduled: 0,
    numberReady: ready,
    ...(desired - ready > 0 ? { numberUnavailable: desired - ready } : {}),
    observedGeneration: ds.metadata.generation ?? 1,
    updatedNumberScheduled: pods.length,
  };
  put(db, ds);
}

export function syncJob(db: ClusterDb, job: KubeObject) {
  const pods = podsOf(db, job);
  const succeeded = pods.filter((p) => p.status?.phase === 'Succeeded').length;
  const failed = pods.filter((p) => p.status?.phase === 'Failed').length;
  const active = pods.filter(
    (p) => alive(p) && !['Succeeded', 'Failed'].includes(String(p.status?.phase)),
  ).length;
  const completions = Number(job.spec?.completions ?? 1);
  const st: Record<string, unknown> = {
    ...(job.status ?? {}),
    active: active || undefined,
    succeeded: succeeded || undefined,
    failed: failed || undefined,
  };
  if (!st.startTime) st.startTime = nowIso();
  if (succeeded >= completions && !st.completionTime) {
    st.completionTime = nowIso();
    st.conditions = [cond('Complete', true, '', '', nowIso())];
  }
  job.status = st;
  put(db, job);
}

export function syncOwner(db: ClusterDb, pod: KubeObject) {
  const ref = pod.metadata.ownerReferences?.[0];
  const owner = ref ? byUid(db, ref.uid) : undefined;
  if (!owner) return;
  if (owner.kind === 'ReplicaSet') syncReplicaSet(db, owner);
  else if (owner.kind === 'StatefulSet') syncStatefulSet(db, owner);
  else if (owner.kind === 'DaemonSet') syncDaemonSet(db, owner);
  else if (owner.kind === 'Job') syncJob(db, owner);
}

export function eligibleNodes(db: ClusterDb, ds: KubeObject) {
  const selector =
    (ds.spec?.template?.spec?.nodeSelector as Record<string, string> | undefined) ?? {};
  return list(db, 'nodes').filter((n) =>
    Object.entries(selector).every(([k, v]) => n.metadata.labels?.[k] === v),
  );
}

// -- Builders -----------------------------------------------------------------
