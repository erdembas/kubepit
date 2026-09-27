import type { KubeObject } from '@/types';
import { find, list, put, type ClusterDb } from './db';
import { ago, hexId, MIN, nowIso, obj, SEC } from './util';

/** Normal lifecycle events and the classic warning set, all referencing real objects. */

export interface EventInput {
  target: KubeObject;
  type: 'Normal' | 'Warning';
  reason: string;
  message: string;
  count?: number;
  firstAgo: number;
  lastAgo?: number;
  component?: string;
  host?: string;
  fieldPath?: string;
}

export function makeEvent(db: ClusterDb, e: EventInput): KubeObject {
  const namespace = e.target.metadata.namespace ?? 'default';
  const first = ago(e.firstAgo);
  const last = e.lastAgo === undefined ? first : ago(e.lastAgo);
  return obj(
    'v1',
    'Event',
    {
      name: `${e.target.metadata.name}.${hexId(db.rand, 16)}`,
      namespace,
      uid: '',
      creationTimestamp: first,
    },
    {
      type: e.type,
      reason: e.reason,
      message: e.message,
      count: e.count ?? 1,
      firstTimestamp: first,
      lastTimestamp: last,
      eventTime: null,
      reportingComponent: e.component ?? 'kubelet',
      reportingInstance: e.host ?? '',
      source: { component: e.component ?? 'kubelet', ...(e.host ? { host: e.host } : {}) },
      involvedObject: {
        apiVersion: e.target.apiVersion,
        kind: e.target.kind,
        name: e.target.metadata.name,
        namespace: e.target.metadata.namespace,
        uid: e.target.metadata.uid,
        resourceVersion: e.target.metadata.resourceVersion,
        ...(e.fieldPath ? { fieldPath: e.fieldPath } : {}),
      },
    },
  );
}

export function emitEvent(db: ClusterDb, e: EventInput) {
  return put(db, makeEvent(db, e));
}

/** Bump count + lastTimestamp of the most recent matching event (live updates). */
export function touchEvent(db: ClusterDb, target: KubeObject, reason: string) {
  const ev = list(db, 'events').find(
    (x) =>
      (x.involvedObject as { uid?: string } | undefined)?.uid === target.metadata.uid &&
      x.reason === reason,
  );
  if (!ev) return;
  ev.count = Number(ev.count ?? 1) + 1;
  ev.lastTimestamp = nowIso();
  put(db, ev);
}

function podByName(db: ClusterDb, namespace: string, name: string) {
  return find(db, 'pods', namespace, name);
}

export function buildEvents(db: ClusterDb) {
  const p = db.profile;
  const pods = list(db, 'pods');
  // Normal lifecycle chatter for recently created pods.
  const recent = pods
    .filter((x) => Date.parse(x.metadata.creationTimestamp!) > Date.now() - 55 * MIN)
    .slice(0, 30);
  const scheduled = recent.length ? recent : pods.slice(0, 12);
  for (const pod of scheduled) {
    const age = Math.max(
      60 * SEC,
      Math.min(55 * MIN, Date.now() - Date.parse(pod.metadata.creationTimestamp!)),
    );
    const node = String(pod.spec?.nodeName ?? '');
    const c = (pod.spec?.containers as Array<{ name: string; image: string }> | undefined)?.[0];
    emitEvent(db, {
      target: pod,
      type: 'Normal',
      reason: 'Scheduled',
      message: `Successfully assigned ${pod.metadata.namespace}/${pod.metadata.name} to ${node}`,
      firstAgo: age,
      component: 'default-scheduler',
    });
    if (c) {
      emitEvent(db, {
        target: pod,
        type: 'Normal',
        reason: 'Pulled',
        message: `Container image "${c.image}" already present on machine`,
        firstAgo: age - 4 * SEC,
        host: node,
        fieldPath: `spec.containers{${c.name}}`,
      });
      emitEvent(db, {
        target: pod,
        type: 'Normal',
        reason: 'Created',
        message: `Created container ${c.name}`,
        firstAgo: age - 5 * SEC,
        host: node,
        fieldPath: `spec.containers{${c.name}}`,
      });
      emitEvent(db, {
        target: pod,
        type: 'Normal',
        reason: 'Started',
        message: `Started container ${c.name}`,
        firstAgo: age - 6 * SEC,
        host: node,
        fieldPath: `spec.containers{${c.name}}`,
      });
    }
  }
  for (const dep of list(db, 'deployments.apps').slice(0, 25)) {
    const rs = list(db, 'replicasets.apps').find(
      (r) =>
        r.metadata.ownerReferences?.[0]?.uid === dep.metadata.uid && Number(r.spec?.replicas) > 0,
    );
    if (rs)
      emitEvent(db, {
        target: dep,
        type: 'Normal',
        reason: 'ScalingReplicaSet',
        message: `Scaled up replica set ${rs.metadata.name} from 0 to ${rs.spec?.replicas}`,
        firstAgo: 40 * MIN,
        component: 'deployment-controller',
      });
  }
  for (const cj of list(db, 'cronjobs.batch')) {
    const job = list(db, 'jobs.batch')
      .filter((j) => j.metadata.ownerReferences?.[0]?.uid === cj.metadata.uid)
      .pop();
    if (job) {
      emitEvent(db, {
        target: cj,
        type: 'Normal',
        reason: 'SuccessfulCreate',
        message: `Created job ${job.metadata.name}`,
        firstAgo: 20 * MIN,
        component: 'cronjob-controller',
      });
      emitEvent(db, {
        target: job,
        type: 'Normal',
        reason: 'Completed',
        message: 'Job completed',
        firstAgo: 19 * MIN,
        component: 'job-controller',
      });
    }
  }

  if (!p.troubled) return;
  const crash = podByName(db, 'checkout', 'payment-api-7c9d8b6f5-x2kqp');
  if (crash) {
    const node = String(crash.spec?.nodeName ?? '');
    emitEvent(db, {
      target: crash,
      type: 'Warning',
      reason: 'BackOff',
      message:
        'Back-off restarting failed container payment-api in pod payment-api-7c9d8b6f5-x2kqp_checkout',
      count: 42,
      firstAgo: 3 * 60 * MIN,
      lastAgo: 3 * MIN,
      host: node,
      fieldPath: 'spec.containers{payment-api}',
    });
    emitEvent(db, {
      target: crash,
      type: 'Normal',
      reason: 'Pulled',
      message: 'Container image "ghcr.io/acme/payment-api:2.14.3" already present on machine',
      count: 41,
      firstAgo: 3 * 60 * MIN,
      lastAgo: 8 * MIN,
      host: node,
      fieldPath: 'spec.containers{payment-api}',
    });
  }
  const pending = podByName(db, 'data', 'etl-worker-5d7f9c8b4-mm2lz');
  if (pending) {
    const n = list(db, 'nodes').length;
    emitEvent(db, {
      target: pending,
      type: 'Warning',
      reason: 'FailedScheduling',
      message: `0/${n} nodes are available: ${n} Insufficient memory. preemption: 0/${n} nodes are available: ${n} No preemption victims found for incoming pod.`,
      count: 9,
      firstAgo: 50 * MIN,
      lastAgo: 9 * MIN,
      component: 'default-scheduler',
    });
  }
  const notReady = podByName(db, 'web', 'storefront-6bd9f7c7d8-9sd2k');
  if (notReady)
    emitEvent(db, {
      target: notReady,
      type: 'Warning',
      reason: 'Unhealthy',
      message: 'Readiness probe failed: HTTP probe failed with statuscode: 503',
      count: 17,
      firstAgo: 70 * MIN,
      lastAgo: 12 * MIN,
      host: String(notReady.spec?.nodeName ?? ''),
      fieldPath: 'spec.containers{storefront}',
    });
  const loki = podByName(db, 'monitoring', 'loki-0');
  if (loki)
    emitEvent(db, {
      target: loki,
      type: 'Warning',
      reason: 'FailedMount',
      message:
        'MountVolume.SetUp failed for volume "storage" : rpc error: code = DeadlineExceeded desc = timed out waiting for the condition',
      count: 3,
      firstAgo: 25 * MIN,
      lastAgo: 16 * MIN,
      host: String(loki.spec?.nodeName ?? ''),
    });
  const oom = podByName(db, 'data', 'etl-worker-5d7f9c8b4-v9k2s');
  if (oom)
    emitEvent(db, {
      target: oom,
      type: 'Warning',
      reason: 'OOMKilling',
      message:
        'Memory cgroup out of memory: Killed process 23817 (etl-worker) total-vm:9123456kB, anon-rss:8386412kB',
      count: 7,
      firstAgo: 5 * 60 * MIN,
      lastAgo: 35 * MIN,
      host: String(oom.spec?.nodeName ?? ''),
      component: 'kernel-monitor',
    });
  const pvc = find(db, 'persistentvolumeclaims', 'data', 'scratch-etl');
  if (pvc)
    emitEvent(db, {
      target: pvc,
      type: 'Warning',
      reason: 'ProvisioningFailed',
      message: 'storageclass.storage.k8s.io "fast-ssd" not found',
      count: 214,
      firstAgo: 3 * 24 * 60 * MIN,
      lastAgo: 4 * MIN,
      component: 'persistentvolume-controller',
    });
  const failedJob = list(db, 'jobs.batch').find((j) =>
    (j.status?.conditions as Array<{ type: string }> | undefined)?.some((c) => c.type === 'Failed'),
  );
  if (failedJob)
    emitEvent(db, {
      target: failedJob,
      type: 'Warning',
      reason: 'BackoffLimitExceeded',
      message: 'Job has reached the specified backoff limit',
      firstAgo: 6 * 60 * MIN,
      component: 'job-controller',
    });
  if (p.notReady !== null) {
    const node = list(db, 'nodes')[p.notReady];
    if (node)
      emitEvent(db, {
        target: node,
        type: 'Warning',
        reason: 'NodeNotReady',
        message: `Node ${node.metadata.name} status is now: NodeNotReady`,
        firstAgo: 26 * MIN,
        component: 'node-controller',
      });
  }
  const pressure = list(db, 'nodes')[5];
  if (pressure && p.nodes > 5)
    emitEvent(db, {
      target: pressure,
      type: 'Warning',
      reason: 'EvictionThresholdMet',
      message: 'Attempting to reclaim ephemeral-storage',
      count: 4,
      firstAgo: 90 * MIN,
      lastAgo: 30 * MIN,
      host: pressure.metadata.name,
    });
  if (!p.metrics) {
    const hpa = find(db, 'horizontalpodautoscalers.autoscaling', 'web', 'storefront');
    if (hpa)
      emitEvent(db, {
        target: hpa,
        type: 'Warning',
        reason: 'FailedGetResourceMetric',
        message:
          'failed to get cpu utilization: unable to get metrics for resource cpu: unable to fetch metrics from resource metrics API: the server could not find the requested resource (get pods.metrics.k8s.io)',
        count: 1321,
        firstAgo: 2 * 24 * 60 * MIN,
        lastAgo: 1 * MIN,
        component: 'horizontal-pod-autoscaler',
      });
  }
  const image = list(db, 'pods').find((x) => x.metadata.name.startsWith('feature-x-preview'));
  if (image)
    emitEvent(db, {
      target: image,
      type: 'Warning',
      reason: 'Failed',
      message:
        'Failed to pull image "ghcr.io/acme/storefront:pr-1842": rpc error: code = NotFound desc = failed to resolve reference: not found',
      count: 11,
      firstAgo: 34 * MIN,
      lastAgo: 2 * MIN,
      host: String(image.spec?.nodeName ?? ''),
      fieldPath: 'spec.containers{app}',
    });
  const cert = find(db, 'certificates.cert-manager.io', 'monitoring', 'grafana-tls');
  if (
    cert &&
    (cert.status?.conditions as Array<{ status: string }> | undefined)?.[0]?.status === 'False'
  )
    emitEvent(db, {
      target: cert,
      type: 'Warning',
      reason: 'Failed',
      message:
        'The certificate request has failed to complete and will be retried: Failed to wait for order resource "grafana-tls-3-1702349173" to become ready: order is in "invalid" state',
      count: 2,
      firstAgo: 11 * 60 * MIN,
      lastAgo: 50 * MIN,
      component: 'cert-manager-certificates-issuing',
    });
}

export function warningEvents(db: ClusterDb): KubeObject[] {
  const ts = (e: KubeObject) => Date.parse(String(e.lastTimestamp ?? e.metadata.creationTimestamp));
  return list(db, 'events')
    .filter((e) => e.type === 'Warning')
    .sort((a, b) => ts(b) - ts(a))
    .slice(0, 50);
}
