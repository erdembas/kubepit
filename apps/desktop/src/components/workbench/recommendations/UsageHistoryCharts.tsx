import * as i18n from '@/i18n';
import { useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, Info, Loader2, RefreshCw, TriangleAlert, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Select } from '@/components/ui/Select';
import { cn } from '@/lib/cn';
import type { SeriesPoint } from '@/lib/fleet/timeSeries';
import { formatBytes, formatCpu } from '@/lib/format';
import { ipc } from '@/lib/ipc';
import { toSeriesPoints } from '@/lib/prometheus';
import { useAppStore } from '@/store/useAppStore';
import type {
  ClusterId,
  ContainerRecommendation,
  RightsizingReport,
  WorkloadRecommendation,
  WorkloadUsageHistory,
} from '@/types';
import { usePolled } from '../data/polled';
import { TimeSeriesChart, type ChartLine, type ChartRef } from '../overview/TimeSeriesChart';
import {
  cpuValueText,
  historyDays,
  maxOf,
  meanOf,
  pickContainer,
  stepText,
  usageChartsState,
  usageHistoryKey,
  usageRefs,
  type UsageRefKind,
} from './drawerModel';

/**
 * The drawer's Usage tab: one container's CPU and memory over the scan's
 * window, live from Prometheus (`recommendations_usage_history`). The area
 * is the average over the pods, the line the peak; dashed lines mark the
 * current request, the recommended request and the current limit of the
 * scan shown. Gaps stay gaps. Without a connection or Prometheus, a note.
 */

const NO_POINTS: SeriesPoint[] = [];

const REF_STYLE: Record<
  UsageRefKind,
  Omit<ChartRef, 'key' | 'label' | 'value'> & { swatch: string }
> = {
  request: {
    stroke: 'stroke-cat-frontend',
    text: 'fill-cat-frontend',
    swatch: 'bg-cat-frontend',
    dashed: true,
  },
  recommended: {
    stroke: 'stroke-cat-database',
    text: 'fill-cat-database',
    swatch: 'bg-cat-database',
    dashed: true,
  },
  limit: {
    stroke: 'stroke-cat-backend',
    text: 'fill-cat-backend',
    swatch: 'bg-cat-backend',
    dashed: true,
  },
};

const PEAK_STYLE = { stroke: 'stroke-fg/50', text: 'fill-fg-muted', swatch: 'bg-fg/50' };

function refLabel(kind: UsageRefKind): string {
  switch (kind) {
    case 'request':
      return i18n.t('Request');
    case 'recommended':
      return i18n.t('Recommended');
    default:
      return i18n.t('Limit');
  }
}

const WINDOW_FORMAT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};

/** A note in place of the charts. */
export function ChartsNote({
  icon,
  title,
  children,
  tone = 'dim',
  action,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  tone?: 'dim' | 'error';
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-app flex items-start gap-2.5 border px-3 py-2.5 text-[11.5px]',
        tone === 'error'
          ? 'border-status-error/30 bg-status-error/[0.06]'
          : 'border-border/60 bg-fg/[0.02]',
      )}
    >
      <span
        className={cn(
          'mt-0.5 shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5',
          tone === 'error' ? 'text-status-error' : 'text-fg-dim',
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn('font-medium', tone === 'error' ? 'text-status-error' : 'text-fg-muted')}>
          {title}
        </p>
        {children && (
          <div
            className={cn(
              'mt-0.5 break-words',
              tone === 'error' ? 'text-status-error/90 font-mono text-[11px]' : 'text-fg-dim',
            )}
          >
            {children}
          </div>
        )}
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  );
}

/** A container picker (only when the workload has more than one). */
export function ContainerPicker({
  rec,
  value,
  onChange,
}: {
  rec: WorkloadRecommendation;
  value: string | null;
  onChange: (name: string) => void;
}) {
  i18n.useLocale();
  if (rec.containers.length < 2)
    return (
      <span
        className="text-fg-muted min-w-0 truncate text-[11.5px] font-medium"
        title={value ?? ''}
      >
        {value}
      </span>
    );
  return (
    <Select
      value={value ?? ''}
      onChange={onChange}
      ariaLabel={i18n.t('Container')}
      options={rec.containers.map((c) => ({ value: c.name, label: c.name }))}
      className="max-w-48 min-w-0"
    />
  );
}

function ChartHeader({ label, summary }: { label: string; summary: string | null }) {
  return (
    <div className="mb-1 flex items-baseline gap-2">
      <span className="text-fg-dim text-[10.5px] font-semibold tracking-[0.08em] uppercase">
        {label}
      </span>
      {summary && (
        <span className="text-fg-dim ml-auto truncate text-[10.5px] tabular-nums">{summary}</span>
      )}
    </div>
  );
}

function Overlay({ children, tone = 'dim' }: { children: ReactNode; tone?: 'dim' | 'error' }) {
  return (
    <span
      className={cn(
        'flex max-w-xs items-center gap-1.5 text-center text-[11px]',
        tone === 'error' ? 'text-status-error' : 'text-fg-dim',
      )}
    >
      {children}
    </span>
  );
}

function LegendSwatch({
  swatch,
  dashed,
  area,
}: {
  swatch: string;
  dashed?: boolean;
  area?: boolean;
}) {
  if (area) return <span className="bg-accent/35 border-accent h-2 w-3 rounded-sm border-t-2" />;
  if (dashed)
    return (
      <span className="flex w-3 gap-px" aria-hidden>
        <span className={cn('h-[2px] flex-1 rounded-full', swatch)} />
        <span className={cn('h-[2px] flex-1 rounded-full', swatch)} />
      </span>
    );
  return <span className={cn('h-[2px] w-3 rounded-full', swatch)} aria-hidden />;
}

/** "How to read these measurements" (KubeFit's three paragraphs, reworded). */
function HowToRead({
  rec,
  podFilter,
}: {
  rec: WorkloadRecommendation;
  podFilter: WorkloadUsageHistory['pod_filter'] | null;
}) {
  i18n.useLocale();
  const byPattern = podFilter ? podFilter === 'pattern' : rec.pods_truncated || !rec.pods.length;
  return (
    <details className="group">
      <summary className="text-fg-muted hover:text-fg flex w-fit cursor-pointer list-none items-center gap-1 text-[11.5px] font-medium select-none [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
        {i18n.t('How to read these measurements')}
      </summary>
      <div className="text-fg-dim mt-1.5 space-y-1.5 pl-4 text-[11.5px] leading-relaxed">
        <p>
          {byPattern
            ? i18n.t(
                'The scan saw more pods than it keeps names for, so the charts follow every pod whose name matches the workload. Each point averages the pods that have samples at that time, per container: it is not a sum across replicas.',
              )
            : i18n.plural(
                'The charts follow the {count} pod the scan observed; pods started since then join at the next scan. Each point averages the pods that have samples at that time, per container: it is not a sum across replicas.',
                'The charts follow the {count} pods the scan observed; pods started since then join at the next scan. Each point averages the pods that have samples at that time, per container: it is not a sum across replicas.',
                rec.pods.length,
              )}
        </p>
        <p>
          {i18n.t(
            'CPU is the usage rate over 5 minutes; memory is the working set. The line is the peak: the highest 5-minute CPU rate of any pod and the highest memory sample within each point’s interval. Shorter CPU spikes may not show at this resolution.',
          )}
        </p>
        <p>
          {i18n.t(
            'Gaps are intervals without samples: they are neither counted as zero nor joined in the chart. The dashed lines are the current request and limit and the recommended request of the scan, not how the requests changed over time.',
          )}
        </p>
      </div>
    </details>
  );
}

export function UsageHistoryCharts({
  clusterId,
  rec,
  report,
  runId = null,
  past = false,
  connected,
  container,
  onContainerChange,
}: {
  clusterId: ClusterId;
  rec: WorkloadRecommendation;
  report: RightsizingReport;
  runId?: number | null;
  /** A past run is shown: the charts stay live, the reference lines are that run's. */
  past?: boolean;
  /** The cluster is connected (omitted: read from the app's connection status). */
  connected?: boolean;
  /** The picked container (controlled by the drawer; uncontrolled when omitted). */
  container?: string | null;
  onContainerChange?: (name: string) => void;
}) {
  i18n.useLocale();
  const [ownPick, setOwnPick] = useState<string | null>(null);
  const name = pickContainer(rec, container !== undefined ? container : ownPick);
  const pick = onContainerChange ?? setOwnPick;
  const current: ContainerRecommendation | undefined = rec.containers.find((c) => c.name === name);
  const live = useAppStore((s) => s.statuses[clusterId]?.state === 'connected');
  const state = usageChartsState(report, connected ?? live);
  const days = historyDays(report);
  const ready = state === 'ready' && !!name;

  const history = usePolled<WorkloadUsageHistory>(
    ready ? usageHistoryKey(clusterId, rec, name, days, runId, report) : null,
    () => ipc.recommendationsUsageHistory(clusterId, rec, name!, days),
    null,
    ready,
  );
  const data = history.data;
  const series = useMemo(
    () => ({
      cpuAvg: data ? toSeriesPoints(data.cpu_avg) : NO_POINTS,
      cpuPeak: data ? toSeriesPoints(data.cpu_peak) : NO_POINTS,
      memoryAvg: data ? toSeriesPoints(data.memory_avg) : NO_POINTS,
      memoryPeak: data ? toSeriesPoints(data.memory_peak) : NO_POINTS,
    }),
    [data],
  );

  if (state === 'disconnected')
    return (
      <ChartsNote icon={<Unplug />} title={i18n.t('Usage history needs a connection')}>
        {i18n.t(
          'The charts read Prometheus live. Connect to the cluster to see them; the stored recommendation stays on the other tabs.',
        )}
      </ChartsNote>
    );
  if (state === 'metrics-server' || state === 'no-source')
    return (
      <ChartsNote icon={<Info />} title={i18n.t('No usage history for this scan')}>
        {state === 'metrics-server'
          ? i18n.t(
              'This scan used metrics-server, which keeps only the last hour. The usage charts need Prometheus with days of history.',
            )
          : i18n.t('This scan had no usage source. The usage charts need Prometheus.')}
      </ChartsNote>
    );
  if (!current) return null;

  if (history.error && !data)
    return (
      <ChartsNote
        icon={<TriangleAlert />}
        tone="error"
        title={i18n.t('The usage history could not be read')}
        action={
          <Button size="xs" variant="secondary" onClick={() => void history.refresh()}>
            {i18n.t('Try again')}
          </Button>
        }
      >
        {history.error}
      </ChartsNote>
    );

  const from = data?.start ?? report.window_end - days * 86_400_000;
  const to = data?.end ?? report.window_end;
  const intervalMs = (data?.step_secs ?? 3600) * 1000;
  const refsOf = (resource: 'cpu' | 'memory'): ChartRef[] =>
    usageRefs(current, resource).map((r) => ({
      key: r.key,
      label: refLabel(r.key),
      value: r.value,
      stroke: REF_STYLE[r.key].stroke,
      text: REF_STYLE[r.key].text,
      dashed: true,
    }));
  const peakLine = (points: SeriesPoint[]): ChartLine[] =>
    points.length
      ? [{ key: 'peak', label: i18n.t('Peak'), ratio: false, points, ...PEAK_STYLE }]
      : [];
  const overlay = (avg: SeriesPoint[], peak: SeriesPoint[]): ReactNode => {
    if (!data)
      return (
        <Overlay>
          <Loader2 className="h-3 w-3 animate-spin" />
          {i18n.t('Loading…')}
        </Overlay>
      );
    if (!avg.length && !peak.length)
      return <Overlay>{i18n.t('No samples for this container in the window.')}</Overlay>;
    return null;
  };
  const summary = (avg: SeriesPoint[], peak: SeriesPoint[], format: (v: number) => string) => {
    const mean = meanOf(avg);
    const max = maxOf(peak);
    if (mean == null && max == null) return null;
    return i18n.t('average {average} · peak {peak}', {
      average: mean == null ? '—' : format(mean),
      peak: max == null ? '—' : format(max),
    });
  };
  const chart = (
    resource: 'cpu' | 'memory',
    avg: SeriesPoint[],
    peak: SeriesPoint[],
    format: (v: number) => string,
    tick: (v: number) => string,
  ) => {
    const label = resource === 'cpu' ? i18n.t('CPU') : i18n.t('Memory');
    const floor = resource === 'cpu' ? 10 : 16 * 1024 ** 2;
    return (
      <div className="min-w-0">
        <ChartHeader label={label} summary={data ? summary(avg, peak, format) : null} />
        <TimeSeriesChart
          points={avg}
          from={from}
          to={to}
          intervalMs={intervalMs}
          formatTick={tick}
          formatValue={format}
          binary={resource === 'memory'}
          // The peak line always fits; references far above it are named at the top.
          minScale={Math.max(floor, maxOf(peak) ?? 0)}
          refs={refsOf(resource)}
          lines={peakLine(peak)}
          height={128}
          label={i18n.t('{resource} average', { resource: label })}
          overlay={overlay(avg, peak)}
        />
      </div>
    );
  };

  const legend: Array<{
    key: string;
    label: string;
    swatch: string;
    dashed?: boolean;
    area?: boolean;
  }> = [
    { key: 'avg', label: i18n.t('Average'), swatch: 'bg-accent', area: true },
    { key: 'peak', label: i18n.t('Peak'), swatch: PEAK_STYLE.swatch },
    ...(['request', 'recommended', 'limit'] as const).map((key) => ({
      key,
      label: refLabel(key),
      swatch: REF_STYLE[key].swatch,
      dashed: true,
    })),
  ];

  return (
    <div className="space-y-3">
      <div className="space-y-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <ContainerPicker rec={rec} value={name} onChange={pick} />
          <IconButton
            className="ml-auto"
            size="xs"
            label={i18n.t('Reload the usage history')}
            icon={history.loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            disabled={history.loading}
            onClick={() => void history.refresh()}
          />
        </div>
        <p className="text-fg-dim text-[10.5px] tabular-nums">
          {data
            ? `${i18n.date(data.start, WINDOW_FORMAT)} – ${i18n.date(data.end, WINDOW_FORMAT)} · ${stepText(data.step_secs)}`
            : i18n.plural('Last {count} day', 'Last {count} days', days)}
        </p>
      </div>
      {past && (
        <ChartsNote icon={<Info />} title={i18n.t('Live from Prometheus')}>
          {i18n.plural(
            'The charts show the last {count} day up to now, not the window of this past scan; the dashed lines are this scan’s values.',
            'The charts show the last {count} days up to now, not the window of this past scan; the dashed lines are this scan’s values.',
            days,
          )}
        </ChartsNote>
      )}
      {data && data.warnings.length > 0 && (
        <ChartsNote
          icon={<TriangleAlert />}
          title={i18n.t('Prometheus answered with warnings; the charts may be incomplete.')}
        >
          <ul className="space-y-0.5 font-mono text-[10.5px]">
            {data.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </ChartsNote>
      )}
      {history.error && data && (
        <p className="text-status-error text-[11px] break-words">{history.error}</p>
      )}
      {chart('cpu', series.cpuAvg, series.cpuPeak, cpuValueText, formatCpu)}
      {chart('memory', series.memoryAvg, series.memoryPeak, formatBytes, formatBytes)}
      <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {legend.map((l) => (
          <li key={l.key} className="text-fg-muted flex items-center gap-1.5 text-[10.5px]">
            <LegendSwatch swatch={l.swatch} dashed={l.dashed} area={l.area} />
            {l.label}
          </li>
        ))}
      </ul>
      <HowToRead rec={rec} podFilter={data?.pod_filter ?? null} />
    </div>
  );
}
