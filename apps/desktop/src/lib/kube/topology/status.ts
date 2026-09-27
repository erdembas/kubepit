import type { KubeObject } from '@/types';
import {
  asArray,
  asNumber,
  asObject,
  asString,
  conditions,
  isObject,
  spec,
  status,
} from '../accessors';
import { podIsReady, podStatus, podStatusTone, type StatusTone } from '../pods';
import {
  cronActive,
  cronSuspended,
  jobBucket,
  jobCompletions,
  nodeReady,
  nodeUnschedulable,
  phaseTone,
  replicaCounts,
  workloadBucket,
  type WorkloadBucket,
} from '../workloads';

/**
 * Status tone + short status text per node, reusing the table helpers
 * (pod STATUS column, workload buckets, phase tones). Texts are object data
 * or counts, so they are never translated.
 */

export interface NodeStatus {
  tone: StatusTone | null;
  status: string;
}

const BUCKET_TONE: Record<WorkloadBucket, StatusTone> = {
  running: 'success',
  pending: 'warning',
  failed: 'error',
  idle: 'muted',
};

function conditionTrue(obj: KubeObject, type: string): boolean | null {
  const c = conditions(obj).find((x) => x.type === type);
  return c ? c.status === 'True' : null;
}

function gatewayRouteStatus(obj: KubeObject): NodeStatus {
  const parents = asArray(status(obj).parents).filter(isObject);
  if (!parents.length) return { tone: 'muted', status: '' };
  const accepted = parents.every((p) =>
    asArray(p.conditions)
      .filter(isObject)
      .some((c) => c.type === 'Accepted' && c.status === 'True'),
  );
  return accepted
    ? { tone: 'success', status: 'Accepted' }
    : { tone: 'warning', status: 'Pending' };
}

export function nodeStatus(obj: KubeObject): NodeStatus {
  switch (obj.kind) {
    case 'Pod': {
      const value = podStatus(obj);
      // Running but failing its readiness probe: shown like kubectl's NotReady.
      if (value === 'Running' && !podIsReady(obj)) return { tone: 'warning', status: 'NotReady' };
      return { tone: podStatusTone(value), status: value };
    }
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
    case 'ReplicaSet':
    case 'ReplicationController': {
      const c = replicaCounts(obj);
      return { tone: BUCKET_TONE[workloadBucket(obj)], status: `${c.ready}/${c.desired}` };
    }
    case 'Job': {
      const bucket = jobBucket(obj);
      const c = jobCompletions(obj);
      const tone: StatusTone =
        bucket === 'succeeded'
          ? 'success'
          : bucket === 'failed'
            ? 'error'
            : bucket === 'suspended'
              ? 'muted'
              : 'info';
      return { tone, status: `${c.succeeded}/${c.completions}` };
    }
    case 'CronJob':
      return cronSuspended(obj)
        ? { tone: 'muted', status: 'Suspended' }
        : { tone: cronActive(obj) > 0 ? 'info' : 'success', status: asString(spec(obj).schedule) };
    case 'PersistentVolumeClaim':
    case 'PersistentVolume': {
      const phase = asString(status(obj).phase);
      return { tone: phase ? phaseTone(phase) : 'muted', status: phase };
    }
    case 'Node': {
      if (!nodeReady(obj)) return { tone: 'error', status: 'NotReady' };
      return nodeUnschedulable(obj)
        ? { tone: 'warning', status: 'SchedulingDisabled' }
        : { tone: 'success', status: 'Ready' };
    }
    case 'HorizontalPodAutoscaler': {
      const s = status(obj);
      const text = `${asNumber(s.currentReplicas)}/${asNumber(spec(obj).maxReplicas)}`;
      if (conditionTrue(obj, 'AbleToScale') === false) return { tone: 'error', status: text };
      if (conditionTrue(obj, 'ScalingActive') === false) return { tone: 'warning', status: text };
      return { tone: 'success', status: text };
    }
    case 'PodDisruptionBudget': {
      const s = status(obj);
      const allowed = asNumber(s.disruptionsAllowed);
      return {
        tone: allowed > 0 ? 'success' : 'warning',
        status: `${asNumber(s.currentHealthy)}/${asNumber(s.expectedPods)}`,
      };
    }
    case 'EndpointSlice': {
      const endpoints = asArray(obj.endpoints).filter(isObject);
      const ready = endpoints.filter((e) => asObject(e.conditions).ready !== false).length;
      return {
        tone: endpoints.length === 0 ? 'muted' : ready > 0 ? 'success' : 'warning',
        status: `${ready}/${endpoints.length}`,
      };
    }
    case 'Ingress': {
      const lb = asArray(asObject(status(obj).loadBalancer).ingress).filter(isObject);
      const host =
        asArray(spec(obj).rules)
          .filter(isObject)
          .map((r) => asString(r.host))
          .find(Boolean) ?? '';
      return { tone: lb.length ? 'success' : 'muted', status: host };
    }
    case 'Service': {
      const type = asString(spec(obj).type) || 'ClusterIP';
      return { tone: null, status: spec(obj).clusterIP === 'None' ? 'Headless' : type };
    }
    case 'Gateway': {
      const programmed = conditionTrue(obj, 'Programmed');
      if (programmed === null) return { tone: 'muted', status: '' };
      return programmed
        ? { tone: 'success', status: 'Programmed' }
        : { tone: 'warning', status: 'Pending' };
    }
    case 'HTTPRoute':
    case 'GRPCRoute':
      return gatewayRouteStatus(obj);
    case 'Secret':
      return { tone: null, status: asString(obj.type) === 'kubernetes.io/tls' ? 'TLS' : '' };
    default:
      return { tone: null, status: '' };
  }
}
