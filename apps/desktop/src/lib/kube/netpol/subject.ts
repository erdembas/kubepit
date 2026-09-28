import type { KubeObject } from '@/types';
import { asObject } from '../accessors';
import { matchesSelector, parseSelector } from '../selectors';
import type { NpCluster, NpPod } from './model';
import { parsePod, templatePod, TEMPLATE_KINDS, withPods } from './parse';

/** The pod a details panel evaluates for a Pod or a workload. */

export function hasReachability(obj: KubeObject): boolean {
  return obj.kind === 'Pod' || TEMPLATE_KINDS.has(obj.kind);
}

export interface ReachSubject {
  cluster: NpCluster;
  /** The pod evaluated (a replica, or the pod template when there are none). */
  pod: NpPod;
  /** Every live pod of the workload. */
  pods: NpPod[];
  /** Replicas do not all carry the same labels: the first one was evaluated. */
  mixedLabels: boolean;
}

function labelsKey(pod: NpPod) {
  return Object.entries(pod.labels)
    .filter(([k]) => k !== 'pod-template-hash' && k !== 'controller-revision-hash')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}

export function reachSubject(cluster: NpCluster, obj: KubeObject): ReachSubject | null {
  if (obj.kind === 'Pod') {
    const known = cluster.podsById.get(obj.metadata.uid);
    if (known) return { cluster, pod: known, pods: [known], mixedLabels: false };
    const pod = parsePod(obj);
    return { cluster: withPods(cluster, [pod]), pod, pods: [pod], mixedLabels: false };
  }
  if (!TEMPLATE_KINDS.has(obj.kind)) return null;
  const namespace = obj.metadata.namespace ?? '';
  const selector = obj.kind === 'CronJob' ? null : parseSelector(asObject(obj.spec).selector);
  const pods = selector
    ? (cluster.podsByNamespace.get(namespace) ?? []).filter(
        (p) => !p.template && matchesSelector(selector, p.labels as Record<string, string>),
      )
    : [];
  if (pods.length) {
    const first = labelsKey(pods[0]!);
    return {
      cluster,
      pod: pods[0]!,
      pods,
      mixedLabels: pods.some((p) => labelsKey(p) !== first),
    };
  }
  const tpl = templatePod(obj);
  if (!tpl) return null;
  return { cluster: withPods(cluster, [tpl]), pod: tpl, pods: [], mixedLabels: false };
}
