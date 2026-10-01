import * as i18n from '@/i18n/core';
import type {
  NodeMaintenancePlan,
  NodeMaintenanceProgress,
  NodeMaintenanceReceipt,
} from '@/types/nodeMaintenance';

export const MONITOR_WINDOW_MS = 5 * 60_000;

export function drainReviewBlock(
  plan: NodeMaintenancePlan,
): 'read-only' | 'incomplete-inventory' | 'unmanaged-pods' | null {
  if (plan.read_only) return 'read-only';
  if (!plan.inventory_complete || plan.warnings.includes('namespace-limit'))
    return 'incomplete-inventory';
  if (plan.pods.some((pod) => pod.action === 'unmanaged')) return 'unmanaged-pods';
  return null;
}

/** Observation, not a scheduling or application-availability guarantee. New
 * Pods must have a new UID, be Ready elsewhere, and come from a complete
 * before/after owner inventory. Accepted evictions alone never satisfy it. */
export function maintenanceObservedReady(
  plan: NodeMaintenancePlan,
  progress: NodeMaintenanceProgress | null,
  receipt: NodeMaintenanceReceipt | null,
): boolean {
  if (
    !progress ||
    !receipt ||
    receipt.plan_id !== plan.plan_id ||
    !receipt.node_cordoned ||
    !progress.node_uid_matches ||
    progress.node_cordoned !== true
  )
    return false;
  const affected = plan.pods.filter((pod) => pod.action === 'evict');
  if (
    receipt.evictions.some((item) => !['accepted', 'already-gone'].includes(item.status)) ||
    receipt.evictions.length !== affected.length ||
    new Set(receipt.evictions.map((item) => item.uid)).size !== affected.length ||
    receipt.evictions.some(
      (item) =>
        !affected.some(
          (pod) =>
            pod.uid === item.uid && pod.namespace === item.namespace && pod.name === item.name,
        ),
    )
  )
    return false;
  if (
    affected.some(
      (pod) =>
        !progress.sources.some((source) => source.uid === pod.uid && source.state === 'gone'),
    )
  )
    return false;
  return plan.workloads.every((workload) => {
    const current = progress.workloads.find(
      (item) => item.namespace === workload.namespace && item.owner.uid === workload.owner.uid,
    );
    return (
      workload.complete &&
      current?.complete &&
      new Set(
        current.replacements
          .filter(
            (pod) =>
              pod.ready &&
              !!pod.node &&
              pod.node !== plan.node_name &&
              !workload.baseline_uids.includes(pod.uid),
          )
          .map((pod) => pod.uid),
      ).size >= workload.expected_replacements
    );
  });
}

export function maintenanceMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  const code = raw.replace(/^.*node-maintenance:/, '');
  if (raw.includes('read-only') || code === 'read-only')
    return i18n.t(
      'This cluster is read-only. You can inspect the plan, but cannot drain the node.',
    );
  switch (code) {
    case 'plan-expired':
      return i18n.t('This maintenance plan expired. Refresh the preflight before continuing.');
    case 'stale-plan':
      return i18n.t(
        'The node or reviewed evidence changed. Refresh and review the plan again; no new drain was started.',
      );
    case 'disconnected':
      return i18n.t('Connect the cluster to inspect node maintenance.');
    case 'incomplete-inventory':
      return i18n.t(
        'The affected Pod inventory is incomplete. Drain is blocked until the complete plan can be reviewed.',
      );
    case 'unmanaged-pods':
      return i18n.t(
        'Unmanaged Pods would not be recreated. This reviewed drain does not force-delete them.',
      );
    case 'permission-denied':
      return i18n.t(
        'RBAC does not allow every required node patch and Pod eviction. Nothing was cordoned by this attempt.',
      );
    case 'timeout':
      return i18n.t(
        'The maintenance request timed out. Inspect current progress before trying again.',
      );
    case 'missing-identity':
    case 'invalid-node':
      return i18n.t(
        'The node or Pod identity could not be verified. Refresh the resource and try again.',
      );
    case 'pods-partial':
    case 'pod-identity':
    case 'namespace-limit':
      return i18n.t(
        'The preflight inventory reached a limit or lacks Pod identity. It is not a complete drain plan.',
      );
    case 'pdbs-forbidden':
      return i18n.t(
        'PDBs could not be read with these credentials. Budget impact is unknown; the Eviction API still enforces PDBs.',
      );
    case 'pdbs-timeout':
    case 'pdbs-unavailable':
    case 'pdbs-partial':
      return i18n.t(
        'PDB evidence is partial or unavailable. Missing budgets do not mean evictions are allowed.',
      );
    case 'overlapping-pdbs':
      return i18n.t(
        'Some Pods match multiple PDBs. Their evictions may be rejected by the API server.',
      );
    case 'workloads-partial':
      return i18n.t(
        'A workload Pod inventory is incomplete. Replacement readiness cannot be verified for it.',
      );
    case 'node-unverified':
      return i18n.t(
        'The original node identity can no longer be verified. Progress is incomplete.',
      );
    case 'not-started':
      return i18n.t('The reviewed drain has not started yet.');
    default:
      return raw;
  }
}

export function evictionLabel(status: string) {
  switch (status) {
    case 'accepted':
      return i18n.t('Eviction accepted');
    case 'already-gone':
      return i18n.t('Already gone');
    case 'pdb-blocked':
      return i18n.t('PDB rejected eviction');
    case 'timeout':
      return i18n.t('Request outcome unknown');
    case 'not-attempted':
      return i18n.t('Not attempted before deadline');
    default:
      return i18n.t('Eviction failed');
  }
}

export function sourceLabel(status: string) {
  switch (status) {
    case 'gone':
      return i18n.t('Source Pod gone');
    case 'terminating':
      return i18n.t('Source Pod terminating');
    case 'present':
      return i18n.t('Source Pod still present');
    default:
      return i18n.t('Source Pod status unknown');
  }
}
