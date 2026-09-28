import type { KubeObject } from '@/types';

/**
 * The objects whose pod spec represents what runs: workload templates, Jobs
 * not created by a loaded CronJob, and pods no loaded controller covers
 * (bare pods, static pods excluded). Mirrors the health engine's
 * `specOwners` so one bad template is one result, not one per replica.
 */

export interface WorkloadLists {
  pods: readonly KubeObject[];
  deployments: readonly KubeObject[];
  statefulSets: readonly KubeObject[];
  daemonSets: readonly KubeObject[];
  jobs: readonly KubeObject[];
  cronJobs: readonly KubeObject[];
}

const key = (namespace: string | null | undefined, name: string) => `${namespace ?? ''}/${name}`;

export function podSpecOwners(lists: WorkloadLists): KubeObject[] {
  const out: KubeObject[] = [
    ...lists.deployments,
    ...lists.statefulSets,
    ...lists.daemonSets,
    ...lists.cronJobs,
  ];
  const cronJobs = new Set(lists.cronJobs.map((c) => key(c.metadata.namespace, c.metadata.name)));
  for (const job of lists.jobs) {
    const owner = job.metadata.ownerReferences?.find((r) => r.controller);
    if (owner?.kind === 'CronJob' && cronJobs.has(key(job.metadata.namespace, owner.name)))
      continue;
    out.push(job);
  }
  const deployments = new Set(
    lists.deployments.map((d) => key(d.metadata.namespace, d.metadata.name)),
  );
  const named = (items: readonly KubeObject[]) =>
    new Set(items.map((o) => key(o.metadata.namespace, o.metadata.name)));
  const statefulSets = named(lists.statefulSets);
  const daemonSets = named(lists.daemonSets);
  const jobs = named(lists.jobs);
  for (const pod of lists.pods) {
    if (pod.metadata.annotations?.['kubernetes.io/config.mirror']) continue;
    const owner = pod.metadata.ownerReferences?.find((r) => r.controller);
    const ns = pod.metadata.namespace;
    let covered = false;
    switch (owner?.kind) {
      case 'ReplicaSet': {
        const dash = owner.name.lastIndexOf('-');
        covered = dash > 0 && deployments.has(key(ns, owner.name.slice(0, dash)));
        break;
      }
      case 'StatefulSet':
        covered = statefulSets.has(key(ns, owner.name));
        break;
      case 'DaemonSet':
        covered = daemonSets.has(key(ns, owner.name));
        break;
      case 'Job':
        covered = jobs.has(key(ns, owner.name));
        break;
    }
    if (!covered) out.push(pod);
  }
  return out;
}

/** Owners grouped by namespace. */
export function ownersByNamespace(owners: readonly KubeObject[]): Map<string, KubeObject[]> {
  const map = new Map<string, KubeObject[]>();
  for (const o of owners) {
    const ns = o.metadata.namespace ?? '';
    const list = map.get(ns);
    if (list) list.push(o);
    else map.set(ns, [o]);
  }
  return map;
}
