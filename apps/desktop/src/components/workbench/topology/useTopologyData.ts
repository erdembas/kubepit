import { useMemo, useRef } from 'react';
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
import type { ApiResourceInfo, ClusterId, Gvk, KubeObject } from '@/types';
import { useWatch, type WatchSnapshot } from '../data/watchCache';

export interface TopologyWatchError {
  kind: string;
  forbidden: boolean;
  message: string;
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
 * delivered batch. `slotScopes` holds one watch scope per topology source
 * (`[]` = cluster-wide, `null` = not watched); the graph is scoped to the
 * union of their namespace lists. `extra` adds objects whose kind is not
 * watched (the details panel's own object).
 */
export function useTopologyData(
  clusterId: ClusterId,
  slotScopes: ReadonlyArray<SlotScope>,
  enabled: boolean,
  apiResources: readonly ApiResourceInfo[] | null,
  extra?: { gvk: Gvk; obj: KubeObject } | null,
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

  const snapsRef = useRef(snaps);
  snapsRef.current = snaps;
  const scopeKey = slotScopes.map((s) => (s === null ? '-' : s.join(','))).join(';');
  const scopeRef = useRef(slotScopes);
  scopeRef.current = slotScopes;
  const extraKey = extra
    ? `${extra.obj.metadata.uid}@${extra.obj.metadata.resourceVersion ?? ''}`
    : '';
  const key = `${scopeKey}#${extraKey}#${snaps
    .map((s, i) => (watched(i) ? `${s.version}:${s.status}` : '-'))
    .join(',')}`;

  const built = useMemo(() => {
    const lists: TopologyList[] = [];
    const errors: TopologyWatchError[] = [];
    const byId = new Map<string, KubeObject>();
    const scopes = scopeRef.current;
    snapsRef.current.forEach((snap, i) => {
      const gvk = sources[i];
      if (!gvk || scopes[i] == null) return;
      lists.push({
        gvk,
        items: snap.items,
        synced: snap.synced && snap.status !== 'error',
      });
      if (snap.status === 'error' && snap.error)
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
      namespaces: scopeNamespaces(scopes),
      apiResources,
      extra: extra ? [extra] : undefined,
    });
    return { graph, errors, byId };
    // `key` captures every snapshot version, the scope and the extra object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sources, apiResources]);

  const active = snaps.filter((_, i) => watched(i));
  const synced = active.every((s) => s.synced || s.status === 'error');
  const loading = active.some((s) => s.status === 'loading');
  const objectFor = useMemo(() => {
    const byId = built.byId;
    return (id: string) => byId.get(id) ?? null;
  }, [built]);
  return { graph: built.graph, synced, loading, errors: built.errors, objectFor };
}
