import { useEffect, useMemo, useReducer, useState } from 'react';
import { kindKey } from '@/lib/kube/catalog';
import {
  buildTopology,
  nodeId,
  scopeNamespaces,
  topologySources,
  TOPOLOGY_SOURCE_COUNT,
  type SlotScope,
  type TopoGraph,
  type TopologyList,
} from '@/lib/kube/topology';
import { perfNow, recordSince } from '@/lib/perf/probe';
import type { ApiResourceInfo, ClusterId, Gvk, KubeObject } from '@/types';
import { hasListError, isListComplete } from '../data/listState';
import { useWatch, type WatchSnapshot } from '../data/watchCache';
import { CoalescedMemo, topologyDataKey } from './dataKey';

export interface TopologyWatchError {
  kind: string;
  forbidden: boolean;
  message: string;
}

interface Built {
  graph: TopoGraph;
  errors: TopologyWatchError[];
  byId: Map<string, KubeObject>;
}

export interface TopologyData {
  graph: TopoGraph;
  /** Every watch delivered its first list (or failed). */
  synced: boolean;
  /** Something is still loading. */
  loading: boolean;
  errors: TopologyWatchError[];
  /** Live object behind a node id (`kindKey|namespace|name`). */
  objectFor: (id: string) => KubeObject | null;
}

/**
 * Live data for the relationship map: one shared watch per kind (the same
 * ref-counted watches the tables use), rebuilt into a graph at most once per
 * delivered batch. While the watches still sync, rebuilds are coalesced to
 * one every `SYNC_REBUILD_INTERVAL_MS` (`CoalescedMemo`); the batch that
 * completes the sync and every live change after it rebuild at once.
 * `slotScopes` holds one watch scope per topology source
 * (`[]` = cluster-wide, `null` = not watched); the graph is scoped to the
 * union of their namespace lists. `extra` adds objects whose kind is not
 * watched (the details panel's own object). `graphScope` (Map tabs of
 * cluster-scoped roots, see `plannedGraphScope`) scopes the graph to those
 * namespaces instead, `null` to none, so the cluster-wide seed watches make
 * no placeholders for what their objects elsewhere reference.
 *
 * Leaving the view is free: the rebuild key ignores the watch status (the
 * stops only flip it), and while `enabled` is false the previous model is
 * returned as is.
 */
export function useTopologyData(
  clusterId: ClusterId,
  slotScopes: ReadonlyArray<SlotScope>,
  enabled: boolean,
  apiResources: readonly ApiResourceInfo[] | null,
  extra?: { gvk: Gvk; obj: KubeObject } | null,
  graphScope?: readonly string[] | null,
): TopologyData {
  const sources = useMemo(() => topologySources(apiResources), [apiResources]);
  const watched = (i: number) => sources[i] != null && slotScopes[i] != null;
  const snaps: WatchSnapshot[] = [];
  // The source list has a fixed length, so the hook order never changes.
  for (let i = 0; i < TOPOLOGY_SOURCE_COUNT; i++) {
    const scope = slotScopes[i] ?? null;
    snaps.push(
      // eslint-disable-next-line react-hooks/rules-of-hooks
      useWatch(clusterId, scope === null ? null : (sources[i] ?? null), scope ?? [], enabled),
    );
  }

  const scopeKey = `${slotScopes.map((s) => (s === null ? '-' : s.join(','))).join(';')}>${
    graphScope === undefined ? '*' : (graphScope?.join(',') ?? '-')
  }`;
  const extraKey = extra
    ? `${extra.obj.metadata.uid}@${extra.obj.metadata.resourceVersion ?? ''}`
    : '';
  const dataKey = snaps.map((s, i) => (watched(i) ? topologyDataKey([s]) : '-')).join(',');
  const active = snaps.filter((_, i) => watched(i));
  const synced = active.every((s) => s.synced || s.status === 'error');
  const loading = active.some((s) => s.status === 'loading');

  // A change of the structure (scope, extra object, sources) rebuilds at
  // once; `dataKey` captures every snapshot's data and is coalesced while
  // the watches sync.
  const [, wake] = useReducer((n: number) => n + 1, 0);
  const [memo] = useState(() => new CoalescedMemo<Built>(wake));
  useEffect(() => () => memo.cancel(), [memo]);
  const built = memo.get(
    [scopeKey, extraKey, sources, apiResources],
    [dataKey],
    enabled,
    !synced,
    () => {
      const start = perfNow();
      const lists: TopologyList[] = [];
      const errors: TopologyWatchError[] = [];
      const byId = new Map<string, KubeObject>();
      snaps.forEach((snap, i) => {
        const gvk = sources[i];
        if (!gvk || slotScopes[i] == null) return;
        lists.push({
          gvk,
          items: snap.items,
          // A partial list (one namespace forbidden) is not synced: no "missing" guesses.
          synced: isListComplete(snap),
        });
        if (hasListError(snap) && snap.error)
          errors.push({ kind: gvk.kind, forbidden: snap.forbidden, message: snap.error });
        const key = kindKey(gvk);
        for (const obj of snap.items)
          byId.set(
            nodeId(key, gvk.namespaced ? obj.metadata.namespace : null, obj.metadata.name),
            obj,
          );
      });
      if (extra)
        byId.set(
          nodeId(
            kindKey(extra.gvk),
            extra.gvk.namespaced ? extra.obj.metadata.namespace : null,
            extra.obj.metadata.name,
          ),
          extra.obj,
        );
      const graph = buildTopology({
        lists,
        namespaces: graphScope === undefined ? scopeNamespaces(slotScopes) : graphScope,
        apiResources,
        extra: extra ? [extra] : undefined,
      });
      recordSince('map:build', start);
      return { graph, errors, byId };
    },
  );

  const objectFor = useMemo(() => {
    const byId = built.byId;
    return (id: string) => byId.get(id) ?? null;
  }, [built]);
  return { graph: built.graph, synced, loading, errors: built.errors, objectFor };
}
