import type { KubeObject } from '@/types';
import { asObject, get, isObject, type JsonObject } from '../accessors';
import { ruleDef } from './rules';
import type { Finding, HealthInput, Severity } from './types';

/** Shared helpers for the rule families: finding construction, sinks and indexes. */

export const MAX_FINDINGS_PER_RULE = 400;

export type Emit = (finding: Finding) => void;

export function makeFinding(
  ruleId: string,
  obj: KubeObject,
  message: string,
  detail = '',
  severity?: Severity,
): Finding {
  const def = ruleDef(ruleId);
  return {
    id: `${ruleId}|${obj.metadata.uid}|${detail}`,
    ruleId,
    severity: severity ?? def?.severity ?? 'info',
    category: def?.category ?? 'hygiene',
    ref: {
      apiVersion: obj.apiVersion,
      kind: obj.kind,
      namespace: obj.metadata.namespace ?? null,
      name: obj.metadata.name,
      uid: obj.metadata.uid,
    },
    message,
  };
}

/** Collects findings with a per-rule cap (the overflow is counted, not kept). */
export class FindingSink {
  readonly findings: Finding[] = [];
  readonly overflow = new Map<string, number>();
  private readonly perRule = new Map<string, number>();
  private readonly seen = new Set<string>();

  constructor(private readonly cap = MAX_FINDINGS_PER_RULE) {}

  readonly emit: Emit = (f) => {
    if (this.seen.has(f.id)) return;
    this.seen.add(f.id);
    const n = this.perRule.get(f.ruleId) ?? 0;
    if (n >= this.cap) {
      this.overflow.set(f.ruleId, (this.overflow.get(f.ruleId) ?? 0) + 1);
      return;
    }
    this.perRule.set(f.ruleId, n + 1);
    this.findings.push(f);
  };
}

export const nsKey = (namespace: string | null | undefined, name: string) =>
  `${namespace ?? ''}/${name}`;

export function groupByNamespace(items: readonly KubeObject[]): Map<string, KubeObject[]> {
  const map = new Map<string, KubeObject[]>();
  for (const o of items) {
    const ns = o.metadata.namespace ?? '';
    const list = map.get(ns);
    if (list) list.push(o);
    else map.set(ns, [o]);
  }
  return map;
}

export function isMirrorPod(pod: KubeObject): boolean {
  return !!pod.metadata.annotations?.['kubernetes.io/config.mirror'];
}

/** The pod spec a workload stamps out (`spec.template.spec`, CronJobs one level deeper). */
export function podSpecOf(obj: KubeObject): JsonObject | null {
  switch (obj.kind) {
    case 'Pod':
      return asObject(obj.spec);
    case 'CronJob': {
      const s = get(obj, 'spec.jobTemplate.spec.template.spec');
      return isObject(s) ? s : null;
    }
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
    case 'ReplicaSet':
    case 'ReplicationController':
    case 'Job': {
      const s = get(obj, 'spec.template.spec');
      return isObject(s) ? s : null;
    }
    default:
      return null;
  }
}

/**
 * The objects whose pod spec is evaluated once: workloads, Jobs not owned
 * by a CronJob, and pods no loaded controller covers (bare pods). Pods of
 * Deployments / StatefulSets / DaemonSets / Jobs are skipped so one
 * misconfigured template yields one finding, not one per replica.
 */
export function specOwners(input: HealthInput): KubeObject[] {
  const out: KubeObject[] = [
    ...input.deployments,
    ...input.statefulSets,
    ...input.daemonSets,
    ...input.cronJobs,
  ];
  for (const job of input.jobs) {
    const owner = job.metadata.ownerReferences?.find((r) => r.controller);
    if (owner?.kind === 'CronJob' && input.loaded.has('cronJobs')) continue;
    out.push(job);
  }
  const deployments = new Set(
    input.deployments.map((d) => nsKey(d.metadata.namespace, d.metadata.name)),
  );
  const covered = (pod: KubeObject) => {
    const owner = pod.metadata.ownerReferences?.find((r) => r.controller);
    if (!owner) return false;
    switch (owner.kind) {
      case 'ReplicaSet': {
        const dash = owner.name.lastIndexOf('-');
        return (
          dash > 0 && deployments.has(nsKey(pod.metadata.namespace, owner.name.slice(0, dash)))
        );
      }
      case 'StatefulSet':
        return input.loaded.has('statefulSets');
      case 'DaemonSet':
        return input.loaded.has('daemonSets');
      case 'Job':
        return input.loaded.has('jobs');
      default:
        return false;
    }
  };
  for (const pod of input.pods) if (!isMirrorPod(pod) && !covered(pod)) out.push(pod);
  return out;
}
