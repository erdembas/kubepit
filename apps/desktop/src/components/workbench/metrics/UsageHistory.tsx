import * as i18n from '@/i18n';
import { useMemo, useState, type ReactNode } from 'react';
import { CircleSlash, Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatBytes, formatCpu } from '@/lib/format';
import { RANGES, lastValue, peak, type SeriesPoint } from '@/lib/fleet/timeSeries';
import type { ClusterId, MetricsHistoryQuery, MetricsSeries } from '@/types';
import { TimeSeriesChart, type ChartRef } from '../overview/TimeSeriesChart';
import { setHistoryRange, useHistoryRange, useMetricsHistory } from './useMetricsHistory';

/**
 * CPU + memory history block shared by the cluster overview and the node,
 * pod and workload details: two charts, a legend whose reference lines can
 * be toggled, and "collecting" / "unavailable" states.
 */

export type RefKey = 'requests' | 'limits' | 'allocatable' | 'capacity';

export interface UsageRefs {
  cpu: Partial<Record<RefKey, number>>;
  memory: Partial<Record<RefKey, number>>;
}

export const REF_ORDER: RefKey[] = ['requests', 'limits', 'allocatable', 'capacity'];

export function refMeta(key: RefKey): Omit<ChartRef, 'value'> & { swatch: string } {
  switch (key) {
    case 'requests':
      return {
        key,
        label: i18n.t('Requests'),
        stroke: 'stroke-cat-frontend',
        text: 'fill-cat-frontend',
        swatch: 'bg-cat-frontend',
        dashed: true,
      };
    case 'limits':
      return {
        key,
        label: i18n.t('Limits'),
        stroke: 'stroke-cat-backend',
        text: 'fill-cat-backend',
        swatch: 'bg-cat-backend',
        dashed: true,
      };
    case 'allocatable':
      return {
        key,
        label: i18n.t('Allocatable'),
        stroke: 'stroke-fg/35',
        text: 'fill-fg-dim',
        swatch: 'bg-fg/35',
      };
    case 'capacity':
      return {
        key,
        label: i18n.t('Capacity'),
        stroke: 'stroke-fg/20',
        text: 'fill-fg-dim',
        swatch: 'bg-fg/20',
      };
  }
}

/** CPU with its unit: `250m`, or `1.5 cores` above one core. */
export function cpuWithUnit(millicores: number): string {
  return millicores < 1000
    ? formatCpu(millicores)
    : i18n.t('{cpu} cores', { cpu: formatCpu(millicores) });
}

export function usePersistentRefs(storageKey: string, fallback: RefKey[]) {
  const [visible, setVisible] = useState<RefKey[]>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) return parsed.filter((k): k is RefKey => REF_ORDER.includes(k));
    } catch {
      /* storage unavailable */
    }
    return fallback;
  });
  const toggle = (key: RefKey) =>
    setVisible((current) => {
      const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* keep it for this session */
      }
      return next;
    });
  return [visible, toggle] as const;
}

/** 15m · 30m · 60m segmented control; one preference for every chart. */
export function RangeToggle() {
  i18n.useLocale();
  const range = useHistoryRange();
  return (
    <div className="bg-fg/4 inline-flex gap-0.5 rounded-md p-0.5" role="group">
      {RANGES.map((minutes) => (
        <button
          key={minutes}
          type="button"
          aria-pressed={range === minutes}
          onClick={() => setHistoryRange(minutes)}
          title={i18n.t('Last {minutes} minutes', { minutes })}
          className={cn(
            'rounded px-1.5 py-px text-[10.5px] tabular-nums transition-colors',
            range === minutes
              ? 'bg-surface-raised text-fg font-medium shadow-sm'
              : 'text-fg-dim hover:text-fg',
          )}
        >
          {i18n.t('{minutes}m', { minutes })}
        </button>
      ))}
    </div>
  );
}

/** What the plot area says when there is no line to draw. */
function overlayFor(
  series: MetricsSeries | undefined,
  count: number,
  loading: boolean,
  error: string | null,
): ReactNode {
  if (!series) {
    if (error) return <span className="text-status-error text-[11px]">{error}</span>;
    return (
      <span className="text-fg-dim flex items-center gap-1.5 text-[11px]">
        <Loader2 className="h-3 w-3 animate-spin" />
        {i18n.t('Loading…')}
      </span>
    );
  }
  if (count < 2)
    return (
      <span className="text-fg-dim flex max-w-xs flex-col items-center gap-1 text-center text-[11px]">
        <span className="text-fg-muted flex items-center gap-1.5 font-medium">
          <span className="bg-accent h-1.5 w-1.5 animate-pulse rounded-full" />
          {loading && count === 0 ? i18n.t('Loading…') : i18n.t('Collecting samples…')}
        </span>
        {i18n.t('History builds up every 15 seconds while the cluster stays connected.')}
      </span>
    );
  return null;
}

function ChartHeader({ label, now, peakValue }: { label: string; now: string; peakValue: string }) {
  i18n.useLocale();
  return (
    <div className="mb-1 flex items-baseline gap-2">
      <span className="text-fg-dim text-[10.5px] font-semibold tracking-[0.08em] uppercase">
        {label}
      </span>
      <span className="text-fg text-[13px] font-semibold tabular-nums">{now}</span>
      <span className="text-fg-dim ml-auto text-[10.5px] tabular-nums">
        {i18n.t('peak {value}', { value: peakValue })}
      </span>
    </div>
  );
}

export function UsageHistory({
  clusterId,
  query,
  enabled,
  refs,
  defaultRefs,
  prefsKey,
  layout = 'stack',
  height = 120,
}: {
  clusterId: ClusterId;
  query: MetricsHistoryQuery | null;
  enabled: boolean;
  refs: UsageRefs;
  /** Reference lines shown until the user toggles them. */
  defaultRefs: RefKey[];
  /** Remembers the toggled reference lines per surface (overview, node, pod…). */
  prefsKey: string;
  layout?: 'row' | 'stack';
  height?: number;
}) {
  i18n.useLocale();
  const state = useMetricsHistory(clusterId, query, enabled);
  const range = useHistoryRange();
  const [visibleRefs, toggleRef] = usePersistentRefs(`kp.metrics.refs.${prefsKey}`, defaultRefs);
  const series = state.data;
  const to = Math.max(state.updatedAt || Date.now(), series?.points.at(-1)?.ts ?? 0);
  const from = to - range * 60_000;
  const intervalMs = (series?.interval_secs ?? 15) * 1000;

  const cpu = useMemo<SeriesPoint[]>(
    () => series?.points.map((p) => ({ t: p.ts, v: p.cpu_millicores })) ?? [],
    [series],
  );
  const memory = useMemo<SeriesPoint[]>(
    () => series?.points.map((p) => ({ t: p.ts, v: p.memory_bytes })) ?? [],
    [series],
  );
  const inRange = cpu.filter((p) => p.t >= from).length;

  const available = REF_ORDER.filter(
    (key) => (refs.cpu[key] ?? 0) > 0 || (refs.memory[key] ?? 0) > 0,
  );
  const chartRefs = (values: UsageRefs['cpu']): ChartRef[] =>
    available
      .filter((key) => visibleRefs.includes(key) && (values[key] ?? 0) > 0)
      .map((key) => ({ ...refMeta(key), value: values[key]! }));
  const overlay = overlayFor(series, inRange, state.loading, state.error);
  const inWindow = (points: SeriesPoint[]) => points.filter((p) => p.t >= from);
  const cpuNow = lastValue(cpu);
  const memNow = lastValue(memory);

  if (series && !series.available)
    return (
      <p className="text-fg-dim flex items-center gap-2 text-[12px]">
        <CircleSlash className="h-3.5 w-3.5 shrink-0" />
        {i18n.t('metrics-server is not available on this cluster, so there is no usage history.')}
      </p>
    );

  return (
    <div className="space-y-3">
      <div className={cn('grid gap-4', layout === 'row' && 'lg:grid-cols-2')}>
        <div className="min-w-0">
          <ChartHeader
            label={i18n.t('CPU')}
            now={cpuNow !== null && !overlay ? cpuWithUnit(cpuNow) : '—'}
            peakValue={overlay ? '—' : cpuWithUnit(peak(inWindow(cpu)))}
          />
          <TimeSeriesChart
            points={cpu}
            from={from}
            to={to}
            intervalMs={intervalMs}
            formatTick={formatCpu}
            formatValue={cpuWithUnit}
            minScale={10}
            refs={chartRefs(refs.cpu)}
            height={height}
            label={i18n.t('CPU')}
            overlay={overlay}
          />
        </div>
        <div className="min-w-0">
          <ChartHeader
            label={i18n.t('Memory')}
            now={memNow !== null && !overlay ? formatBytes(memNow) : '—'}
            peakValue={overlay ? '—' : formatBytes(peak(inWindow(memory)))}
          />
          <TimeSeriesChart
            points={memory}
            from={from}
            to={to}
            intervalMs={intervalMs}
            formatTick={formatBytes}
            formatValue={formatBytes}
            binary
            minScale={16 * 1024 ** 2}
            refs={chartRefs(refs.memory)}
            height={height}
            label={i18n.t('Memory')}
            overlay={overlay}
          />
        </div>
      </div>
      {available.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-fg-muted flex items-center gap-1.5 px-1 text-[10.5px]">
            <span className="bg-accent h-[3px] w-3 rounded-full" aria-hidden />
            {i18n.t('Usage')}
          </span>
          {available.map((key) => {
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
    </div>
  );
}
