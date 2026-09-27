import * as i18n from '@/i18n';
import { useMemo, type ReactNode } from 'react';
import { ChartSpline, Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatBytes, formatCpu } from '@/lib/format';
import { lastValue, peak, type SeriesPoint } from '@/lib/fleet/timeSeries';
import { PROM_RANGE_MS, toSeriesPoints } from '@/lib/prometheus';
import { dock } from '@/store/useDockStore';
import type {
  ClusterId,
  PrometheusMetric,
  PrometheusMetricsResult,
  PrometheusTarget,
} from '@/types';
import { TimeSeriesChart, type ChartLine, type ChartRef } from '../overview/TimeSeriesChart';
import {
  REF_ORDER,
  cpuWithUnit,
  refMeta,
  usePersistentRefs,
  type RefKey,
  type UsageRefs,
} from './UsageHistory';
import { usePrometheusMetrics, usePromRange } from './usePrometheus';

/**
 * The usage block when Prometheus is the source: CPU and memory with
 * requests / limits as they changed over time (falling back to the
 * object's current values), plus network, filesystem, volumes and
 * restarts when Prometheus has those series. PVCs show their volume.
 */

const EMPTY: SeriesPoint[] = [];

function bytesPerSecond(v: number) {
  return i18n.t('{value}/s', { value: formatBytes(v) });
}

function countValue(v: number) {
  return i18n.number(v, { maximumFractionDigits: v < 10 ? 1 : 0 });
}

/** `2m`, `1h` — like the Age column. */
function windowLabel(secs: number) {
  return secs < 3600 ? `${Math.round(secs / 60)}m` : `${Math.round(secs / 3600)}h`;
}

function Header({
  label,
  now,
  peakValue,
  onOpen,
}: {
  label: string;
  now: string;
  peakValue: string;
  onOpen?: () => void;
}) {
  i18n.useLocale();
  return (
    <div className="group mb-1 flex items-baseline gap-2">
      <span className="text-fg-dim text-[10.5px] font-semibold tracking-[0.08em] uppercase">
        {label}
      </span>
      <span className="text-fg text-[13px] font-semibold tabular-nums">{now}</span>
      <span className="text-fg-dim ml-auto text-[10.5px] tabular-nums">
        {i18n.t('peak {value}', { value: peakValue })}
      </span>
      {onOpen && (
        <button
          type="button"
          onClick={onOpen}
          title={i18n.t('Open in a PromQL tab')}
          aria-label={i18n.t('Open in a PromQL tab')}
          className="text-fg-dim hover:text-fg hover:bg-fg/5 -my-1 flex h-4 w-4 items-center justify-center self-center rounded opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
        >
          <ChartSpline className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function Message({ children, tone = 'dim' }: { children: ReactNode; tone?: 'dim' | 'error' }) {
  return (
    <span
      className={cn(
        'flex max-w-sm flex-col items-center gap-1 text-center text-[11px]',
        tone === 'error' ? 'text-status-error' : 'text-fg-dim',
      )}
    >
      {children}
    </span>
  );
}

function useSeries(result: PrometheusMetricsResult | undefined) {
  return useMemo(() => {
    const map = new Map<PrometheusMetric, SeriesPoint[]>();
    for (const s of result?.series ?? []) map.set(s.metric, toSeriesPoints(s.points));
    return map;
  }, [result]);
}

export function PrometheusUsage({
  clusterId,
  target,
  enabled,
  refs,
  defaultRefs,
  prefsKey,
  layout = 'stack',
  height = 120,
}: {
  clusterId: ClusterId;
  target: PrometheusTarget;
  enabled: boolean;
  /** The object's current requests / limits / allocatable / capacity. */
  refs: UsageRefs;
  defaultRefs: RefKey[];
  prefsKey: string;
  layout?: 'row' | 'stack';
  height?: number;
}) {
  i18n.useLocale();
  const range = usePromRange();
  const state = usePrometheusMetrics(clusterId, target, [], range, enabled);
  const [visibleRefs, toggleRef] = usePersistentRefs(`kp.metrics.refs.${prefsKey}`, defaultRefs);
  const result = state.data;
  const byMetric = useSeries(result);
  const points = (m: PrometheusMetric) => byMetric.get(m) ?? EMPTY;
  const hasSeries = (m: PrometheusMetric) => points(m).length > 0;
  const info = (m: PrometheusMetric) => result?.series.find((s) => s.metric === m);
  const to = Math.max(state.updatedAt || Date.now(), result?.end ?? 0);
  const from = to - PROM_RANGE_MS[range];
  const intervalMs = (result?.step_secs ?? 15) * 1000;
  const inRange = (pts: SeriesPoint[]) => pts.filter((p) => p.t >= from);
  const open = (m: PrometheusMetric) => {
    const query = info(m)?.query;
    return query ? () => dock.promql(clusterId, query, range) : undefined;
  };

  const overlayFor = (metric: PrometheusMetric): ReactNode => {
    if (!result) {
      if (state.error) return <Message tone="error">{state.error}</Message>;
      return (
        <span className="text-fg-dim flex items-center gap-1.5 text-[11px]">
          <Loader2 className="h-3 w-3 animate-spin" />
          {i18n.t('Loading…')}
        </span>
      );
    }
    const error = info(metric)?.error;
    if (error) return <Message tone="error">{error}</Message>;
    if (!inRange(points(metric)).length)
      return (
        <Message>
          <span className="text-fg-muted font-medium">
            {i18n.t('No data from Prometheus in this range')}
          </span>
          {i18n.t('Kubepit reads the cAdvisor, node-exporter and kube-state-metrics series.')}
        </Message>
      );
    return null;
  };

  // Requests and limits as they changed; the object's current values when
  // kube-state-metrics has no series for them.
  const lineFor = (metric: PrometheusMetric, key: 'requests' | 'limits'): ChartLine[] => {
    if (!hasSeries(metric) || !visibleRefs.includes(key)) return [];
    const { swatch, ...meta } = refMeta(key);
    return [{ ...meta, swatch, points: points(metric) }];
  };
  const refsFor = (
    values: UsageRefs['cpu'],
    requests: PrometheusMetric,
    limits: PrometheusMetric,
  ): ChartRef[] =>
    REF_ORDER.filter((key) => visibleRefs.includes(key) && (values[key] ?? 0) > 0)
      .filter(
        (key) =>
          !(key === 'requests' && hasSeries(requests)) && !(key === 'limits' && hasSeries(limits)),
      )
      .map((key) => ({ ...refMeta(key), value: values[key]! }));
  const legendKeys = REF_ORDER.filter(
    (key) =>
      (refs.cpu[key] ?? 0) > 0 ||
      (refs.memory[key] ?? 0) > 0 ||
      (key === 'requests' && (hasSeries('cpu_requests') || hasSeries('memory_requests'))) ||
      (key === 'limits' && (hasSeries('cpu_limits') || hasSeries('memory_limits'))),
  );

  const chart = (
    metric: PrometheusMetric,
    label: string,
    format: (v: number) => string,
    options: {
      tick?: (v: number) => string;
      binary?: boolean;
      minScale?: number;
      lines?: ChartLine[];
      refs?: ChartRef[];
      now?: string;
      chartHeight?: number;
      tooltipLabel?: string;
    } = {},
  ) => {
    const pts = points(metric);
    const overlay = overlayFor(metric);
    const now = lastValue(pts);
    return (
      <div key={metric} className="min-w-0">
        <Header
          label={label}
          now={overlay ? '—' : (options.now ?? (now !== null ? format(now) : '—'))}
          peakValue={overlay ? '—' : format(peak(inRange(pts)))}
          onOpen={open(metric)}
        />
        <TimeSeriesChart
          points={pts}
          from={from}
          to={to}
          intervalMs={intervalMs}
          formatTick={options.tick ?? format}
          formatValue={format}
          binary={options.binary}
          minScale={options.minScale ?? 1}
          refs={options.refs}
          lines={options.lines}
          height={options.chartHeight ?? height}
          label={options.tooltipLabel ?? label}
          overlay={overlay}
        />
      </div>
    );
  };

  const extraHeight = Math.max(80, Math.round(height * 0.72));
  const capacityLine = (metric: PrometheusMetric): ChartLine[] =>
    hasSeries(metric)
      ? [
          {
            key: metric,
            label: i18n.t('Capacity'),
            stroke: 'stroke-fg/35',
            text: 'fill-fg-dim',
            swatch: 'bg-fg/35',
            dashed: true,
            points: points(metric),
          },
        ]
      : [];
  const lastOf = (m: PrometheusMetric) => lastValue(points(m));

  if (target.kind === 'pvc')
    return chart('volume_usage', i18n.t('Volume usage'), formatBytes, {
      binary: true,
      minScale: 1024 ** 2,
      lines: capacityLine('volume_capacity'),
    });

  const extras: ReactNode[] = [];
  if (result && inRange(points('network_rx')).length) {
    const rx = lastOf('network_rx');
    const tx = lastOf('network_tx');
    extras.push(
      chart('network_rx', i18n.t('Network'), bytesPerSecond, {
        tick: formatBytes,
        binary: true,
        minScale: 1024,
        chartHeight: extraHeight,
        tooltipLabel: i18n.t('Receive'),
        now: `↓ ${rx !== null ? bytesPerSecond(rx) : '—'}  ↑ ${tx !== null ? bytesPerSecond(tx) : '—'}`,
        lines: hasSeries('network_tx')
          ? [
              {
                key: 'tx',
                label: i18n.t('Transmit'),
                stroke: 'stroke-cat-frontend',
                text: 'fill-cat-frontend',
                swatch: 'bg-cat-frontend',
                ratio: false,
                points: points('network_tx'),
              },
            ]
          : [],
      }),
    );
  }
  if (result && inRange(points('fs_usage')).length)
    extras.push(
      chart('fs_usage', i18n.t('Filesystem'), formatBytes, {
        binary: true,
        minScale: 1024 ** 2,
        chartHeight: extraHeight,
        lines: capacityLine('fs_capacity'),
      }),
    );
  if (result && inRange(points('volume_usage')).length)
    extras.push(
      chart('volume_usage', i18n.t('Volumes'), formatBytes, {
        binary: true,
        minScale: 1024 ** 2,
        chartHeight: extraHeight,
        lines: capacityLine('volume_capacity'),
      }),
    );
  if (result && inRange(points('restarts')).length)
    extras.push(
      chart('restarts', i18n.t('Restarts'), countValue, {
        minScale: 1,
        chartHeight: extraHeight,
        tooltipLabel: i18n.t('Restarts per {window}', {
          window: windowLabel(result.rate_window_secs),
        }),
      }),
    );

  return (
    <div className="space-y-3">
      <div className={cn('grid gap-4', layout === 'row' && 'lg:grid-cols-2')}>
        {chart('cpu_usage', i18n.t('CPU'), cpuWithUnit, {
          tick: formatCpu,
          minScale: 10,
          lines: [...lineFor('cpu_requests', 'requests'), ...lineFor('cpu_limits', 'limits')],
          refs: refsFor(refs.cpu, 'cpu_requests', 'cpu_limits'),
        })}
        {chart('memory_usage', i18n.t('Memory'), formatBytes, {
          binary: true,
          minScale: 16 * 1024 ** 2,
          lines: [...lineFor('memory_requests', 'requests'), ...lineFor('memory_limits', 'limits')],
          refs: refsFor(refs.memory, 'memory_requests', 'memory_limits'),
        })}
      </div>
      {legendKeys.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-fg-muted flex items-center gap-1.5 px-1 text-[10.5px]">
            <span className="bg-accent h-[3px] w-3 rounded-full" aria-hidden />
            {i18n.t('Usage')}
          </span>
          {legendKeys.map((key) => {
            const meta = refMeta(key);
            const on = visibleRefs.includes(key);
            return (
              <button
                key={key}
                type="button"
                aria-pressed={on}
                onClick={() => toggleRef(key)}
                title={
                  on
                    ? i18n.t('Hide {line}', { line: meta.label })
                    : i18n.t('Show {line}', { line: meta.label })
                }
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[10.5px] transition',
                  on ? 'text-fg-muted hover:bg-fg/5' : 'text-fg-dim/70 hover:bg-fg/5 line-through',
                )}
              >
                <span
                  className={cn('h-[2px] w-3 rounded-full', meta.swatch, !on && 'opacity-40')}
                  aria-hidden
                />
                {meta.label}
              </button>
            );
          })}
        </div>
      )}
      {extras.length > 0 && (
        <div className={cn('grid gap-4 pt-1', layout === 'row' && 'lg:grid-cols-3')}>{extras}</div>
      )}
    </div>
  );
}

/** PromQL of the main chart of `result` (CPU, or the volume of a PVC). */
export function mainQuery(result: PrometheusMetricsResult | undefined): string | null {
  const main = result?.series.find((s) => s.metric === 'cpu_usage' || s.metric === 'volume_usage');
  return main?.query ?? null;
}
