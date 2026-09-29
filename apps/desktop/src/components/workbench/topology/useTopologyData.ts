import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { kindKey } from '@/lib/kube/catalog';
import {
  nodeId,
  scopeNamespaces,
  topologySources,
  TOPOLOGY_SOURCE_COUNT,
  type SlotScope,
  type TopoGraph,
} from '@/lib/kube/topology';
import type { ApiResourceInfo, ClusterId, Gvk, KubeObject } from '@/types';
import { hasListError, isListComplete } from '../data/listState';
import { useWatch, type WatchSnapshot } from '../data/watchCache';
import { CoalescedMemo, pausedMemo, topologyDataKey, type PausedMemo } from './dataKey';
import { TopologyModel, type TopologySource } from './topologyModel';

export interface TopologyWatchError {
  kind: string;
  forbidden: boolean;
  message: string;
}

export interface TopologyData {
  /** The map's engine session: `TopologyMap` asks it for views. */
  model: TopologyModel;
  /** The full graph, only with `withGraph` (the reachability overlay); else null. */
  graph: TopoGraph | null;
  /** Every watch delivered its first list (or failed). */
  synced: boolean;
  /** Something is still loading. */
  loading: boolean;
  errors: TopologyWatchError[];
  /** Live object behind a node id (`kindKey|namespace|name`). */
  objectFor: (id: string) => KubeObject | null;
  /** The watched kind with this `kindKey`, if any. */
  gvkFor: (kindKey: string) => Gvk | null;
}

interface Input {
  source: TopologySource;
  errors: TopologyWatchError[];
}

/**
 * Live data for the relationship map: one shared watch per kind (the same
 * ref-counted watches the tables use), streamed to the map's engine
 * session (`TopologyModel`), which builds the graph and derives the views
 * in the engine worker. What changed is sent as the batches arrive; a
 * rebuild is asked for at most once per delivered batch, and while the
 * watches still sync at most once every `SYNC_REBUILD_INTERVAL_MS`
 * (`CoalescedMemo`); the batch that completes the sync and every live
 * change after it rebuild at once.
 *
 * `slotScopes` holds one watch scope per topology source (`[]` =
 * cluster-wide, `null` = not watched); the graph is scoped to the union of
 * their namespace lists. `extra` adds objects whose kind is not watched
 * (the details panel's own object). `graphScope` (Map tabs of
 * cluster-scoped roots, see `plannedGraphScope`) scopes the graph to those
 * namespaces instead, `null` to none, so the cluster-wide seed watches make
 * no placeholders for what their objects elsewhere reference.
 *
 * Leaving the view is free: the input key ignores the watch status (the
 * stops only flip it), and while `enabled` is false the input is frozen,
 * nothing is sent and the model keeps its last result.
 */
export function useTopologyData(
  clusterId: ClusterId,
  slotScopes: ReadonlyArray<SlotScope>,
  enabled: boolean,
  apiResources: readonly ApiResourceInfo[] | null,
  extra?: { gvk: Gvk; obj: KubeObject } | null,
  graphScope?: readonly string[] | null,
  options?: { withGraph?: boolean },
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
  const structure = [scopeKey, extraKey, sources, apiResources];

  // The live input, frozen while disabled.
  const inputMemo = useRef<PausedMemo<Input> | null>(null);
  inputMemo.current = pausedMemo(inputMemo.current, [...structure, dataKey], enabled, () => {
    const errors: TopologyWatchError[] = [];
    const slots = snaps.map((snap, i) => {
      const gvk = sources[i];
      if (!gvk || slotScopes[i] == null) return null;
      if (hasListError(snap) && snap.error)
        errors.push({ kind: gvk.kind, forbidden: snap.forbidden, message: snap.error });
      // A partial list (one namespace forbidden) is not synced: no "missing" guesses.
      return { gvk, items: snap.items, byUid: snap.byUid, synced: isListComplete(snap) };
    });
    const source: TopologySource = {
      slots,
      namespaces: graphScope === undefined ? scopeNamespaces(slotScopes) : graphScope,
      apiResources,
      extra: extra ?? null,
      synced,
    };
    return { source, errors };
  });
  const { source, errors } = inputMemo.current.value;

  // Rebuilds: a new token per change of the input, coalesced while syncing.
  // A change of the structure (scope, extra object, sources) rebuilds at once.
  const [, wake] = useReducer((n: number) => n + 1, 0);
  const [coalesced] = useState(() => new CoalescedMemo<TopologySource>(wake));
  useEffect(() => () => coalesced.cancel(), [coalesced]);
  const build = coalesced.get(structure, [dataKey], enabled, !synced, () => source);

  const [model] = useState(() => new TopologyModel());
  const withGraph = !!options?.withGraph;
  useEffect(() => {
    model.setActive(enabled);
    return () => model.setActive(false);
  }, [model, enabled]);
  useEffect(() => model.setSource(source), [model, source]);
  useEffect(() => model.setBuild(build), [model, build]);
  useEffect(() => model.setWithGraph(withGraph), [model, withGraph]);
  const graph = useSyncExternalStore(model.subscribe, () => model.getResult().graph);

  // Built on first use (the details panel of a selected node) per input.
  const objectFor = useMemo(() => {
    let byId: Map<string, KubeObject> | null = null;
    return (id: string) => {
      byId ??= indexObjects(source);
      return byId.get(id) ?? null;
    };
  }, [source]);
  const gvkFor = useCallback(
    (key: string) => sources.find((g) => g && kindKey(g) === key) ?? null,
    [sources],
  );
  return { model, graph, synced, loading, errors, objectFor, gvkFor };
}

function indexObjects(source: TopologySource): Map<string, KubeObject> {
  const byId = new Map<string, KubeObject>();
  const add = (gvk: Gvk, items: readonly KubeObject[]) => {
    const key = kindKey(gvk);
    for (const obj of items)
      byId.set(nodeId(key, gvk.namespaced ? obj.metadata.namespace : null, obj.metadata.name), obj);
  };
  for (const slot of source.slots) if (slot) add(slot.gvk, slot.items);
  if (source.extra) add(source.extra.gvk, [source.extra.obj]);
  return byId;
}
