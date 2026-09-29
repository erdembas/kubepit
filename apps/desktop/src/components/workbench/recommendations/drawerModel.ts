import * as i18n from '@/i18n/core';
import type { SeriesPoint } from '@/lib/fleet/timeSeries';
import { formatCpu, formatPercent } from '@/lib/format';
import { workloadKey, type ApplyMode } from '@/lib/kube/recommendations/model';
import { coverageLabel } from '@/lib/kube/rightsizing/model';
import type {
  ClusterId,
  ContainerRecommendation,
  EvidenceIdentity,
  HpaInfo,
  RecommendationTrendPoint,
  RightsizingReport,
  UsageEvidence,
  WorkloadRecommendation,
} from '@/types';

/**
 * The detail drawer's view model (pure): which row is open, poll keys,
 * the usage charts' reference lines, the trend's series, the evidence rows
 * and the drawer's apply button.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The row `open` names in the whole report (not the filtered list: other
 * sections and "Open in Recommendations" open rows the list may hide).
 */
export function findRecommendation(
  report: Pick<RightsizingReport, 'workloads'>,
  open: string | null,
): WorkloadRecommendation | null {
  if (!open) return null;
  return report.workloads.find((w) => workloadKey(w) === open) ?? null;
}

/** The container shown first: the picked one if the row has it, else the first that changes. */
export function pickContainer(
  rec: Pick<WorkloadRecommendation, 'containers'>,
  picked: string | null,
): string | null {
  const names = rec.containers.map((c) => c.name);
  if (picked && names.includes(picked)) return picked;
  const changed = rec.containers.find(
    (c) =>
      c.cpu !== 'unchanged' ||
      c.memory !== 'unchanged' ||
      c.cpu_limit !== 'unchanged' ||
      c.memory_limit !== 'unchanged',
  );
  return changed?.name ?? names[0] ?? null;
}

// -- Poll keys ---------------------------------------------------------------------

const versions = new WeakMap<object, number>();
let nextVersion = 1;

/**
 * A number per report object: a re-evaluation (other settings) or a new
 * scan is a new object, so keys built from it refetch what depends on the
 * recommendation (the YAML fragment).
 */
export function reportVersion(report: RightsizingReport): number {
  let v = versions.get(report);
  if (v === undefined) {
    v = nextVersion++;
    versions.set(report, v);
  }
  return v;
}

const run = (runId: number | null) => (runId == null ? 'latest' : String(runId));

// Keys start with `${clusterId}|` like every poll of the workbench: the header's
// Refresh refetches them and a disconnect drops them.

/**
 * Usage history of one container: live from Prometheus, so a re-evaluation
 * keeps it; another scan (other pods behind the row) or run refetches.
 */
export function usageHistoryKey(
  clusterId: ClusterId,
  rec: WorkloadRecommendation,
  container: string,
  days: number,
  runId: number | null,
  report: Pick<RightsizingReport, 'computed_at'>,
): string {
  return `${clusterId}|recs-usage|${workloadKey(rec)}|${container}|${days}|${run(runId)}|${report.computed_at}`;
}

/** The trend across stored scans: a new latest run adds a point. */
export function trendKey(
  clusterId: ClusterId,
  rec: WorkloadRecommendation,
  runId: number | null,
  latestRunId: number | null,
): string {
  return `${clusterId}|recs-trend|${workloadKey(rec)}|${run(runId)}|${latestRunId ?? 0}`;
}

/** The exported fragment follows the re-evaluated recommendation. */
export function yamlKey(
  clusterId: ClusterId,
  rec: WorkloadRecommendation,
  runId: number | null,
  report: RightsizingReport,
): string {
  return `${clusterId}|recs-yaml|${workloadKey(rec)}|${run(runId)}|${reportVersion(report)}`;
}

/** `deployment-shop-checkout.yaml`. */
export function exportFileName(rec: Pick<WorkloadRecommendation, 'kind' | 'namespace' | 'name'>) {
  return `${rec.kind.toLowerCase()}-${rec.namespace}-${rec.name}.yaml`;
}

// -- Usage history charts ------------------------------------------------------------

export type UsageCharts = 'ready' | 'disconnected' | 'metrics-server' | 'no-source';

/**
 * Whether the usage charts can be drawn: they are range queries against the
 * cluster's Prometheus, so they need a connection and a scan that used
 * Prometheus (metrics-server keeps only the last hour).
 */
export function usageChartsState(
  report: Pick<RightsizingReport, 'source'>,
  connected: boolean,
): UsageCharts {
  if (report.source === 'metrics-server') return 'metrics-server';
  if (report.source !== 'prometheus') return 'no-source';
  return connected ? 'ready' : 'disconnected';
}

/** Days the usage charts cover: the scan's window (1–30, like `reportDays`). */
export function historyDays(report: Pick<RightsizingReport, 'window_secs'>): number {
  return Math.min(30, Math.max(1, Math.round(report.window_secs / 86_400)));
}

export type UsageRefKind = 'request' | 'recommended' | 'limit';

export interface UsageRef {
  key: UsageRefKind;
  value: number;
}

/**
 * The dashed lines of one container's chart: its current request, the
 * recommended request and its current limit (only the values that exist).
 */
export function usageRefs(c: ContainerRecommendation, resource: 'cpu' | 'memory'): UsageRef[] {
  const values: Array<[UsageRefKind, number | null]> =
    resource === 'cpu'
      ? [
          ['request', c.current.cpu_request],
          ['recommended', c.recommended.cpu_request],
          ['limit', c.current.cpu_limit],
        ]
      : [
          ['request', c.current.memory_request],
          ['recommended', c.recommended.memory_request],
          ['limit', c.current.memory_limit],
        ];
  return values.flatMap(([key, value]) =>
    value != null && Number.isFinite(value) && value > 0 ? [{ key, value }] : [],
  );
}

/** CPU with its unit: `250m`, or `1 core` / `1.5 cores` from one core. */
export function cpuValueText(millicores: number): string {
  if (millicores < 1000) return formatCpu(millicores);
  const cores = Math.round(millicores / 10) / 100;
  return i18n.plural('{count} core', '{count} cores', cores);
}

/** Mean of the samples (null without any). */
export function meanOf(points: readonly SeriesPoint[]): number | null {
  if (!points.length) return null;
  let sum = 0;
  for (const p of points) sum += p.v;
  return sum / points.length;
}

/** Largest sample (null without any). */
export function maxOf(points: readonly SeriesPoint[]): number | null {
  if (!points.length) return null;
  let max = -Infinity;
  for (const p of points) if (p.v > max) max = p.v;
  return max;
}

/** "One point per hour" / "One point every 5 minutes". */
export function stepText(stepSecs: number): string {
  const secs = Math.max(1, Math.round(stepSecs));
  if (secs % 86_400 === 0)
    return i18n.plural('One point per day', 'One point every {count} days', secs / 86_400);
  if (secs % 3600 === 0)
    return i18n.plural('One point per hour', 'One point every {count} hours', secs / 3600);
  return i18n.plural(
    'One point per minute',
    'One point every {count} minutes',
    Math.max(1, Math.round(secs / 60)),
  );
}

// -- Trend across scans -----------------------------------------------------------

export type TrendSeriesKey = 'request' | 'recommended' | 'usage';

/**
 * One container's values per stored scan: the request then, the
 * recommended request and the usage behind it (CPU p95, memory peak).
 * Scans without the container or the value leave a gap.
 */
export function trendSeries(
  points: readonly RecommendationTrendPoint[],
  container: string,
  resource: 'cpu' | 'memory',
): Record<TrendSeriesKey, SeriesPoint[]> {
  const out: Record<TrendSeriesKey, SeriesPoint[]> = { request: [], recommended: [], usage: [] };
  for (const p of points) {
    const c = p.containers.find((x) => x.name === container);
    if (!c) continue;
    const values: Record<TrendSeriesKey, number | null> =
      resource === 'cpu'
        ? { request: c.cpu_request, recommended: c.cpu_recommended, usage: c.cpu_p95 }
        : { request: c.memory_request, recommended: c.memory_recommended, usage: c.memory_max };
    for (const key of ['request', 'recommended', 'usage'] as const) {
      const v = values[key];
      if (v != null && Number.isFinite(v)) out[key].push({ t: p.at, v });
    }
  }
  return out;
}

/**
 * The sample interval of the trend chart: scans are hourly (or the scan
 * interval) for 48 hours, then one per day, so the widest gap between
 * neighbours, between an hour and a day. The chart breaks the line only
 * where neighbours are more than 2.5 intervals apart: with daily points,
 * a gap of more than two and a half days without a kept scan.
 */
export function trendInterval(points: readonly Pick<RecommendationTrendPoint, 'at'>[]): number {
  let widest = 0;
  for (let i = 1; i < points.length; i++)
    widest = Math.max(widest, points[i]!.at - points[i - 1]!.at);
  return Math.min(DAY, Math.max(HOUR, widest));
}

/** Time range of the trend chart (an hour either side of a single scan). */
export function trendRange(points: readonly Pick<RecommendationTrendPoint, 'at'>[]): {
  from: number;
  to: number;
} {
  if (!points.length) return { from: 0, to: HOUR };
  const first = points[0]!.at;
  const last = points[points.length - 1]!.at;
  return last - first < HOUR ? { from: first - HOUR, to: last + HOUR } : { from: first, to: last };
}

// -- Evidence ---------------------------------------------------------------------

export function identityLabel(identity: EvidenceIdentity): string {
  switch (identity) {
    case 'owner-metrics':
      return i18n.t('kube-state-metrics owners');
    case 'name-match':
      return i18n.t('Matched by pod name');
    default:
      return i18n.t('Ambiguous pod names');
  }
}

const percentOf = (ratio: number | null) => (ratio == null ? '—' : formatPercent(ratio * 100));

export interface EvidenceRow {
  key: string;
  label: string;
  value: string;
  /** Worth attention: an OOM kill, throttling from the threshold on, partial data. */
  warn?: boolean;
}

/**
 * How far a container's usage can be trusted, as label / value rows.
 * `throttleThresholdPercent` is the settings' `cpu-throttled` threshold.
 */
export function evidenceRows(e: UsageEvidence, throttleThresholdPercent = 5): EvidenceRow[] {
  const rows: EvidenceRow[] = [
    {
      key: 'observed',
      label: i18n.t('Observed'),
      value: e.observed_hours > 0 ? coverageLabel(e.observed_hours) : '—',
    },
    {
      key: 'coverage',
      label: i18n.t('Coverage'),
      value: i18n.t('CPU {cpu} · memory {memory}', {
        cpu: percentOf(e.cpu_coverage),
        memory: percentOf(e.memory_coverage),
      }),
    },
    {
      key: 'samples',
      label: i18n.t('Samples'),
      value: i18n.t('CPU {cpu} · memory {memory}', {
        cpu: i18n.number(e.cpu_samples),
        memory: i18n.number(e.memory_samples),
      }),
    },
    { key: 'pods', label: i18n.t('Pods'), value: i18n.number(e.pods) },
  ];
  if (e.duty != null)
    rows.push({
      key: 'duty',
      label: i18n.t('Running on average'),
      value: i18n.number(e.duty, { maximumFractionDigits: 2 }),
    });
  rows.push(
    {
      key: 'throttle',
      label: i18n.t('CPU throttling'),
      value:
        e.throttle_ratio == null
          ? i18n.t('Not measured')
          : i18n.t('{percent} of CFS periods', { percent: formatPercent(e.throttle_ratio * 100) }),
      warn: e.throttle_ratio != null && e.throttle_ratio * 100 >= throttleThresholdPercent,
    },
    {
      key: 'oom',
      label: i18n.t('OOM kills'),
      value: e.oom_killed ? i18n.t('Within the window') : i18n.t('None'),
      warn: e.oom_killed,
    },
    { key: 'identity', label: i18n.t('Pod identity'), value: identityLabel(e.identity) },
  );
  if (e.partial)
    rows.push({
      key: 'partial',
      label: i18n.t('Data'),
      value: i18n.t('Partial: some usage queries failed'),
      warn: true,
    });
  return rows;
}

/** "Scaled by the HorizontalPodAutoscaler web between 2 and 10 replicas." */
export function hpaText(hpa: HpaInfo): string {
  return hpa.min_replicas != null
    ? i18n.t('Scaled by the HorizontalPodAutoscaler {name} between {min} and {max} replicas.', {
        name: hpa.name,
        min: i18n.number(hpa.min_replicas),
        max: i18n.number(hpa.max_replicas),
      })
    : i18n.t('Scaled by the HorizontalPodAutoscaler {name} up to {max} replicas.', {
        name: hpa.name,
        max: i18n.number(hpa.max_replicas),
      });
}

/** "CPU target 70%" per utilization target of the autoscaler. */
export function hpaTargets(hpa: HpaInfo): string[] {
  return hpa.metrics.flatMap((m) => {
    if (m.target_utilization == null || m.resource === 'other') return [];
    const percent = formatPercent(m.target_utilization);
    return [
      m.resource === 'cpu'
        ? i18n.t('CPU target {percent} of the request', { percent })
        : i18n.t('Memory target {percent} of the request', { percent }),
    ];
  });
}

// -- Focus ------------------------------------------------------------------------

/**
 * Where Tab moves inside a focus trap: past the last item to the first,
 * before the first (or from the container itself) to the last; null lets
 * the browser move within the items.
 */
export function trapTarget<T>(items: readonly T[], active: T | null, backwards: boolean): T | null {
  if (!items.length) return null;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const inside = active != null && items.includes(active);
  if (backwards) return !inside || active === first ? last : null;
  return !inside || active === last ? first : null;
}

// -- Apply ------------------------------------------------------------------------

export interface DrawerAction {
  /** `apply`: one-click (`onApply`); `review`: the dialog (`onReview`); `none`: nothing changes. */
  kind: 'apply' | 'review' | 'none';
  label: string;
  /** Why the button is disabled (null = enabled). */
  disabled: string | null;
}

/**
 * The drawer's apply button: "Apply" for one-click rows, "Review & apply"
 * otherwise, "Review" on read-only clusters (the dialog shows the dry run
 * and refuses to apply). A past run and a disconnected cluster apply
 * nothing; an RBAC denial (`blocked`) disables applying with its reason.
 */
export function drawerAction(
  mode: ApplyMode,
  {
    past,
    connected,
    blocked = null,
  }: { past: boolean; connected: boolean; blocked?: string | null },
): DrawerAction {
  if (mode === 'none') return { kind: 'none', label: i18n.t('No change'), disabled: null };
  const kind = mode === 'one-click' ? 'apply' : 'review';
  const label =
    mode === 'one-click'
      ? i18n.t('Apply')
      : mode === 'read-only'
        ? i18n.t('Review')
        : i18n.t('Review & apply');
  const disabled = past
    ? i18n.t('A past scan is read-only: pick the latest scan to apply.')
    : !connected
      ? i18n.t('Connect to the cluster to apply.')
      : mode !== 'read-only' && blocked
        ? blocked
        : null;
  return { kind, label, disabled };
}
