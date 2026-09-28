import { bench } from 'vitest';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import { columnsFor, type ColumnContext } from '@/lib/kube/columns';
import { BENCH_NOW, tableItems } from '@/lib/perf/fixtures';
import { filterItems, resolveSort, sortItems } from './tableModel';

// Budget ids are the bench names (`perf/budgets.json`). Inputs are built once.

const items = tableItems('l');
const kind = columnsFor(BUILTIN.Pod.key, toGvk(BUILTIN.Pod), null);
const sort = resolveSort(kind, undefined);
const NO_METRICS = { available: false, byKey: new Map() };
const ctx: ColumnContext = {
  clusterId: 'c-scale-l',
  now: BENCH_NOW,
  apiResources: null,
  podMetrics: NO_METRICS,
  nodeMetrics: NO_METRICS,
  navigate: () => undefined,
};

// `ns-` matches every row: the filter reads all of them and the sort gets all 20 000.
bench(
  'table/filter_sort_20k',
  () => void sortItems(filterItems(items, 'ns-', kind), kind.columns, sort, ctx),
  { time: 2000 },
);
