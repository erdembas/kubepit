import * as i18n from '@/i18n';
import { useMemo, useState } from 'react';
import { History, Loader2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { formatBytes, formatCpu } from '@/lib/format';
import { ipc } from '@/lib/ipc';
import { seriesColor } from '@/lib/prometheus';
import { useRecommendationsStore } from '@/store/useRecommendationsStore';
import type { ClusterId, RecommendationTrendPoint, WorkloadRecommendation } from '@/types';
import { usePolled } from '../data/polled';
import { MultiSeriesChart, type MultiSeries } from '../overview/MultiSeriesChart';
import { ChartsNote, ContainerPicker } from './UsageHistoryCharts';
import {
  pickContainer,
  trendInterval,
  trendKey,
  trendRange,
  trendSeries,
  type TrendSeriesKey,
} from './drawerModel';

/**
 * The drawer's History tab: how one container's recommendation moved
 * across the stored scans (`recommendations_trend`: every run of the last
 * 48 hours, then one per day): the request at the time, the recommended
 * request and the usage behind it (CPU p95 / memory peak).
 */

const NO_TREND: RecommendationTrendPoint[] = [];

/** Colours shared with the usage charts: request blue, recommendation green, usage accent. */
const COLOR: Record<TrendSeriesKey, number> = { request: 1, recommended: 3, usage: 0 };

const DATE_FORMAT: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };

function ResourceToggle({
  value,
  onChange,
}: {
  value: 'cpu' | 'memory';
  onChange: (next: 'cpu' | 'memory') => void;
}) {
  i18n.useLocale();
  return (
    <div className="bg-fg/4 inline-flex gap-0.5 rounded-md p-0.5" role="group">
      {(['cpu', 'memory'] as const).map((r) => (
        <button
          key={r}
          type="button"
          aria-pressed={value === r}
          onClick={() => onChange(r)}
          className={cn(
            'rounded px-1.5 py-px text-[10.5px] transition-colors',
            value === r
              ? 'bg-surface-raised text-fg font-medium shadow-sm'
              : 'text-fg-dim hover:text-fg',
          )}
        >
          {r === 'cpu' ? i18n.t('CPU') : i18n.t('Memory')}
        </button>
      ))}
    </div>
  );
}

export function RecommendationTrend({
  clusterId,
  rec,
  runId = null,
  container,
  onContainerChange,
}: {
  clusterId: ClusterId;
  rec: WorkloadRecommendation;
  runId?: number | null;
  /** The picked container (controlled by the drawer; uncontrolled when omitted). */
  container?: string | null;
  onContainerChange?: (name: string) => void;
}) {
  i18n.useLocale();
  const [ownPick, setOwnPick] = useState<string | null>(null);
  const name = pickContainer(rec, container !== undefined ? container : ownPick);
  const pick = onContainerChange ?? setOwnPick;
  const [resource, setResource] = useState<'cpu' | 'memory'>('cpu');
  const latestRunId = useRecommendationsStore(
    (s) => s.byCluster[clusterId]?.latest?.scan?.run.id ?? null,
  );
  const trend = usePolled<RecommendationTrendPoint[]>(
    trendKey(clusterId, rec, runId, latestRunId),
    () =>
      ipc.recommendationsTrend(clusterId, {
        kind: rec.kind,
        namespace: rec.namespace,
        name: rec.name,
      }),
    null,
  );
  const points = trend.data ?? NO_TREND;
  const values = useMemo(
    () => (name ? trendSeries(points, name, resource) : null),
    [points, name, resource],
  );
  const format = resource === 'cpu' ? formatCpu : formatBytes;

  if (trend.error && !trend.data)
    return (
      <ChartsNote
        icon={<TriangleAlert />}
        tone="error"
        title={i18n.t('The stored scans could not be read')}
        action={
          <Button size="xs" variant="secondary" onClick={() => void trend.refresh()}>
            {i18n.t('Try again')}
          </Button>
        }
      >
        {trend.error}
      </ChartsNote>
    );
  if (!trend.data)
    return (
      <div className="text-fg-dim flex items-center justify-center gap-2 py-10 text-[11.5px]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {i18n.t('Loading the stored scans…')}
      </div>
    );
  if (!points.length || !values)
    return (
      <ChartsNote icon={<History />} title={i18n.t('No stored scans of this workload yet')}>
        {i18n.t('Scans keep their rows for a while; the next scan adds the first point.')}
      </ChartsNote>
    );

  const labels: Record<TrendSeriesKey, string> = {
    request: i18n.t('Request'),
    recommended: i18n.t('Recommended'),
    usage: resource === 'cpu' ? i18n.t('CPU p95') : i18n.t('Memory peak'),
  };
  const series: MultiSeries[] = (['request', 'recommended', 'usage'] as const).map((key) => ({
    key,
    label: labels[key],
    points: values[key],
    color: seriesColor(COLOR[key]),
  }));
  const empty = series.every((s) => !s.points.length);
  const { from, to } = trendRange(points);

  return (
    <div className="space-y-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <ContainerPicker rec={rec} value={name} onChange={pick} />
        <ResourceToggle value={resource} onChange={setResource} />
        <span className="text-fg-dim ml-auto text-[10.5px] tabular-nums">
          {i18n.plural(
            '{count} stored scan since {date}',
            '{count} stored scans since {date}',
            points.length,
            {
              date: i18n.date(points[0]!.at, DATE_FORMAT),
            },
          )}
        </span>
      </div>
      <MultiSeriesChart
        series={series}
        from={from}
        to={to}
        intervalMs={trendInterval(points)}
        formatValue={format}
        height={180}
        label={i18n.t('Recommendation history')}
        overlay={
          empty ? (
            <span className="text-fg-dim text-[11px]">
              {i18n.t('No values for this container in the stored scans.')}
            </span>
          ) : undefined
        }
      />
      <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {series.map((s) => (
          <li key={s.key} className="text-fg-muted flex items-center gap-1.5 text-[10.5px]">
            <span className={cn('h-2 w-2 shrink-0 rounded-sm', s.color.bg)} aria-hidden />
            {s.label}
          </li>
        ))}
      </ul>
      <p className="text-fg-dim text-[11px]">
        {i18n.t(
          'Every scan of the last 48 hours is kept, then the last successful scan of each day.',
        )}
      </p>
    </div>
  );
}
