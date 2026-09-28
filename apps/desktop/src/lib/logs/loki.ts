import * as i18n from '@/i18n/core';
import type { LokiKind, LokiService, PromQuerySeries } from '@/types';
import { msToNs } from './time';

/**
 * Pure helpers of the Loki tab: time ranges (presets or an absolute window
 * picked on the histogram), stream labels, the volume histogram's buckets
 * and product names. LogQL lives in `logql.ts`.
 */

export const LOKI_RANGES = ['15m', '1h', '6h', '24h', '7d'] as const;
export type LokiRangeKey = (typeof LOKI_RANGES)[number];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const LOKI_RANGE_MS: Record<LokiRangeKey, number> = {
  '15m': 15 * MINUTE,
  '1h': HOUR,
  '6h': 6 * HOUR,
  '24h': 24 * HOUR,
  '7d': 7 * 24 * HOUR,
};

/** A preset ending now, or an absolute window (zoomed in on the histogram). */
export type LokiRange =
  { kind: 'preset'; key: LokiRangeKey } | { kind: 'absolute'; start: number; end: number };

export function isLokiRangeKey(value: unknown): value is LokiRangeKey {
  return (LOKI_RANGES as readonly unknown[]).includes(value);
}

/** `{ start, end }` in epoch ms. */
export function rangeBounds(range: LokiRange, now = Date.now()): { start: number; end: number } {
  return range.kind === 'preset'
    ? { start: now - LOKI_RANGE_MS[range.key], end: now }
    : { start: range.start, end: range.end };
}

/** `{ start, end }` as nanosecond strings for the backend. */
export function rangeNs(bounds: { start: number; end: number }): { start: string; end: string } {
  return { start: msToNs(bounds.start), end: msToNs(bounds.end) };
}

/** Short label of a preset: `15m`, `1h`, `7d` (localized units). */
export function lokiRangeLabel(key: LokiRangeKey): string {
  const n = parseInt(key, 10);
  if (key.endsWith('m')) return i18n.t('{minutes}m', { minutes: n });
  if (key.endsWith('d')) return i18n.t('{days}d', { days: n });
  return i18n.t('{hours}h', { hours: n });
}

export function lokiRangeTitle(key: LokiRangeKey): string {
  const n = parseInt(key, 10);
  if (key.endsWith('m')) return i18n.plural('Last minute', 'Last {count} minutes', n);
  if (key.endsWith('d')) return i18n.plural('Last day', 'Last {count} days', n);
  return i18n.plural('Last hour', 'Last {count} hours', n);
}

const STEPS = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400,
];

/** A round bucket width (seconds) giving about `buckets` bars over the range. */
export function volumeStep(rangeMs: number, buckets = 60): number {
  const raw = Math.max(1, Math.ceil(rangeMs / 1000 / buckets));
  return STEPS.find((s) => s >= raw) ?? Math.ceil(raw / 86400) * 86400;
}

export interface VolumeBucket {
  /** Bucket start, epoch ms. */
  t: number;
  count: number;
}

/**
 * Buckets of `stepSecs` covering `[start, end]` from a `count_over_time`
 * series (`[epoch ms, count]`, the point at the bucket end), summed over
 * series.
 */
export function bucketsFromSeries(
  series: readonly PromQuerySeries[],
  start: number,
  end: number,
  stepSecs: number,
): VolumeBucket[] {
  const step = stepSecs * 1000;
  const first = Math.floor(start / step) * step;
  const n = Math.max(1, Math.ceil((end - first) / step));
  const out: VolumeBucket[] = Array.from({ length: n }, (_, i) => ({
    t: first + i * step,
    count: 0,
  }));
  for (const s of series) {
    for (const [t, v] of s.points) {
      // Loki stamps a range vector with the end of its window.
      const index = Math.floor((t - 1 - first) / step);
      if (index >= 0 && index < n) out[index]!.count += v;
    }
  }
  return out;
}

/** Buckets counted from line timestamps (fallback when the metric query fails). */
export function bucketsFromTimes(
  times: readonly number[],
  start: number,
  end: number,
  stepSecs: number,
): VolumeBucket[] {
  const step = stepSecs * 1000;
  const first = Math.floor(start / step) * step;
  const n = Math.max(1, Math.ceil((end - first) / step));
  const out: VolumeBucket[] = Array.from({ length: n }, (_, i) => ({
    t: first + i * step,
    count: 0,
  }));
  for (const t of times) {
    const index = Math.floor((t - first) / step);
    if (index >= 0 && index < n) out[index]!.count++;
  }
  return out;
}

/** `pod/container` when a stream has them, else `k="v", …` (labels stay verbatim). */
export function streamLabel(labels: Record<string, string>): string {
  if (labels.pod) return labels.container ? `${labels.pod}/${labels.container}` : labels.pod;
  const keys = Object.keys(labels)
    .filter((k) => !k.startsWith('__'))
    .sort();
  return keys.map((k) => `${k}="${labels[k]}"`).join(', ') || '{}';
}

/** `loki/loki-gateway`. */
export function lokiServiceLabel(service: LokiService): string {
  return `${service.namespace}/${service.service}`;
}

/** `http://loki-gateway.loki:80/prefix` (tooltips). */
export function lokiServiceAddress(service: LokiService): string {
  return `${service.scheme}://${service.service}.${service.namespace}:${service.port}${service.path_prefix}`;
}

/** Product name of a detected component (names stay untranslated). */
export function lokiKindLabel(kind: LokiKind): string {
  switch (kind) {
    case 'gateway':
      return 'Loki gateway';
    case 'loki':
      return 'Loki';
    case 'read':
      return 'Loki read path';
    case 'query-frontend':
      return 'Loki query frontend';
    case 'querier':
      return 'Loki querier';
    case 'custom':
      return i18n.t('Custom service');
  }
}

/** Stable cache-key fragment of a cluster's Loki setting. */
export function lokiConfigKey(config: import('@/types').LokiConfig | undefined): string {
  if (!config || config.mode !== 'service') return config?.mode ?? 'auto';
  return `service:${config.scheme}:${config.namespace}/${config.service}:${config.port}${config.path_prefix}|${config.tenant}`;
}
