import { useMemo } from 'react';
import { ipc } from '@/lib/ipc';
import {
  rightsizingOrigin,
  workloadKey,
  type RightsizingOrigin,
} from '@/lib/kube/recommendations/model';
import { useAppStore } from '@/store/useAppStore';
import { useLatestRecommendations } from '@/store/useRecommendationsStore';
import type {
  ClusterId,
  CostAggregate,
  CostReport,
  CostStatus,
  CostWindow,
  RecommendationRun,
  RightsizingReport,
  RightsizingRequest,
  WorkloadRecommendation,
  WorkloadRef,
} from '@/types';
import { refreshPolled, refreshPolledPrefix, usePolled } from '../data/polled';

/**
 * Cost data through the shared poll cache: keys change with the connection
 * and the cluster's cost setting, so a reconnect or a new price model
 * refetches. The backend caches reports too; `refresh` bypasses both.
 */

/** Reports are recomputed at most this often while visible. */
export const COST_POLL_MS = 5 * 60_000;
/** Right-sizing looks at days of history; it changes slowly. */
export const RIGHTSIZING_POLL_MS = 15 * 60_000;

/** Keys whose next fetch bypasses the backend cache. */
const forced = new Set<string>();

/**
 * Cache-key fragment of the connection and the cost setting; `null` while
 * disconnected or before the cluster exists.
 */
export function useCostSourceKey(clusterId: ClusterId | null): string | null {
  const config = useAppStore((s) =>
    JSON.stringify(s.clusters.find((c) => c.id === clusterId)?.cost ?? null),
  );
  const status = useAppStore((s) => (clusterId ? s.statuses[clusterId] : undefined));
  if (!clusterId || status?.state !== 'connected') return null;
  return `${config}|${status.connected_at ?? 0}`;
}

/** Idle for a `null` id (a cluster that is still being added). */
export function useCostStatus(clusterId: ClusterId | null, enabled = true) {
  const source = useCostSourceKey(clusterId);
  const key = source ? `${clusterId}|cost-status|${source}` : null;
  return usePolled<CostStatus>(
    key,
    () => ipc.costStatus(clusterId!, key ? forced.delete(key) : false),
    COST_POLL_MS,
    enabled,
  );
}

export function useCostReport(
  clusterId: ClusterId,
  window: CostWindow,
  aggregate: CostAggregate,
  label: string | null,
  enabled = true,
) {
  const source = useCostSourceKey(clusterId);
  const labelKey = aggregate === 'label' ? (label ?? '').trim() : '';
  const key =
    source && (aggregate !== 'label' || labelKey)
      ? `${clusterId}|cost-report|${source}|${window}|${aggregate}|${labelKey}`
      : null;
  const state = usePolled<CostReport>(
    key,
    () =>
      ipc.costReport(clusterId, {
        window,
        aggregate,
        label: labelKey || null,
        refresh: key ? forced.delete(key) : false,
      }),
    COST_POLL_MS,
    enabled,
  );
  /** Detect the source again and recompute, bypassing the backend cache. */
  const forceRefresh = () => {
    if (!key) return;
    forced.add(key);
    refreshPolled(key);
    refreshPolledPrefix(`${clusterId}|cost-status|`);
  };
  return { ...state, forceRefresh };
}

/**
 * Cache-key fragment of what the backend's effective settings depend on:
 * the saved strategy and the per-strategy overrides.
 */
function useRecommendationSettingsKey(): string {
  return useAppStore((s) => {
    const rec = s.settings?.recommendations;
    return JSON.stringify([rec?.strategy ?? null, rec?.overrides ?? null]);
  });
}

/**
 * Right-sizing for `namespaces` (all when empty) or one workload, with the
 * saved strategy and settings (`Settings.recommendations`). The Health
 * scan and the details panel share entries.
 */
export function useRightsizing(
  clusterId: ClusterId,
  namespaces: readonly string[],
  workload: WorkloadRef | null,
  enabled = true,
) {
  const source = useCostSourceKey(clusterId);
  const settings = useRecommendationSettingsKey();
  const scope = workload
    ? `w:${workload.kind}/${workload.namespace}/${workload.name}`
    : `n:${[...namespaces].sort().join(',')}`;
  const key = source ? `${clusterId}|rightsizing|${source}|${scope}|${settings}` : null;
  const request = useMemo<RightsizingRequest>(
    () => ({ namespaces: [...namespaces], workload, settings: null, strategy: null }),
    // `scope` captures the inputs by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope],
  );
  return usePolled<RightsizingReport>(
    key,
    () => ipc.rightsizingReport(clusterId, request),
    RIGHTSIZING_POLL_MS,
    enabled,
  );
}

export interface StoredOrLiveRightsizing {
  origin: RightsizingOrigin;
  /** The report read: the latest stored scan's or the live one (null while it loads). */
  report: RightsizingReport | null;
  /** With a workload: its row (null while loading, or when the report has none). */
  rec: WorkloadRecommendation | null;
  /** The stored scan's run (`stored` only). */
  run: RecommendationRun | null;
  /** The live report failed (`live` only). */
  error: string | null;
}

/**
 * Right-sizing outside the Recommendations view (spec §9.2): the latest
 * stored scan when there is one (for a workload, when it has the
 * workload's row; `rightsizingOrigin`), else the live report, which is
 * computed only then.
 */
export function useStoredOrLiveRightsizing(
  clusterId: ClusterId,
  namespaces: readonly string[],
  workload: WorkloadRef | null,
  enabled = true,
): StoredOrLiveRightsizing {
  const stored = useLatestRecommendations(clusterId, enabled);
  const { origin, rec: storedRec } = rightsizingOrigin(
    stored,
    workload ? workloadKey(workload) : undefined,
  );
  const live = useRightsizing(clusterId, namespaces, workload, enabled && origin === 'live');
  const liveReport = origin === 'live' ? (live.data ?? null) : null;
  return useMemo<StoredOrLiveRightsizing>(() => {
    if (origin === 'stored')
      return { origin, report: stored.report, rec: storedRec, run: stored.run, error: null };
    if (origin === 'live')
      return {
        origin,
        report: liveReport,
        rec: workload ? (liveReport?.workloads[0] ?? null) : null,
        run: null,
        error: live.error,
      };
    return { origin, report: null, rec: null, run: null, error: null };
  }, [origin, stored.report, stored.run, storedRec, liveReport, live.error, workload]);
}

/** Recompute every right-sizing report of the cluster (after an apply). */
export function refreshRightsizing(clusterId: ClusterId) {
  refreshPolledPrefix(`${clusterId}|rightsizing|`);
}
