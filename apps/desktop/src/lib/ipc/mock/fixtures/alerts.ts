import type { AlertReason, KubeObject } from '@/types';

/**
 * Demo alert scenarios: which fixture object a scenario picks and what
 * Kubernetes would say about it. Messages are Kubernetes' own words, so
 * they are never translated.
 */

export type AlertScenarioKind = 'pod' | 'job' | 'node' | 'deployment' | 'burst' | 'repeat';

export interface AlertScenario {
  kind: AlertScenarioKind;
  reason: AlertReason;
  weight: number;
  condition?: string;
  message: (obj: KubeObject, container: string | null) => string;
}

const podRef = (obj: KubeObject) =>
  `${obj.metadata.name}_${obj.metadata.namespace}(${obj.metadata.uid.slice(0, 8)})`;

export const ALERT_SCENARIOS: readonly AlertScenario[] = [
  {
    kind: 'pod',
    reason: 'CrashLoopBackOff',
    weight: 5,
    message: (obj, c) =>
      `back-off 1m20s restarting failed container=${c ?? 'app'} pod=${podRef(obj)}`,
  },
  {
    kind: 'pod',
    reason: 'OOMKilled',
    weight: 3,
    message: () => 'exit code 137',
  },
  {
    kind: 'pod',
    reason: 'ImagePullBackOff',
    weight: 2,
    message: (obj) =>
      `ErrImagePull: rpc error: code = NotFound desc = failed to pull and unpack image "registry.acme.io/${obj.metadata.labels?.app ?? obj.metadata.name}:v2.14.0-rc1": not found`,
  },
  {
    kind: 'pod',
    reason: 'Evicted',
    weight: 1,
    message: () =>
      'The node was low on resource: memory. Threshold quantity: 100Mi, available: 42Mi.',
  },
  {
    kind: 'job',
    reason: 'JobFailed',
    weight: 2,
    message: () => 'BackoffLimitExceeded: Job has reached the specified backoff limit',
  },
  {
    kind: 'node',
    reason: 'NodeNotReady',
    weight: 1,
    message: () => 'Ready=Unknown · NodeStatusUnknown: Kubelet stopped posting node status.',
  },
  {
    kind: 'node',
    reason: 'NodePressure',
    weight: 1,
    condition: 'DiskPressure',
    message: () => 'KubeletHasDiskPressure: kubelet has disk pressure',
  },
  {
    kind: 'deployment',
    reason: 'ProgressDeadlineExceeded',
    weight: 2,
    message: (obj) => `ReplicaSet "${obj.metadata.name}-7d4f9c8b6" has timed out progressing.`,
  },
  // Several pods of one namespace crash together: three alerts, then one group.
  {
    kind: 'burst',
    reason: 'CrashLoopBackOff',
    weight: 1,
    message: (obj, c) =>
      `back-off 10s restarting failed container=${c ?? 'app'} pod=${podRef(obj)}`,
  },
  // The same object again within the cooldown: its entry's count grows.
  {
    kind: 'repeat',
    reason: 'CrashLoopBackOff',
    weight: 2,
    message: (obj, c) =>
      `back-off 5m0s restarting failed container=${c ?? 'app'} pod=${podRef(obj)}`,
  },
];

/** Namespaces whose objects make the most believable alerts. */
export const QUIET_NAMESPACES = new Set(['kube-system', 'kube-public', 'kube-node-lease']);
