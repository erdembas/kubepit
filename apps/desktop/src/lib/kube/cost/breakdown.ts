import * as i18n from '@/i18n/core';
import type { CostAggregate, CostItem, CostReport } from '@/types';

/**
 * Cost breakdown rows (pure): labels of the special rows, filtering by the
 * workbench namespaces and a search, sorting, shares and the CSV export.
 * Row names are Kubernetes data (namespaces, workloads, label values) and
 * are never translated; only the special markers are.
 */

export const IDLE = '__idle__';
export const UNALLOCATED = '__unallocated__';

/** Label keys offered for the label breakdown (any key can be typed). */
export const LABEL_SUGGESTIONS = [
  'team',
  'app.kubernetes.io/part-of',
  'app.kubernetes.io/name',
  'app',
  'owner',
  'cost-center',
] as const;

export type CostSortKey = 'name' | 'total' | 'cpu' | 'memory' | 'storage' | 'efficiency';

/** Display name of a row: the Kubernetes name, or what a special row stands for. */
export function itemLabel(item: CostItem, aggregate: CostAggregate): string {
  if (item.special === 'idle') return i18n.t('Idle capacity');
  if (item.special === 'unallocated') {
    if (aggregate === 'label') return i18n.t('No label');
    if (aggregate === 'workload')
      return item.storage_bytes > 0 && item.pods === 0
        ? i18n.t('Unmounted volumes')
        : i18n.t('Standalone pods and volumes');
    return i18n.t('Unallocated');
  }
  return item.name;
}

/** Rows of the selected namespaces (all when empty) matching `query`. */
export function filterItems(
  items: readonly CostItem[],
  aggregate: CostAggregate,
  namespaces: readonly string[],
  query: string,
  showIdle: boolean,
): CostItem[] {
  const q = query.trim().toLowerCase();
  const scoped = aggregate !== 'label' && namespaces.length > 0;
  return items.filter((item) => {
    if (item.special === 'idle') return showIdle && !scoped && !q;
    if (scoped && (!item.namespace || !namespaces.includes(item.namespace))) return false;
    if (!q) return true;
    return `${item.name} ${item.namespace ?? ''} ${item.kind ?? ''} ${itemLabel(item, aggregate)}`
      .toLowerCase()
      .includes(q);
  });
}

function sortValue(item: CostItem, key: CostSortKey): number {
  switch (key) {
    case 'cpu':
      return item.cpu_cost;
    case 'memory':
      return item.memory_cost;
    case 'storage':
      return item.storage_cost;
    case 'efficiency':
      return item.efficiency ?? -1;
    default:
      return item.total_cost;
  }
}

/** Sorted copy; special rows stay at the bottom. */
export function sortItems(
  items: readonly CostItem[],
  key: CostSortKey,
  desc: boolean,
  aggregate: CostAggregate,
): CostItem[] {
  const dir = desc ? -1 : 1;
  return [...items].sort((a, b) => {
    if (!!a.special !== !!b.special) return a.special ? 1 : -1;
    if (key === 'name') return dir * itemLabel(a, aggregate).localeCompare(itemLabel(b, aggregate));
    return dir * (sortValue(a, key) - sortValue(b, key)) || a.key.localeCompare(b.key);
  });
}

/** Share of `value` in `total`, 0–1. */
export function share(value: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
}

/** Efficiency band for colouring: usage ÷ requests. */
export function efficiencyTone(value: number | null): 'good' | 'fair' | 'poor' | null {
  if (value == null) return null;
  if (value >= 0.6) return 'good';
  if (value >= 0.3) return 'fair';
  return 'poor';
}

const round = (n: number, digits: number) => {
  const f = 10 ** digits;
  return String(Math.round(n * f) / f);
};

/**
 * CSV header and rows of the visible breakdown. Numbers are plain
 * (dot decimals, no grouping) so spreadsheets parse them; amounts are
 * monthly in the report currency.
 */
export function breakdownCsv(
  report: CostReport,
  items: readonly CostItem[],
): { header: string[]; rows: string[][] } {
  const aggregate = report.aggregate;
  const first =
    aggregate === 'namespace'
      ? i18n.t('Namespace')
      : aggregate === 'workload'
        ? i18n.t('Workload')
        : (report.label ?? i18n.t('Label'));
  const header = [
    first,
    ...(aggregate === 'workload' ? [i18n.t('Kind'), i18n.t('Namespace')] : []),
    i18n.t('Pods'),
    i18n.t('CPU requests (cores)'),
    i18n.t('CPU usage (cores)'),
    i18n.t('Memory requests (GiB)'),
    i18n.t('Memory usage (GiB)'),
    i18n.t('Volumes (GiB)'),
    i18n.t('CPU cost ({currency}/month)', { currency: report.currency }),
    i18n.t('Memory cost ({currency}/month)', { currency: report.currency }),
    i18n.t('GPU cost ({currency}/month)', { currency: report.currency }),
    i18n.t('Storage cost ({currency}/month)', { currency: report.currency }),
    i18n.t('Other cost ({currency}/month)', { currency: report.currency }),
    i18n.t('Total ({currency}/month)', { currency: report.currency }),
    i18n.t('Efficiency'),
  ];
  const gib = 1024 ** 3;
  const opt = (v: number | null, digits: number) => (v == null ? '' : round(v, digits));
  const rows = items.map((i) => [
    i.special ? itemLabel(i, aggregate) : i.name,
    ...(aggregate === 'workload' ? [i.kind ?? '', i.namespace ?? ''] : []),
    String(i.pods),
    round(i.cpu_request_cores, 3),
    opt(i.cpu_usage_cores, 3),
    round(i.memory_request_bytes / gib, 3),
    opt(i.memory_usage_bytes == null ? null : i.memory_usage_bytes / gib, 3),
    round(i.storage_bytes / gib, 2),
    round(i.cpu_cost, 2),
    round(i.memory_cost, 2),
    round(i.gpu_cost, 2),
    round(i.storage_cost, 2),
    round(i.other_cost, 2),
    round(i.total_cost, 2),
    opt(i.efficiency, 3),
  ]);
  return { header, rows };
}
