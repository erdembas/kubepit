import { ipc } from '@/lib/ipc';
import { lokiConfigKey } from '@/lib/logs/loki';
import { useAppStore } from '@/store/useAppStore';
import type { ClusterId, LokiStatus } from '@/types';
import { refreshPolledPrefix, usePolled } from '../../data/polled';

/** The backend re-detects on its own after negative answers; this only picks that up. */
const STATUS_POLL_MS = 5 * 60_000;

/**
 * Cache-key fragment that changes with the connection and the cluster's Loki
 * setting; `null` while disconnected or before the cluster exists.
 */
export function useLokiSourceKey(clusterId: ClusterId | null): string | null {
  const config = useAppStore((s) =>
    lokiConfigKey(s.clusters.find((c) => c.id === clusterId)?.loki),
  );
  const status = useAppStore((s) => (clusterId ? s.statuses[clusterId] : undefined));
  if (!clusterId || status?.state !== 'connected') return null;
  return `${config}|${status.connected_at ?? 0}`;
}

/**
 * Loki detection status (cached per connection in the backend). Idle for a
 * `null` id (a cluster that is still being added).
 */
export function useLokiStatus(clusterId: ClusterId | null, enabled = true) {
  const source = useLokiSourceKey(clusterId);
  return usePolled<LokiStatus>(
    source ? `${clusterId}|loki-status|${source}` : null,
    () => ipc.lokiStatus(clusterId!),
    STATUS_POLL_MS,
    enabled,
  );
}

/** Detect again (after installing Loki or changing the setting). */
export async function redetectLoki(clusterId: ClusterId): Promise<LokiStatus> {
  const status = await ipc.lokiStatus(clusterId, true);
  refreshPolledPrefix(`${clusterId}|loki-`);
  return status;
}

/** Label values for the query builder (fetched once per key; `null` key = skip). */
export function useLokiValues(
  clusterId: ClusterId,
  label: string | null,
  bounds: { start: string; end: string },
  query: string | null,
  rangeKey: string,
  enabled: boolean,
) {
  const source = useLokiSourceKey(clusterId);
  const key =
    source && label && enabled
      ? `${clusterId}|loki-values|${source}|${label}|${rangeKey}|${query ?? ''}`
      : null;
  return usePolled<string[]>(
    key,
    () => ipc.lokiLabelValues(clusterId, label!, bounds.start, bounds.end, query),
    null,
    enabled,
  );
}

/** Label names of the range (to find the namespace / pod / container labels). */
export function useLokiLabels(
  clusterId: ClusterId,
  bounds: { start: string; end: string },
  rangeKey: string,
  enabled: boolean,
) {
  const source = useLokiSourceKey(clusterId);
  const key = source && enabled ? `${clusterId}|loki-labels|${source}|${rangeKey}` : null;
  return usePolled<string[]>(
    key,
    () => ipc.lokiLabels(clusterId, bounds.start, bounds.end),
    null,
    enabled,
  );
}
