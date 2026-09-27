import { useSyncExternalStore } from 'react';
import { ipc } from '@/lib/ipc';
import { RANGES, type RangeMinutes } from '@/lib/fleet/timeSeries';
import { useAppStore } from '@/store/useAppStore';
import type { ClusterId, MetricsHistoryQuery, MetricsSeries } from '@/types';
import { usePolled } from '../data/polled';

/** How often the charts re-read the backend history (the sampler writes every 15 s). */
export const HISTORY_POLL_MS = 15_000;

export function historyKey(clusterId: ClusterId, query: MetricsHistoryQuery): string {
  const names = query.scope === 'cluster' ? '' : [...query.names].sort().join(',');
  const ns = query.scope === 'pods' ? query.namespace : '';
  return `${clusterId}|metrics-history|${query.scope}|${ns}|${names}`;
}

/** Polls one history series while `enabled` (visible, active tab). */
export function useMetricsHistory(
  clusterId: ClusterId,
  query: MetricsHistoryQuery | null,
  enabled: boolean,
) {
  return usePolled<MetricsSeries>(
    query ? historyKey(clusterId, query) : null,
    () => ipc.metricsHistory(clusterId, query!),
    HISTORY_POLL_MS,
    enabled && !!query,
  );
}

/**
 * Dashboard sparklines: one shared request for every card, re-read at once
 * when the set of connected clusters changes.
 */
export function useFleetMetricsHistory(enabled: boolean) {
  const connected = useAppStore((s) =>
    Object.values(s.statuses)
      .filter((st) => st.state === 'connected')
      .map((st) => st.id)
      .sort()
      .join(','),
  );
  return usePolled<Record<ClusterId, MetricsSeries>>(
    `fleet|metrics-history|${connected}`,
    () => ipc.metricsHistoryFleet(),
    30_000,
    enabled,
  );
}

// -- Range preference shared by every chart (persisted per viewer) --------------

const RANGE_KEY = 'kp.metrics.range';
const listeners = new Set<() => void>();

function readRange(): RangeMinutes {
  try {
    const saved = Number(localStorage.getItem(RANGE_KEY));
    if ((RANGES as readonly number[]).includes(saved)) return saved as RangeMinutes;
  } catch {
    /* storage unavailable */
  }
  return 30;
}

let range: RangeMinutes = readRange();

export function setHistoryRange(next: RangeMinutes) {
  range = next;
  try {
    localStorage.setItem(RANGE_KEY, String(next));
  } catch {
    /* storage unavailable: keep it for this session */
  }
  listeners.forEach((l) => l());
}

export function useHistoryRange(): RangeMinutes {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => range,
    () => range,
  );
}
