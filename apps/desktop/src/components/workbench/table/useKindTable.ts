import { useMemo } from 'react';
import { ipc } from '@/lib/ipc';
import { BUILTIN, isCustomResource, resolveRef, toGvk } from '@/lib/kube/catalog';
import { columnsFor, type ColumnContext } from '@/lib/kube/columns';
import { navigateTo, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo, Gvk, KubeObject } from '@/types';
import { usePodMetrics, useNodeMetrics } from '../data/hooks';
import { usePolled } from '../data/polled';
import { useWatch } from '../data/watchCache';
import { useNow } from '../util';
import { applyWidths, filterItems, orderColumns, resolveSort, sortItems } from './tableModel';

const CRD_GVK = toGvk(BUILTIN.CustomResourceDefinition);
const METRIC_COLUMNS = new Set(['cpu', 'memory']);

/** Everything a resource table needs: live items, columns, sort, filter and cell context. */
export function useKindTable({
  clusterId,
  kindKey,
  gvk,
  namespaces,
  active,
  apiResources,
}: {
  clusterId: string;
  kindKey: string;
  gvk: Gvk;
  namespaces: string[];
  active: boolean;
  apiResources: ApiResourceInfo[] | null;
}) {
  const watchNs = gvk.namespaced ? namespaces : [];
  const snapshot = useWatch(clusterId, gvk, watchNs, active);
  const custom = isCustomResource(gvk);
  const crd = usePolled<KubeObject | null>(
    custom ? `${clusterId}|crd|${kindKey}` : null,
    () => ipc.resourceGet(clusterId, CRD_GVK, null, kindKey).catch(() => null),
    null,
    active,
  );
  const kind = useMemo(() => columnsFor(kindKey, gvk, crd.data), [kindKey, gvk, crd.data]);
  const toggled = useWorkbenchStore((s) => s.hiddenColumns[kindKey]);
  const order = useWorkbenchStore((s) => s.columnOrder[kindKey]);
  const widths = useWorkbenchStore((s) => s.columnWidths[kindKey]);
  const sortPref = useWorkbenchStore((s) => s.sort[kindKey]);
  const filter = useWorkbenchStore((s) => s.filters[`${clusterId}|${kindKey}`] ?? '');
  const hidden = useMemo(() => {
    const t = new Set(toggled ?? []);
    return new Set(
      kind.columns
        .filter((c) => !c.fixed && (c.defaultHidden ? !t.has(c.id) : t.has(c.id)))
        .map((c) => c.id),
    );
  }, [kind, toggled]);
  // Every column in the user's order (column menu, exports), then the visible ones sized.
  const orderedColumns = useMemo(() => orderColumns(kind.columns, order), [kind, order]);
  const visibleColumns = useMemo(
    () =>
      applyWidths(
        orderedColumns.filter((c) => !hidden.has(c.id)),
        widths,
      ),
    [orderedColumns, hidden, widths],
  );
  const sort = resolveSort(kind, sortPref);

  const isPods = kindKey === BUILTIN.Pod.key;
  const isNodes = kindKey === BUILTIN.Node.key;
  const podMetrics = usePodMetrics(clusterId, namespaces, active && isPods);
  const nodeMetrics = useNodeMetrics(clusterId, active && isNodes);
  const now = useNow(30_000, active);

  const ctx: ColumnContext = useMemo(
    () => ({
      clusterId,
      now,
      apiResources,
      podMetrics,
      nodeMetrics,
      navigate: (ref) => {
        const target = resolveRef(ref.apiVersion, ref.kind, apiResources);
        if (target) navigateTo(clusterId, target, ref.namespace ?? null, ref.name);
      },
    }),
    [clusterId, now, apiResources, podMetrics, nodeMetrics],
  );

  const sortsByMetric = METRIC_COLUMNS.has(sort.column) && (isPods || isNodes);
  const filtered = useMemo(
    () => filterItems(snapshot.items, filter, kind),
    [snapshot.items, filter, kind],
  );
  const items = useMemo(
    () => sortItems(filtered, kind.columns, sort, ctx),
    // Re-sorting on every clock tick is pointless unless the sort depends on metrics.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, kind, sort.column, sort.desc, sortsByMetric ? ctx : null],
  );

  return {
    snapshot,
    kind,
    hidden,
    orderedColumns,
    visibleColumns,
    sort,
    filter,
    items,
    ctx,
    watchNs,
  };
}
