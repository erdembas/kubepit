import type { KubeObject } from '@/types';
import {
  asArray,
  asNumber,
  asObject,
  asString,
  conditions,
  isObject,
  labels,
  spec,
  status,
} from './accessors';
import type { StatusTone } from './pods';
import { cpuMillicores, memoryBytes } from './quantity';

/** Replica-style counters for controllers. */
export interface ReplicaCounts {
  desired: number;
  current: number;
  ready: number;
  available: number;
  updated: number;
}

export function replicaCounts(obj: KubeObject): ReplicaCounts {
  const s = status(obj);
  if (obj.kind === 'DaemonSet') {
    return {
      desired: asNumber(s.desiredNumberScheduled),
      current: asNumber(s.currentNumberScheduled),
      ready: asNumber(s.numberReady),
      available: asNumber(s.numberAvailable),
      updated: asNumber(s.updatedNumberScheduled),
    };
  }
  const desired = spec(obj).replicas === undefined ? 1 : asNumber(spec(obj).replicas);
  return {
    desired,
    current: asNumber(s.replicas),
    ready: asNumber(s.readyReplicas),
    available: asNumber(s.availableReplicas),
    updated: asNumber(s.updatedReplicas),
  };
}

export type WorkloadBucket = 'running' | 'pending' | 'failed' | 'idle';

/** Health bucket for Deployments/StatefulSets/DaemonSets/ReplicaSets/RCs. */
export function workloadBucket(obj: KubeObject): WorkloadBucket {
  const c = replicaCounts(obj);
  if (c.desired === 0) return 'idle';
  const failure = conditions(obj).some(
    (x) =>
      (x.type === 'ReplicaFailure' && x.status === 'True') ||
      (x.type === 'Progressing' && x.reason === 'ProgressDeadlineExceeded'),
  );
  if (failure) return 'failed';
  if (c.ready >= c.desired) return 'running';
  if (c.ready === 0 && c.current > 0) return 'failed';
  return 'pending';
}

export interface ConditionChip {
  label: string;
  tone: StatusTone;
  message?: string;
}

/** True conditions rendered as coloured words (Freelens "Conditions" column). */
export function workloadConditions(obj: KubeObject): ConditionChip[] {
  return conditions(obj)
    .filter((c) => c.status === 'True')
    .map((c) => ({
      label: c.type,
      tone:
        c.type === 'Available' || c.type === 'Complete' || c.type === 'Ready'
          ? 'success'
          : c.type === 'Progressing'
            ? 'info'
            : c.type === 'ReplicaFailure' || c.type === 'Failed'
              ? 'error'
              : c.type === 'Suspended'
                ? 'muted'
                : 'warning',
      message: c.message,
    }));
}

// -- Jobs ---------------------------------------------------------------------

export type JobBucket = 'succeeded' | 'running' | 'failed' | 'suspended';

export function jobBucket(obj: KubeObject): JobBucket {
  const conds = conditions(obj);
  if (conds.some((c) => c.type === 'Complete' && c.status === 'True')) return 'succeeded';
  if (conds.some((c) => c.type === 'Failed' && c.status === 'True')) return 'failed';
  if (spec(obj).suspend === true) return 'suspended';
  return 'running';
}

export function jobCompletions(obj: KubeObject): { succeeded: number; completions: number } {
  return {
    succeeded: asNumber(status(obj).succeeded),
    completions: spec(obj).completions === undefined ? 1 : asNumber(spec(obj).completions),
  };
}

export function jobDuration(obj: KubeObject, now = Date.now()): number | null {
  const start = Date.parse(asString(status(obj).startTime));
  if (!Number.isFinite(start)) return null;
  const end = Date.parse(asString(status(obj).completionTime));
  return (Number.isFinite(end) ? end : now) - start;
}

// -- CronJobs -----------------------------------------------------------------

export function cronActive(obj: KubeObject): number {
  return asArray(status(obj).active).length;
}

export function cronSuspended(obj: KubeObject): boolean {
  return spec(obj).suspend === true;
}

// -- Nodes --------------------------------------------------------------------

export function nodeRoles(obj: KubeObject): string[] {
  const roles: string[] = [];
  for (const [k, v] of Object.entries(labels(obj))) {
    if (k.startsWith('node-role.kubernetes.io/'))
      roles.push(k.slice('node-role.kubernetes.io/'.length) || v);
    else if (k === 'kubernetes.io/role') roles.push(v);
  }
  return roles.length ? [...new Set(roles)].sort() : [];
}

export interface Taint {
  key: string;
  value?: string;
  effect: string;
}

export function nodeTaints(obj: KubeObject): Taint[] {
  return asArray(spec(obj).taints)
    .filter(isObject)
    .map((t) => ({
      key: asString(t.key),
      value: asString(t.value) || undefined,
      effect: asString(t.effect),
    }));
}

export function taintText(t: Taint): string {
  return `${t.key}${t.value ? `=${t.value}` : ''}:${t.effect}`;
}

export function nodeUnschedulable(obj: KubeObject): boolean {
  return spec(obj).unschedulable === true;
}

export function nodeReady(obj: KubeObject): boolean {
  return conditions(obj).some((c) => c.type === 'Ready' && c.status === 'True');
}

/** Ready / NotReady plus SchedulingDisabled and any pressure condition. */
export function nodeConditions(obj: KubeObject): ConditionChip[] {
  const chips: ConditionChip[] = [];
  const conds = conditions(obj);
  const ready = conds.find((c) => c.type === 'Ready');
  chips.push(
    ready?.status === 'True'
      ? { label: 'Ready', tone: 'success' }
      : {
          label: ready?.status === 'Unknown' ? 'Unknown' : 'NotReady',
          tone: 'error',
          message: ready?.message,
        },
  );
  for (const c of conds) {
    if (c.type !== 'Ready' && c.status === 'True')
      chips.push({ label: c.type, tone: 'warning', message: c.message });
  }
  if (nodeUnschedulable(obj)) chips.push({ label: 'SchedulingDisabled', tone: 'warning' });
  return chips;
}

export function nodeVersion(obj: KubeObject): string {
  return asString(asObject(status(obj).nodeInfo).kubeletVersion);
}

export function nodeResources(obj: KubeObject, which: 'capacity' | 'allocatable') {
  const r = asObject(status(obj)[which]);
  return {
    cpu: cpuMillicores(r.cpu),
    memory: memoryBytes(r.memory),
    pods: asNumber(r.pods),
    storage: memoryBytes(r['ephemeral-storage']),
  };
}

export function nodeInternalIp(obj: KubeObject): string {
  const addr = asArray(status(obj).addresses)
    .filter(isObject)
    .find((a) => a.type === 'InternalIP');
  return addr ? asString(addr.address) : '';
}

// -- Misc ---------------------------------------------------------------------

export function toneText(tone: StatusTone): string {
  switch (tone) {
    case 'success':
      return 'text-status-running';
    case 'warning':
      return 'text-status-starting';
    case 'error':
      return 'text-status-error';
    case 'info':
      return 'text-cat-frontend';
    default:
      return 'text-fg-dim';
  }
}

export function toneDot(tone: StatusTone): string {
  switch (tone) {
    case 'success':
      return 'bg-status-running';
    case 'warning':
      return 'bg-status-starting';
    case 'error':
      return 'bg-status-error';
    case 'info':
      return 'bg-cat-frontend';
    default:
      return 'bg-fg-dim/60';
  }
}

/** Generic `status.phase` tone (Namespaces, PVCs, PVs, helm statuses). */
export function phaseTone(phase: string): StatusTone {
  const p = phase.toLowerCase();
  if (
    [
      'active',
      'bound',
      'available',
      'deployed',
      'running',
      'succeeded',
      'complete',
      'healthy',
      'synced',
      'true',
    ].includes(p)
  )
    return 'success';
  if (
    [
      'pending',
      'pending-install',
      'pending-upgrade',
      'pending-rollback',
      'progressing',
      'uninstalling',
      'outofsync',
    ].includes(p)
  )
    return 'warning';
  if (['failed', 'lost', 'degraded', 'false', 'missing'].includes(p)) return 'error';
  if (['terminating', 'released', 'superseded'].includes(p)) return 'info';
  return 'muted';
}
