import { runTime, scanStale, workloadKey } from '@/lib/kube/recommendations/model';
import type {
  ClusterDef,
  ClusterId,
  ClusterRecommendationSummary,
  ClusterStatus,
  RecommendationRun,
  RecommendationSummary,
  SummaryEntry,
} from '@/types';

/**
 * The dashboard's fleet recommendations card, kept pure: one row per
 * cluster with a stored scan (a success or a failure, from `history.db`,
 * so disconnected clusters count), the potential saving per currency and
 * the largest opportunities across the fleet.
 */

/** `usePolled` key of `recommendations_fleet` (the card; Settings → History refreshes it after a clear). */
export const RECOMMENDATIONS_FLEET_KEY = 'recommendations|fleet';
/** Its poll: stored scans change when a scan ends (re-read then) or the history is cleared. */
export const RECOMMENDATIONS_FLEET_REFRESH_MS = 5 * 60_000;

export interface FleetRecommendationRow {
  cluster: ClusterDef;
  /** The latest successful run. */
  run: RecommendationRun | null;
  /** The newest failed or interrupted run after it. */
  failure: RecommendationRun | null;
  /** The run's summary, unless its Prometheus configuration changed since (hidden like the view). */
  summary: RecommendationSummary | null;
  sourceChanged: boolean;
  scheduled: boolean;
  connected: boolean;
  /** Disconnected, or scanned longer than twice the interval ago. */
  stale: boolean;
  /** Workloads "Apply" handles in one click here: none on read-only or production clusters. */
  oneClick: number;
}

export function fleetRecommendationRows(
  clusters: readonly ClusterDef[],
  fleet: readonly ClusterRecommendationSummary[],
  statuses: Record<ClusterId, ClusterStatus | undefined>,
  intervalMinutes: number,
  now: number,
): FleetRecommendationRow[] {
  const byId = new Map(fleet.map((f) => [f.cluster_id, f]));
  return clusters.flatMap((cluster) => {
    const entry = byId.get(cluster.id);
    if (!entry || (!entry.run && !entry.last_failure)) return [];
    const connected = statuses[cluster.id]?.state === 'connected';
    const summary = entry.source_changed ? null : (entry.run?.summary ?? null);
    const applies = !cluster.read_only && cluster.environment !== 'production';
    return [
      {
        cluster,
        run: entry.run,
        failure: entry.last_failure,
        summary,
        sourceChanged: entry.source_changed,
        scheduled: entry.scheduled,
        connected,
        stale: !!entry.run && scanStale(runTime(entry.run), connected, intervalMinutes, now),
        oneClick: applies ? (summary?.one_click ?? 0) : 0,
      },
    ];
  });
}

export interface CurrencyAmount {
  currency: string;
  amount: number;
}

/** Monthly savings of the shown summaries, per currency (largest first). */
export function fleetSavings(rows: readonly FleetRecommendationRow[]): CurrencyAmount[] {
  const totals = new Map<string, number>();
  for (const { summary } of rows) {
    if (!summary || summary.monthly_savings <= 0) continue;
    totals.set(summary.currency, (totals.get(summary.currency) ?? 0) + summary.monthly_savings);
  }
  return [...totals]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => b.amount - a.amount || a.currency.localeCompare(b.currency));
}

export interface FleetTopEntry extends SummaryEntry {
  clusterId: ClusterId;
  clusterName: string;
  currency: string;
  /** `workloadKey` (opens the row in the Recommendations view). */
  key: string;
}

/**
 * "Top across the fleet": every shown summary's spotlight entries merged
 * by monthly delta (the largest saving first, increases last), at most
 * `limit`; ties are broken by cluster and workload so the order is stable.
 */
export function fleetTop(rows: readonly FleetRecommendationRow[], limit = 5): FleetTopEntry[] {
  return rows
    .flatMap(({ cluster, summary }) =>
      (summary?.top ?? []).map((entry) => ({
        ...entry,
        clusterId: cluster.id,
        clusterName: cluster.name,
        currency: summary!.currency,
        key: workloadKey(entry),
      })),
    )
    .sort(
      (a, b) =>
        a.monthly_delta - b.monthly_delta ||
        a.clusterName.localeCompare(b.clusterName) ||
        a.key.localeCompare(b.key),
    )
    .slice(0, limit);
}
