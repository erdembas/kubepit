import { useSyncExternalStore } from 'react';
import { ipc } from '@/lib/ipc';
import {
  PROM_POLL_MS,
  configKey,
  isPromRange,
  rangeEndingNow,
  targetKey,
  type PromRangeKey,
} from '@/lib/prometheus';
import { useAppStore } from '@/store/useAppStore';
import type {
  ClusterId,
  PrometheusMetric,
  PrometheusMetricsResult,
  PrometheusStatus,
  PrometheusTarget,
} from '@/types';
import { refreshPolledPrefix, usePolled } from '../data/polled';

/**
 * Prometheus as a chart source: the detection status (cached per
 * connection in the backend, so re-reading it is cheap), the range
 * preference shared by every Prometheus chart, and preset series.
 */

/** The backend re-detects on its own after negative answers; this only picks that up. */
export const STATUS_POLL_MS = 5 * 60_000;

/**
 * Cache-key fragment that changes with the connection and the cluster's
 * setting; `null` while disconnected or before the cluster exists.
 */
function useSourceKey(clusterId: ClusterId | null): string | null {
  const config = useAppStore((s) =>
    configKey(s.clusters.find((c) => c.id === clusterId)?.prometheus),
  );
  const status = useAppStore((s) => (clusterId ? s.statuses[clusterId] : undefined));
  if (!clusterId || status?.state !== 'connected') return null;
  return `${config}|${status.connected_at ?? 0}`;
}

/** Idle for a `null` id (a cluster that is still being added). */
export function usePrometheusStatus(clusterId: ClusterId | null, enabled = true) {
  const source = useSourceKey(clusterId);
  return usePolled<PrometheusStatus>(
    source ? `${clusterId}|prometheus-status|${source}` : null,
    () => ipc.prometheusStatus(clusterId!),
    STATUS_POLL_MS,
    enabled,
  );
}

/** True once Prometheus answered for this connection. */
export function usePrometheusAvailable(clusterId: ClusterId, enabled = true): boolean {
  return usePrometheusStatus(clusterId, enabled).data?.state === 'available';
}

/** Detect again (after installing Prometheus or changing the setting). */
export async function redetectPrometheus(clusterId: ClusterId): Promise<PrometheusStatus> {
  const status = await ipc.prometheusStatus(clusterId, true);
  refreshPolledPrefix(`${clusterId}|prometheus-`);
  return status;
}

export function usePrometheusMetrics(
  clusterId: ClusterId,
  target: PrometheusTarget | null,
  metrics: PrometheusMetric[],
  range: PromRangeKey,
  enabled: boolean,
) {
  const source = useSourceKey(clusterId);
  const key =
    source && target
      ? `${clusterId}|prometheus-metrics|${source}|${targetKey(target)}|${range}|${metrics.join(',')}`
      : null;
  return usePolled<PrometheusMetricsResult>(
    key,
    () => ipc.prometheusMetrics(clusterId, target!, metrics, rangeEndingNow(range)),
    PROM_POLL_MS[range],
    enabled && !!key,
  );
}

// -- Range preference of the Prometheus charts (persisted per viewer) -----------

const RANGE_KEY = 'kp.metrics.promRange';
const listeners = new Set<() => void>();

function readRange(): PromRangeKey {
  try {
    const saved = localStorage.getItem(RANGE_KEY);
    if (isPromRange(saved)) return saved;
  } catch {
    /* storage unavailable */
  }
  return '1h';
}

let range: PromRangeKey = readRange();

export function setPromRange(next: PromRangeKey) {
  range = next;
  try {
    localStorage.setItem(RANGE_KEY, next);
  } catch {
    /* storage unavailable: keep it for this session */
  }
  listeners.forEach((l) => l());
}

export function usePromRange(): PromRangeKey {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => range,
    () => range,
  );
}
