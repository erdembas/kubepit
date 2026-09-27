import type { KubeObject } from '@/types';
import { list, type ClusterDb } from './db';
import { ago, iso, meta, obj, suffix } from './util';

/** Pod builders, scheduling and lifecycle state for the demo fixtures. */

export type PodVariant =
  | 'ok'
  | 'crashloop'
  | 'notready'
  | 'pending'
  | 'creating'
  | 'imagepull'
  | 'initwait'
  | 'oom'
  | 'terminating'
  | 'completed'
  | 'failed';

export interface PodTemplate {
  metadata: { labels: Record<string, string>; annotations?: Record<string, string> };
  spec: Record<string, unknown>;
}

function schedulable(db: ClusterDb, template: PodTemplate) {
  const tolerations =
    (template.spec.tolerations as Array<{ key?: string; operator?: string }> | undefined) ?? [];
  const tolerateAll = tolerations.some((t) => t.operator === 'Exists' && !t.key);
  const selector = (template.spec.nodeSelector as Record<string, string> | undefined) ?? {};
  return list(db, 'nodes').filter((n) => {
    const labels = n.metadata.labels ?? {};
    if (Object.entries(selector).some(([k, v]) => labels[k] !== v)) return false;
    if (tolerateAll) return true;
    if (n.spec?.unschedulable) return false;
    const ready = (
      n.status?.conditions as Array<{ type: string; status: string }> | undefined
    )?.some((c) => c.type === 'Ready' && c.status === 'True');
    if (!ready) return false;
    const taints = (n.spec?.taints as Array<{ key: string; effect: string }> | undefined) ?? [];
    return taints.every(
      (t) => t.effect === 'PreferNoSchedule' || tolerations.some((x) => x.key === t.key),
    );
  });
}

export function scheduleNode(db: ClusterDb, template: PodTemplate): string | null {
  const nodes = schedulable(db, template);
  if (!nodes.length) return null;
  db.nodeCursor = (db.nodeCursor + 1) % 100_000;
  return nodes[db.nodeCursor % nodes.length]!.metadata.name;
}

export function podIp(db: ClusterDb) {
  db.ipSeq++;
  return `10.${db.profile.ipBase + 100}.${Math.floor(db.ipSeq / 250) % 250}.${(db.ipSeq % 250) + 2}`;
}

function qosClass(spec: Record<string, unknown>) {
  const containers =
    (spec.containers as Array<{
      resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
    }>) ?? [];
  if (containers.every((c) => !c.resources?.requests && !c.resources?.limits)) return 'BestEffort';
  const guaranteed = containers.every(
    (c) =>
      c.resources?.limits?.cpu &&
      c.resources.limits.memory &&
      (c.resources.requests?.cpu ?? c.resources.limits.cpu) === c.resources.limits.cpu &&
      (c.resources.requests?.memory ?? c.resources.limits.memory) === c.resources.limits.memory,
  );
  return guaranteed ? 'Guaranteed' : 'Burstable';
}

export interface PodInput {
  namespace: string;
  name?: string;
  generateName?: string;
  owner: KubeObject | null;
  template: PodTemplate;
  age: number;
  variant?: PodVariant;
  node?: string | null;
  restarts?: number;
  extraLabels?: Record<string, string>;
}

const cid = (db: ClusterDb) => `containerd://${suffix(db.rand, 12)}${suffix(db.rand, 12)}`;

export function makePod(db: ClusterDb, input: PodInput): KubeObject {
  const variant = input.variant ?? 'ok';
  const name = input.name ?? `${input.generateName}${suffix(db.rand)}`;
  const spec = structuredClone(input.template.spec) as Record<string, unknown>;
  const pending = variant === 'pending';
  const nodeName = pending ? null : (input.node ?? scheduleNode(db, input.template));
  if (nodeName) spec.nodeName = nodeName;
  const created = Date.parse(ago(input.age));
  const started = iso(created + 12_000);
  const containers = (spec.containers as Array<{ name: string; image: string }>) ?? [];
  const inits = (spec.initContainers as Array<{ name: string; image: string }>) ?? [];
  const terminal = variant === 'completed' || variant === 'failed';

  const statusFor = (c: { name: string; image: string }, index: number) => {
    const base = {
      name: c.name,
      image: c.image,
      imageID: `${c.image.split(':')[0]}@sha256:${suffix(db.rand, 16)}`,
    };
    const restarts = index === 0 ? (input.restarts ?? 0) : 0;
    const first = index === 0;
    if (variant === 'creating' || (variant === 'initwait' && true)) {
      return {
        ...base,
        ready: false,
        started: false,
        restartCount: 0,
        state: {
          waiting: { reason: variant === 'initwait' ? 'PodInitializing' : 'ContainerCreating' },
        },
      };
    }
    if (variant === 'imagepull' && first)
      return {
        ...base,
        ready: false,
        started: false,
        restartCount: 0,
        state: {
          waiting: { reason: 'ImagePullBackOff', message: `Back-off pulling image "${c.image}"` },
        },
      };
    if (variant === 'crashloop' && first)
      return {
        ...base,
        containerID: cid(db),
        ready: false,
        started: false,
        restartCount: restarts || 42,
        state: {
          waiting: {
            reason: 'CrashLoopBackOff',
            message: `back-off 5m0s restarting failed container=${c.name} pod=${name}`,
          },
        },
        lastState: {
          terminated: {
            reason: 'Error',
            exitCode: 1,
            startedAt: ago(8 * 60_000),
            finishedAt: ago(7 * 60_000),
            containerID: cid(db),
          },
        },
      };
    if (terminal)
      return {
        ...base,
        containerID: cid(db),
        ready: false,
        started: false,
        restartCount: 0,
        state: {
          terminated: {
            reason: variant === 'completed' ? 'Completed' : 'Error',
            exitCode: variant === 'completed' ? 0 : 2,
            startedAt: started,
            finishedAt: iso(created + 60_000 + index * 1000),
            containerID: cid(db),
          },
        },
      };
    const status: Record<string, unknown> = {
      ...base,
      containerID: cid(db),
      ready: !(variant === 'notready' && first),
      started: true,
      restartCount: variant === 'oom' && first ? restarts || 7 : restarts,
      state: { running: { startedAt: started } },
    };
    if (variant === 'oom' && first)
      status.lastState = {
        terminated: {
          reason: 'OOMKilled',
          exitCode: 137,
          startedAt: ago(90 * 60_000),
          finishedAt: ago(35 * 60_000),
          containerID: cid(db),
        },
      };
    return status;
  };

  const ready = ['ok', 'oom', 'terminating'].includes(variant);
  const cond = (type: string, value: boolean, extra: Record<string, unknown> = {}) => ({
    type,
    status: value ? 'True' : 'False',
    lastProbeTime: null,
    lastTransitionTime: iso(created + (value ? 15_000 : 2_000)),
    ...extra,
  });
  const conditions = pending
    ? [
        cond('PodScheduled', false, {
          reason: 'Unschedulable',
          message: `0/${list(db, 'nodes').length} nodes are available: ${list(db, 'nodes').length} Insufficient memory. preemption: 0/${list(db, 'nodes').length} nodes are available: ${list(db, 'nodes').length} No preemption victims found for incoming pod.`,
        }),
      ]
    : [
        cond('PodReadyToStartContainers', variant !== 'creating'),
        cond(
          'Initialized',
          variant !== 'initwait',
          variant === 'initwait'
            ? {
                reason: 'ContainersNotInitialized',
                message: `containers with incomplete status: [${inits[0]?.name ?? 'init'}]`,
              }
            : {},
        ),
        cond(
          'Ready',
          ready,
          ready
            ? {}
            : {
                reason: terminal ? 'PodCompleted' : 'ContainersNotReady',
                message: terminal
                  ? undefined
                  : `containers with unready status: [${containers[0]?.name}]`,
              },
        ),
        cond(
          'ContainersReady',
          ready,
          ready ? {} : { reason: terminal ? 'PodCompleted' : 'ContainersNotReady' },
        ),
        cond('PodScheduled', true),
      ];

  const phase =
    pending || variant === 'creating' || variant === 'imagepull' || variant === 'initwait'
      ? 'Pending'
      : variant === 'completed'
        ? 'Succeeded'
        : variant === 'failed'
          ? 'Failed'
          : 'Running';
  const status: Record<string, unknown> = {
    phase,
    conditions,
    qosClass: qosClass(spec),
  };
  if (!pending) {
    const node = nodeName ? list(db, 'nodes').find((n) => n.metadata.name === nodeName) : undefined;
    const hostIP = (
      node?.status?.addresses as Array<{ type: string; address: string }> | undefined
    )?.find((a) => a.type === 'InternalIP')?.address;
    status.hostIP = hostIP ?? '10.0.0.10';
    status.hostIPs = [{ ip: status.hostIP }];
    if (variant !== 'creating') {
      status.podIP = spec.hostNetwork ? status.hostIP : podIp(db);
      status.podIPs = [{ ip: status.podIP }];
    }
    status.startTime = iso(created + 1000);
    status.containerStatuses = containers.map(statusFor);
    if (inits.length) {
      status.initContainerStatuses = inits.map((c) =>
        variant === 'initwait'
          ? {
              name: c.name,
              image: c.image,
              imageID: '',
              ready: false,
              started: true,
              restartCount: 0,
              state: { running: { startedAt: started } },
            }
          : {
              name: c.name,
              image: c.image,
              imageID: `${c.image.split(':')[0]}@sha256:${suffix(db.rand, 16)}`,
              containerID: cid(db),
              ready: true,
              started: false,
              restartCount: 0,
              state: {
                terminated: {
                  reason: 'Completed',
                  exitCode: 0,
                  startedAt: iso(created + 3000),
                  finishedAt: iso(created + 9000),
                  containerID: cid(db),
                },
              },
            },
      );
    }
  }

  const pod = obj(
    'v1',
    'Pod',
    meta({
      name,
      namespace: input.namespace,
      age: input.age,
      labels: { ...input.template.metadata.labels, ...input.extraLabels },
      annotations: input.template.metadata.annotations,
      owner: input.owner,
    }),
    {
      spec: {
        restartPolicy: 'Always',
        dnsPolicy: 'ClusterFirst',
        schedulerName: 'default-scheduler',
        terminationGracePeriodSeconds: 30,
        enableServiceLinks: true,
        preemptionPolicy: 'PreemptLowerPriority',
        priority: 0,
        ...spec,
        tolerations: [
          ...((spec.tolerations as unknown[]) ?? []),
          {
            key: 'node.kubernetes.io/not-ready',
            operator: 'Exists',
            effect: 'NoExecute',
            tolerationSeconds: 300,
          },
          {
            key: 'node.kubernetes.io/unreachable',
            operator: 'Exists',
            effect: 'NoExecute',
            tolerationSeconds: 300,
          },
        ],
      },
      status,
    },
  );
  if (
    input.template.metadata.labels['pod-template-hash'] === undefined &&
    input.owner?.kind === 'ReplicaSet'
  ) {
    pod.metadata.labels = {
      ...pod.metadata.labels,
      'pod-template-hash': input.owner.metadata.name.split('-').pop()!,
    };
  }
  if (variant === 'terminating') pod.metadata.deletionTimestamp = ago(-30_000);
  return pod;
}

/** Flip an existing pod into a new lifecycle state (used by live updates). */
export function setPodState(
  pod: KubeObject,
  state: 'scheduled' | 'running' | 'succeeded',
  nodeName?: string,
  ip?: string,
) {
  const now = new Date().toISOString();
  const spec = pod.spec as Record<string, unknown>;
  const containers = (spec.containers as Array<{ name: string; image: string }>) ?? [];
  const st = (pod.status ?? {}) as Record<string, unknown>;
  if (state === 'scheduled') {
    if (nodeName) spec.nodeName = nodeName;
    st.phase = 'Pending';
    st.hostIP = '10.0.0.10';
    st.startTime = now;
    st.conditions = [
      { type: 'PodScheduled', status: 'True', lastTransitionTime: now },
      { type: 'Initialized', status: 'True', lastTransitionTime: now },
      { type: 'Ready', status: 'False', reason: 'ContainersNotReady', lastTransitionTime: now },
      {
        type: 'ContainersReady',
        status: 'False',
        reason: 'ContainersNotReady',
        lastTransitionTime: now,
      },
    ];
    st.containerStatuses = containers.map((c) => ({
      name: c.name,
      image: c.image,
      imageID: '',
      ready: false,
      started: false,
      restartCount: 0,
      state: { waiting: { reason: 'ContainerCreating' } },
    }));
  } else if (state === 'running') {
    st.phase = 'Running';
    if (ip) {
      st.podIP = ip;
      st.podIPs = [{ ip }];
    }
    st.conditions = [
      'PodReadyToStartContainers',
      'Initialized',
      'Ready',
      'ContainersReady',
      'PodScheduled',
    ].map((type) => ({ type, status: 'True', lastTransitionTime: now }));
    st.containerStatuses = containers.map((c) => ({
      name: c.name,
      image: c.image,
      imageID: `${c.image.split(':')[0]}@sha256:9f86d081884c7d65`,
      containerID: `containerd://${crypto.randomUUID().replace(/-/g, '')}`,
      ready: true,
      started: true,
      restartCount: 0,
      state: { running: { startedAt: now } },
    }));
  } else {
    st.phase = 'Succeeded';
    st.conditions = [
      { type: 'Initialized', status: 'True', lastTransitionTime: now },
      { type: 'Ready', status: 'False', reason: 'PodCompleted', lastTransitionTime: now },
      { type: 'ContainersReady', status: 'False', reason: 'PodCompleted', lastTransitionTime: now },
      { type: 'PodScheduled', status: 'True', lastTransitionTime: now },
    ];
    st.containerStatuses = containers.map((c) => ({
      name: c.name,
      image: c.image,
      imageID: '',
      ready: false,
      started: false,
      restartCount: 0,
      state: {
        terminated: {
          reason: 'Completed',
          exitCode: 0,
          startedAt: st.startTime ?? now,
          finishedAt: now,
        },
      },
    }));
  }
  pod.status = st;
  return pod;
}
