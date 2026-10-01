import { drainReviewBlock } from '@/components/workbench/node-maintenance/model';
import { asArray, asObject, asString } from '@/lib/kube/accessors';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import { matchesSelector, parseSelector } from '@/lib/kube/selectors';
import type { ClusterDef, ClusterStatus, KubeObject } from '@/types';
import type {
  NodeMaintenanceDrainRequest,
  NodeMaintenancePlan,
  NodeMaintenancePod,
  NodeMaintenanceProgress,
  NodeMaintenanceReceipt,
  NodeMaintenanceVolume,
} from '@/types/nodeMaintenance';
import { mockDecide } from './access';
import './fixtures/build';
import { find, getDb, list } from './fixtures/db';
import { cordonNode, deleteObject } from './fixtures/ops';
import { handlers, register } from './registry';

const cache = new Map<
  string,
  { clusterId: string; created: number; started: boolean; plan: NodeMaintenancePlan }
>();
const owner = (pod: KubeObject) => {
  const ref = pod.metadata.ownerReferences?.find((ref) => ref.controller === true);
  return ref ? { uid: ref.uid, kind: ref.kind, name: ref.name } : null;
};
const ready = (pod: KubeObject) =>
  asArray(pod.status?.conditions).some((condition) => {
    const value = asObject(condition);
    return value.type === 'Ready' && value.status === 'True';
  });
function connected(clusterId: string) {
  const state = (handlers.cluster_statuses?.({}) as Record<string, ClusterStatus> | undefined)?.[
    clusterId
  ];
  if (state?.state !== 'connected') throw new Error('node-maintenance:disconnected');
}
function readOnly(clusterId: string) {
  return !!(handlers.cluster_list?.({}) as ClusterDef[] | undefined)?.find(
    (cluster) => cluster.id === clusterId,
  )?.read_only;
}
function permitted(
  clusterId: string,
  resource: string,
  verb: string,
  namespace: string | null = null,
  name: string | null = null,
  subresource: string | null = null,
  group = '',
) {
  return mockDecide(clusterId, { group, resource, verb, namespace, name, subresource }).allowed;
}
function matchesPdb(pdb: KubeObject, pod: KubeObject): boolean {
  const selector = pdb.spec?.selector;
  return (
    pod.metadata.namespace === pdb.metadata.namespace &&
    !!selector &&
    matchesSelector(parseSelector({ matchLabels: {}, ...asObject(selector) }), pod.metadata.labels)
  );
}
function required(pod: NodeMaintenancePod, pdb: KubeObject): boolean {
  if (pod.terminating || ['Pending', 'Succeeded', 'Failed'].includes(pod.phase)) return false;
  const status = asObject(pdb.status);
  if (
    pod.phase === 'Running' &&
    !pod.ready &&
    (pdb.spec?.unhealthyPodEvictionPolicy === 'AlwaysAllow' ||
      (typeof status.currentHealthy === 'number' &&
        typeof status.desiredHealthy === 'number' &&
        status.currentHealthy >= status.desiredHealthy &&
        status.desiredHealthy > 0))
  )
    return false;
  return true;
}
function currentBudget(pdb: KubeObject, pods: KubeObject[]): number {
  const desired = pdb.status?.desiredHealthy;
  if (typeof desired !== 'number') return 0;
  // Recompute from fixture observations so another reviewed drain cannot
  // reuse an allowance consumed by still-terminating Pods.
  const healthy = pods.filter(
    (pod) => matchesPdb(pdb, pod) && ready(pod) && !pod.metadata.deletionTimestamp,
  ).length;
  return Math.max(0, healthy - desired);
}
export function nodePlanFingerprint(plan: NodeMaintenancePlan): string {
  const text = JSON.stringify({
    node: plan.node_uid,
    cordoned: plan.unschedulable,
    pods: plan.pods,
    pdbs: plan.pdbs,
    workloads: plan.workloads,
    inventory: plan.inventory_complete,
    pdb_inventory: plan.pdbs_complete,
    warnings: plan.warnings,
  });
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}
function build(clusterId: string, name: string): NodeMaintenancePlan {
  connected(clusterId);
  if (!permitted(clusterId, 'nodes', 'get', null, name) || !permitted(clusterId, 'pods', 'list'))
    throw new Error('node-maintenance:permission-denied');
  const db = getDb(clusterId);
  const node = find(db, 'nodes', null, name);
  if (!node?.metadata.uid) throw new Error('node-maintenance:missing-identity');
  const allPods = list(db, 'pods');
  const affected = allPods
    .filter((pod) => pod.spec?.nodeName === name)
    .sort((a, b) =>
      `${a.metadata.namespace}/${a.metadata.name}`.localeCompare(
        `${b.metadata.namespace}/${b.metadata.name}`,
      ),
    );
  const raw = affected.slice(0, 500);
  const warnings: string[] = affected.length > 500 ? ['pods-partial'] : [];
  const pods: NodeMaintenancePod[] = raw.map((pod) => {
    const control = owner(pod);
    const phase = asString(pod.status?.phase);
    const volumes: NodeMaintenanceVolume[] = [];
    for (const value of asArray(pod.spec?.volumes)) {
      const volume = asObject(value);
      const volumeName = asString(volume.name);
      if (volume.emptyDir) volumes.push({ kind: 'empty-dir', name: volumeName });
      else if (volume.hostPath) volumes.push({ kind: 'host-path', name: volumeName });
      else if (volume.persistentVolumeClaim) {
        const claimName = asString(asObject(volume.persistentVolumeClaim).claimName);
        const canRead = permitted(
          clusterId,
          'persistentvolumeclaims',
          'get',
          pod.metadata.namespace ?? null,
          claimName,
        );
        const claim = canRead
          ? find(db, 'persistentvolumeclaims', pod.metadata.namespace ?? null, claimName)
          : null;
        const pvName = asString(claim?.spec?.volumeName);
        const pv =
          pvName && permitted(clusterId, 'persistentvolumes', 'get', null, pvName)
            ? find(db, 'persistentvolumes', null, pvName)
            : null;
        if (!pv) volumes.push({ kind: 'persistent-volume-unknown', name: claimName });
        else if (pv.spec?.local || pv.spec?.hostPath)
          volumes.push({ kind: 'local-pv', name: claimName });
      }
    }
    return {
      namespace: pod.metadata.namespace ?? '',
      name: pod.metadata.name,
      uid: pod.metadata.uid,
      action: pod.metadata.annotations?.['kubernetes.io/config.mirror']
        ? 'mirror'
        : control?.kind === 'DaemonSet'
          ? 'daemonset'
          : !control && !['Succeeded', 'Failed'].includes(phase)
            ? 'unmanaged'
            : 'evict',
      phase,
      ready: ready(pod),
      terminating: !!pod.metadata.deletionTimestamp,
      owner: control,
      volumes,
      pdbs: [],
    };
  });
  const pdbReadable = permitted(
    clusterId,
    'poddisruptionbudgets',
    'list',
    null,
    null,
    null,
    'policy',
  );
  const allPdbs = list(db, 'poddisruptionbudgets.policy');
  const pdbsComplete = pdbReadable && allPdbs.length <= 1000;
  if (!pdbReadable) warnings.push('pdbs-forbidden');
  if (!pdbsComplete) warnings.push('pdbs-partial');
  const pdbs = (pdbReadable ? allPdbs.slice(0, 1000) : [])
    .flatMap((pdb) => {
      const matched = raw
        .map((pod, index) => ({ pod, summary: pods[index]! }))
        .filter(({ pod, summary }) => summary.action === 'evict' && matchesPdb(pdb, pod));
      if (!matched.length) return [];
      for (const { summary } of matched)
        summary.pdbs.push(`${pdb.metadata.namespace}/${pdb.metadata.name}`);
      const status = asObject(pdb.status);
      const generation = pdb.metadata.generation;
      return [
        {
          namespace: pdb.metadata.namespace ?? '',
          name: pdb.metadata.name,
          uid: pdb.metadata.uid,
          selector: JSON.stringify(pdb.spec?.selector ?? null),
          matched_pods: matched.map(({ summary }) => summary.uid),
          disruptions_allowed:
            typeof generation === 'number' &&
            typeof status.observedGeneration === 'number' &&
            status.observedGeneration >= generation &&
            typeof status.disruptionsAllowed === 'number'
              ? currentBudget(pdb, allPods)
              : null,
          required_disruptions: matched.filter(({ summary }) => required(summary, pdb)).length,
          unhealthy_policy: asString(pdb.spec?.unhealthyPodEvictionPolicy) || 'IfHealthyBudget',
        },
      ];
    })
    .sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`));
  for (const pod of pods) {
    pod.pdbs.sort();
    if (pod.pdbs.length > 1) warnings.push('overlapping-pdbs');
  }
  const workloads: NodeMaintenancePlan['workloads'] = [];
  for (const pod of pods.filter(
    (p) => p.action === 'evict' && !['Succeeded', 'Failed'].includes(p.phase),
  )) {
    if (!pod.owner) continue;
    const existing = workloads.find(
      (w) => w.namespace === pod.namespace && w.owner.uid === pod.owner?.uid,
    );
    if (existing) {
      existing.expected_replacements++;
      continue;
    }
    const peers = allPods.filter((p) => p.metadata.namespace === pod.namespace);
    const complete = peers.length <= 1000 && permitted(clusterId, 'pods', 'list', pod.namespace);
    if (!complete) warnings.push('workloads-partial');
    workloads.push({
      namespace: pod.namespace,
      owner: pod.owner,
      expected_replacements: 1,
      complete,
      baseline_uids: complete
        ? peers
            .slice(0, 1000)
            .filter((p) => owner(p)?.uid === pod.owner?.uid)
            .map((p) => p.metadata.uid)
            .sort()
        : [],
    });
  }
  if (new Set(pods.filter((p) => p.action === 'evict').map((p) => p.namespace)).size > 20)
    warnings.push('namespace-limit');
  const plan: NodeMaintenancePlan = {
    plan_id: crypto.randomUUID(),
    node_name: name,
    node_uid: node.metadata.uid,
    fingerprint: '',
    checked_at: Date.now(),
    read_only: readOnly(clusterId),
    unschedulable: node.spec?.unschedulable === true,
    inventory_complete: affected.length <= 500,
    pdbs_complete: pdbsComplete,
    pods,
    pdbs,
    workloads,
    warnings: [...new Set(warnings)].sort(),
  };
  plan.fingerprint = nodePlanFingerprint(plan);
  return plan;
}
function lookup(clusterId: string, planId: string) {
  const saved = cache.get(planId);
  if (!saved || saved.clusterId !== clusterId || Date.now() - saved.created >= 30 * 60_000)
    throw new Error('node-maintenance:plan-expired');
  return saved;
}
export function demoNodePreflight(clusterId: string, name: string) {
  const plan = build(clusterId, name);
  for (const [id, entry] of cache) if (Date.now() - entry.created >= 30 * 60_000) cache.delete(id);
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(plan.plan_id, {
    clusterId,
    created: Date.now(),
    started: false,
    plan: structuredClone(plan),
  });
  return plan;
}
export function demoNodeDrain(
  clusterId: string,
  request: NodeMaintenanceDrainRequest,
): NodeMaintenanceReceipt {
  if (readOnly(clusterId)) throw new Error('node-maintenance:read-only');
  const saved = lookup(clusterId, request.plan_id);
  const plan = saved.plan;
  if (
    saved.started ||
    Date.now() - saved.created > 120_000 ||
    request.name !== plan.node_name ||
    request.node_uid !== plan.node_uid ||
    request.fingerprint !== plan.fingerprint ||
    build(clusterId, request.name).fingerprint !== plan.fingerprint
  )
    throw new Error('node-maintenance:stale-plan');
  const block = drainReviewBlock(plan);
  if (block) throw new Error(`node-maintenance:${block}`);
  if (
    !permitted(clusterId, 'nodes', 'patch', null, plan.node_name) ||
    plan.pods.some(
      (p) =>
        p.action === 'evict' &&
        !permitted(clusterId, 'pods', 'create', p.namespace, p.name, 'eviction'),
    )
  )
    throw new Error('node-maintenance:permission-denied');
  saved.started = true;
  const db = getDb(clusterId);
  cordonNode(db, plan.node_name, true);
  const budgets = new Map(
    list(db, 'poddisruptionbudgets.policy').map((pdb) => [
      pdb.metadata.uid,
      currentBudget(pdb, list(db, 'pods')),
    ]),
  );
  const evictions: NodeMaintenanceReceipt['evictions'] = plan.pods
    .filter((p) => p.action === 'evict')
    .map((pod) => {
      const base = { namespace: pod.namespace, name: pod.name, uid: pod.uid, error: null };
      const current = find(db, 'pods', pod.namespace, pod.name);
      if (!current) return { ...base, status: 'already-gone' };
      if (current.metadata.uid !== pod.uid) return { ...base, status: 'failed' };
      const pdbs = list(db, 'poddisruptionbudgets.policy').filter((pdb) =>
        matchesPdb(pdb, current),
      );
      if (
        pdbs.length > 1 ||
        pdbs.some((pdb) => required(pod, pdb) && (budgets.get(pdb.metadata.uid) ?? 0) <= 0)
      )
        return { ...base, status: 'pdb-blocked' };
      for (const pdb of pdbs)
        if (required(pod, pdb))
          budgets.set(pdb.metadata.uid, (budgets.get(pdb.metadata.uid) ?? 0) - 1);
      deleteObject(db, toGvk(BUILTIN.Pod), pod.namespace, pod.name);
      return { ...base, status: 'accepted' };
    });
  return { plan_id: plan.plan_id, started_at: Date.now(), node_cordoned: true, evictions };
}
export function demoNodeProgress(clusterId: string, planId: string): NodeMaintenanceProgress {
  const saved = lookup(clusterId, planId);
  if (!saved.started) throw new Error('node-maintenance:not-started');
  connected(clusterId);
  const plan = saved.plan;
  const db = getDb(clusterId);
  const pods = list(db, 'pods');
  const node = find(db, 'nodes', null, plan.node_name);
  const nodeMatches = node?.metadata.uid === plan.node_uid;
  return {
    checked_at: Date.now(),
    node_uid_matches: nodeMatches,
    node_cordoned: nodeMatches ? node.spec?.unschedulable === true : null,
    sources: plan.pods
      .filter((p) => p.action === 'evict')
      .map((source) => {
        const peers = pods.filter((pod) => pod.metadata.namespace === source.namespace);
        const current = peers.slice(0, 1000).find((pod) => pod.metadata.uid === source.uid);
        return {
          namespace: source.namespace,
          name: source.name,
          uid: source.uid,
          state: !permitted(clusterId, 'pods', 'list', source.namespace)
            ? 'unknown'
            : !current
              ? peers.length <= 1000
                ? 'gone'
                : 'unknown'
              : current.metadata.deletionTimestamp
                ? 'terminating'
                : 'present',
        };
      }),
    workloads: plan.workloads.map((w) => {
      const peers = pods.filter((pod) => pod.metadata.namespace === w.namespace);
      const complete =
        w.complete && peers.length <= 1000 && permitted(clusterId, 'pods', 'list', w.namespace);
      return {
        namespace: w.namespace,
        owner: w.owner,
        expected_replacements: w.expected_replacements,
        complete,
        replacements:
          !w.complete || !permitted(clusterId, 'pods', 'list', w.namespace)
            ? []
            : peers
                .slice(0, 1000)
                .filter(
                  (pod) =>
                    owner(pod)?.uid === w.owner.uid &&
                    !w.baseline_uids.includes(pod.metadata.uid) &&
                    !pod.metadata.deletionTimestamp,
                )
                .map((pod) => ({
                  name: pod.metadata.name,
                  uid: pod.metadata.uid,
                  node: asString(pod.spec?.nodeName),
                  ready: ready(pod),
                  phase: asString(pod.status?.phase),
                })),
      };
    }),
    warnings: nodeMatches ? [] : ['node-unverified'],
  };
}
register({
  node_maintenance_preflight: ({ clusterId, name }) => demoNodePreflight(clusterId, name),
  node_maintenance_drain: ({ clusterId, request }) => demoNodeDrain(clusterId, request),
  node_maintenance_progress: ({ clusterId, planId }) => demoNodeProgress(clusterId, planId),
});
