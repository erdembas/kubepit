import { useEffect, useMemo } from 'react';
import { ipc } from '@/lib/ipc';
import { useAppStore } from '@/store/useAppStore';
import { ANY_VIEW, useWorkbenchStore, type ViewKey } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo, ClusterId, NodeMetric, PodMetric } from '@/types';
import { usePolled } from './polled';

/** Discovery, fetched once per connection and mirrored into the workbench store. */
export function useApiResources(clusterId: ClusterId, enabled: boolean): ApiResourceInfo[] | null {
  const connectedAt = useAppStore((s) => s.statuses[clusterId]?.connected_at ?? 0);
  const state = usePolled(
    enabled ? `${clusterId}|api-resources|${connectedAt}` : null,
    () => ipc.apiResources(clusterId),
    null,
    enabled,
  );
  useEffect(() => {
    if (state.data) useWorkbenchStore.getState().setApiResources(clusterId, state.data);
  }, [clusterId, state.data]);
  return state.data ?? useWorkbenchStore.getState().apiResources[clusterId] ?? null;
}

export function useNamespaceNames(clusterId: ClusterId, enabled: boolean) {
  const connectedAt = useAppStore((s) => s.statuses[clusterId]?.connected_at ?? 0);
  return usePolled(
    `${clusterId}|namespace-names|${connectedAt}`,
    () => ipc.namespaceNames(clusterId),
    60_000,
    enabled,
  );
}

/**
 * The namespaces a view should scope to ([] = all namespaces). Each view tab
 * keeps its own selection; a view never scoped itself falls back to the
 * shared scope (`ANY_VIEW`, the last explicit selection), then the cluster
 * default. See `useWorkbenchStore` for the state shape.
 */
export function useSelectedNamespaces(clusterId: ClusterId, viewKey: ViewKey = ANY_VIEW) {
  const stored = useWorkbenchStore((s) => s.namespaces[clusterId]?.[viewKey]);
  const shared = useWorkbenchStore((s) => s.namespaces[clusterId]?.[ANY_VIEW]);
  const fallback = useAppStore(
    (s) => s.clusters.find((c) => c.id === clusterId)?.default_namespace ?? null,
  );
  return useMemo(
    () => stored ?? shared ?? (fallback ? [fallback] : []),
    [stored, shared, fallback],
  );
}

export interface MetricsMap<T> {
  available: boolean;
  byKey: ReadonlyMap<string, T>;
}

const NO_METRICS = { available: false, byKey: new Map() };

export function usePodMetrics(
  clusterId: ClusterId,
  namespaces: readonly string[],
  enabled: boolean,
): MetricsMap<PodMetric> {
  const single = namespaces.length === 1 ? namespaces[0]! : null;
  const state = usePolled(
    `${clusterId}|metrics-pods|${single ?? '*'}`,
    () => ipc.metricsPods(clusterId, single),
    15_000,
    enabled,
  );
  return useMemo(() => {
    if (!state.data?.available) return NO_METRICS;
    const map = new Map<string, PodMetric>();
    for (const m of state.data.items) map.set(`${m.namespace}/${m.name}`, m);
    return { available: true, byKey: map };
  }, [state.data]);
}

export function useNodeMetrics(clusterId: ClusterId, enabled: boolean): MetricsMap<NodeMetric> {
  const state = usePolled(
    `${clusterId}|metrics-nodes`,
    () => ipc.metricsNodes(clusterId),
    15_000,
    enabled,
  );
  return useMemo(() => {
    if (!state.data?.available) return NO_METRICS;
    return { available: true, byKey: new Map(state.data.items.map((m) => [m.name, m])) };
  }, [state.data]);
}

export function useCluster(clusterId: ClusterId) {
  const cluster = useAppStore((s) => s.clusters.find((c) => c.id === clusterId));
  const status = useAppStore((s) => s.statuses[clusterId]);
  return {
    cluster,
    status,
    readOnly: cluster?.read_only ?? false,
    production: cluster?.environment === 'production',
  };
}
