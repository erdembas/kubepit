import type { ClusterId, MetricsHistoryQuery, PrometheusTarget } from '@/types';
import { MetricsSourceNote } from './PrometheusControls';
import { PrometheusUsage, mainQuery } from './PrometheusUsage';
import { UsageHistory, type RefKey, type UsageRefs } from './UsageHistory';
import { useMetricsHistory } from './useMetricsHistory';
import { usePrometheusMetrics, usePrometheusStatus, usePromRange } from './usePrometheus';

/**
 * Usage charts from the best available source: Prometheus when the
 * cluster has one (longer ranges, network, filesystem, restarts),
 * otherwise the metrics-server history exactly as before. A subtle note
 * underneath names the source.
 */
export function UsageMetrics({
  clusterId,
  historyQuery,
  promTarget,
  enabled,
  refs,
  defaultRefs,
  prefsKey,
  layout = 'stack',
  height = 120,
}: {
  clusterId: ClusterId;
  /** metrics-server series (null while unknown, e.g. a workload's pods). */
  historyQuery: MetricsHistoryQuery | null;
  promTarget: PrometheusTarget | null;
  enabled: boolean;
  refs: UsageRefs;
  defaultRefs: RefKey[];
  prefsKey: string;
  layout?: 'row' | 'stack';
  height?: number;
}) {
  const status = usePrometheusStatus(clusterId, enabled).data;
  const prom = status?.state === 'available' && !!promTarget;
  const range = usePromRange();
  // Same polled entry as the charts (shared by key): no extra request.
  const metrics = usePrometheusMetrics(clusterId, prom ? promTarget : null, [], range, enabled);
  const history = useMetricsHistory(clusterId, prom ? null : historyQuery, enabled);
  return (
    <div className="space-y-2.5">
      {prom ? (
        <PrometheusUsage
          clusterId={clusterId}
          target={promTarget}
          enabled={enabled}
          refs={refs}
          defaultRefs={defaultRefs}
          prefsKey={prefsKey}
          layout={layout}
          height={height}
        />
      ) : (
        <UsageHistory
          clusterId={clusterId}
          query={historyQuery}
          enabled={enabled}
          refs={refs}
          defaultRefs={defaultRefs}
          prefsKey={prefsKey}
          layout={layout}
          height={height}
        />
      )}
      <MetricsSourceNote
        clusterId={clusterId}
        status={status}
        query={mainQuery(metrics.data)}
        historyAvailable={prom || history.data?.available !== false}
      />
    </div>
  );
}
