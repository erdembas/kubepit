import * as i18n from '@/i18n/core';
import type { SeriesPoint } from '@/lib/fleet/timeSeries';
import type {
  PrometheusConfig,
  PrometheusKind,
  PrometheusService,
  PrometheusTarget,
  PromPoint,
} from '@/types';

/**
 * Pure helpers for the Prometheus metrics source: range choices, labels,
 * number formatting for unit-less PromQL results, the series palette and
 * the PromQL tab's recent queries. The backend owns every preset query;
 * nothing here builds PromQL.
 */

/** Range choices while Prometheus is the source. */
export const PROM_RANGES = ['1h', '6h', '24h', '7d'] as const;
export type PromRangeKey = (typeof PROM_RANGES)[number];

const HOUR = 3_600_000;

export const PROM_RANGE_MS: Record<PromRangeKey, number> = {
  '1h': HOUR,
  '6h': 6 * HOUR,
  '24h': 24 * HOUR,
  '7d': 7 * 24 * HOUR,
};

/** How often charts re-query per range (the step grows with the range). */
export const PROM_POLL_MS: Record<PromRangeKey, number> = {
  '1h': 30_000,
  '6h': 60_000,
  '24h': 120_000,
  '7d': 300_000,
};

export function isPromRange(value: unknown): value is PromRangeKey {
  return (PROM_RANGES as readonly unknown[]).includes(value);
}

/** Short label: `1h`, `24h`, `7d` (localized units). */
export function promRangeLabel(key: PromRangeKey): string {
  return key.endsWith('d')
    ? i18n.t('{days}d', { days: parseInt(key, 10) })
    : i18n.t('{hours}h', { hours: parseInt(key, 10) });
}

export function promRangeTitle(key: PromRangeKey): string {
  const n = parseInt(key, 10);
  return key.endsWith('d')
    ? i18n.plural('Last day', 'Last {count} days', n)
    : i18n.plural('Last hour', 'Last {count} hours', n);
}

/** `{ start, end }` of the range ending now. */
export function rangeEndingNow(key: PromRangeKey, now = Date.now()) {
  return { start: now - PROM_RANGE_MS[key], end: now, step: null };
}

export function toSeriesPoints(points: readonly PromPoint[] | undefined): SeriesPoint[] {
  return points?.map(([t, v]) => ({ t, v })) ?? [];
}

/** `monitoring/prometheus-operated`. */
export function serviceLabel(service: PrometheusService): string {
  return `${service.namespace}/${service.service}`;
}

/** `http://prometheus-operated.monitoring:9090/prefix` (tooltips). */
export function serviceAddress(service: PrometheusService): string {
  return `${service.scheme}://${service.service}.${service.namespace}:${service.port}${service.path_prefix}`;
}

/** Product name of a provider (names stay untranslated). */
export function kindLabel(kind: PrometheusKind): string {
  switch (kind) {
    case 'prometheus-operator':
      return 'Prometheus Operator';
    case 'prometheus':
      return 'Prometheus';
    case 'thanos':
      return 'Thanos';
    case 'victoria-metrics':
      return 'VictoriaMetrics';
    case 'mimir':
      return 'Grafana Mimir';
    case 'openshift':
      return 'OpenShift monitoring';
    case 'custom':
      return i18n.t('Custom service');
  }
}

/** Stable cache-key fragment of a cluster's Prometheus setting. */
export function configKey(config: PrometheusConfig | undefined): string {
  if (!config || config.mode !== 'service') return config?.mode ?? 'auto';
  return `service:${config.scheme}:${config.namespace}/${config.service}:${config.port}${config.path_prefix}`;
}

/** Stable cache-key fragment of a preset target. */
export function targetKey(target: PrometheusTarget): string {
  switch (target.kind) {
    case 'cluster':
      return 'cluster';
    case 'node':
      return `node|${target.name}`;
    case 'namespace':
      return `namespace|${target.namespace}`;
    case 'workload':
      return `workload|${target.namespace}|${target.workload_kind}|${target.name}`;
    case 'pod':
      return `pod|${target.namespace}|${target.name}`;
    case 'container':
      return `container|${target.namespace}|${target.pod}|${target.container}`;
    case 'pvc':
      return `pvc|${target.namespace}|${target.name}`;
  }
}

/** Legend text of a PromQL series: `metric{a="b", c="d"}`. */
export function seriesLabel(labels: Record<string, string>): string {
  const { __name__: name = '', ...rest } = labels;
  const pairs = Object.keys(rest)
    .sort()
    .map((k) => `${k}="${rest[k]}"`);
  if (!pairs.length) return name || '{}';
  return `${name}{${pairs.join(', ')}}`;
}

const SI = [
  { exp: 12, suffix: 'T' },
  { exp: 9, suffix: 'G' },
  { exp: 6, suffix: 'M' },
  { exp: 3, suffix: 'k' },
] as const;

/** Unit-less value with SI prefixes: `1.2k`, `3.4M`, `0.25`, `1.5e-4`. */
export function formatSi(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  for (const { exp, suffix } of SI) {
    if (abs >= 10 ** exp) {
      const scaled = value / 10 ** exp;
      return `${i18n.number(scaled, { maximumFractionDigits: Math.abs(scaled) < 10 ? 2 : 1 })}${suffix}`;
    }
  }
  if (abs < 0.001) return value.toExponential(1);
  return i18n.number(value, { maximumFractionDigits: abs < 1 ? 3 : 2 });
}

/**
 * Categorical palette for PromQL series (literal class names so Tailwind
 * generates them). Accent first, like every other chart.
 */
export const SERIES_COLORS = [
  { stroke: 'stroke-accent', bg: 'bg-accent', text: 'fill-accent' },
  { stroke: 'stroke-cat-frontend', bg: 'bg-cat-frontend', text: 'fill-cat-frontend' },
  { stroke: 'stroke-cat-backend', bg: 'bg-cat-backend', text: 'fill-cat-backend' },
  { stroke: 'stroke-cat-database', bg: 'bg-cat-database', text: 'fill-cat-database' },
  { stroke: 'stroke-cat-tooling', bg: 'bg-cat-tooling', text: 'fill-cat-tooling' },
  { stroke: 'stroke-cat-worker', bg: 'bg-cat-worker', text: 'fill-cat-worker' },
  { stroke: 'stroke-status-error', bg: 'bg-status-error', text: 'fill-status-error' },
  { stroke: 'stroke-cat-other', bg: 'bg-cat-other', text: 'fill-cat-other' },
] as const;

export type SeriesColor = (typeof SERIES_COLORS)[number];

export function seriesColor(index: number): SeriesColor {
  return SERIES_COLORS[index % SERIES_COLORS.length]!;
}

// -- Recent PromQL queries (per viewer, best effort) ---------------------------

const HISTORY_KEY = 'kp.promql.history';
const HISTORY_MAX = 12;

export function loadQueryHistory(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((q): q is string => typeof q === 'string').slice(0, HISTORY_MAX)
      : [];
  } catch {
    return [];
  }
}

export function rememberQuery(query: string): string[] {
  const q = query.trim();
  const next = q ? [q, ...loadQueryHistory().filter((h) => h !== q)].slice(0, HISTORY_MAX) : [];
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: history lives for this session only */
  }
  return next;
}

/** Starter queries of the PromQL tab (PromQL is never translated). */
export const PROMQL_EXAMPLES = [
  'up',
  'sum by (namespace) (rate(container_cpu_usage_seconds_total{container!=""}[5m]))',
  'sum by (namespace) (container_memory_working_set_bytes{container!=""})',
  'topk(10, sum by (pod) (rate(container_network_receive_bytes_total[5m])))',
  'sum by (namespace) (increase(kube_pod_container_status_restarts_total[1h]))',
  '1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))',
] as const;
