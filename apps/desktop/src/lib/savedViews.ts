/**
 * Saved table views (pure). A view is a named snapshot of one kind's table
 * state — filter text, namespace selection, column visibility / order /
 * widths and sort — kept per cluster or for every cluster. Column prefs are
 * stored exactly as the workbench keeps them (`hiddenColumns` toggles,
 * `columnOrder`, `columnWidths`), so applying a view restores them as is.
 */

export interface ViewSort {
  column: string;
  desc: boolean;
}

export interface TableState {
  filter: string;
  /** `null` = the view leaves the namespace selection alone; `[]` = all namespaces. */
  namespaces: string[] | null;
  /** Raw `hiddenColumns` toggles of the kind; `[]` = the kind's defaults. */
  hiddenColumns: string[];
  columnOrder: string[];
  columnWidths: Record<string, number>;
  /** `null` = the kind's default sort. */
  sort: ViewSort | null;
}

export interface SavedView extends TableState {
  id: string;
  name: string;
  kindKey: string;
  /** `null` = offered on every cluster. */
  clusterId: string | null;
  createdAt: number;
}

/** Key of a default-view entry: `${clusterId}|${kindKey}`, `*|${kindKey}` for every cluster. */
export function defaultKey(clusterId: string | null, kindKey: string): string {
  return `${clusterId ?? '*'}|${kindKey}`;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Views of a kind offered on a cluster: this cluster's first, then global ones, by name. */
export function viewsFor(
  views: readonly SavedView[],
  clusterId: string,
  kindKey: string,
): SavedView[] {
  return views
    .filter((v) => v.kindKey === kindKey && (v.clusterId === null || v.clusterId === clusterId))
    .sort(
      (a, b) =>
        Number(a.clusterId === null) - Number(b.clusterId === null) ||
        collator.compare(a.name, b.name),
    );
}

/** Every view offered on a cluster (any kind). */
export function viewsOnCluster(views: readonly SavedView[], clusterId: string): SavedView[] {
  return views.filter((v) => v.clusterId === null || v.clusterId === clusterId);
}

/** The default view of a kind on a cluster: the cluster's own beats the global one. */
export function resolveDefault(
  views: readonly SavedView[],
  defaults: Readonly<Record<string, string>>,
  clusterId: string,
  kindKey: string,
): SavedView | null {
  for (const key of [defaultKey(clusterId, kindKey), defaultKey(null, kindKey)]) {
    const id = defaults[key];
    const view = id ? views.find((v) => v.id === id) : undefined;
    if (view && (view.clusterId === null || view.clusterId === clusterId)) return view;
  }
  return null;
}

/** Whether `view` is a default (for its own scope). */
export function isDefault(view: SavedView, defaults: Readonly<Record<string, string>>): boolean {
  return defaults[defaultKey(view.clusterId, view.kindKey)] === view.id;
}

const sorted = (list: readonly string[]) => [...list].sort();
const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
const sameWidths = (a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>) => {
  const ka = Object.keys(a).filter((k) => a[k]);
  const kb = Object.keys(b).filter((k) => b[k]);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
};

/** True while the table still shows exactly what `view` saved. */
export function matchesView(view: TableState, current: TableState): boolean {
  if (view.filter.trim() !== current.filter.trim()) return false;
  if (
    view.namespaces !== null &&
    (current.namespaces === null || !sameList(sorted(view.namespaces), sorted(current.namespaces)))
  )
    return false;
  if (!sameList(sorted(view.hiddenColumns), sorted(current.hiddenColumns))) return false;
  if (view.columnOrder.length && !sameList(view.columnOrder, current.columnOrder)) return false;
  if (!view.columnOrder.length && current.columnOrder.length) return false;
  if (!sameWidths(view.columnWidths, current.columnWidths)) return false;
  const a = view.sort;
  const b = current.sort;
  return a === null ? b === null : !!b && a.column === b.column && a.desc === b.desc;
}

/** `name`, or `name 2`, `name 3`… when a view of the same kind and scope already uses it. */
export function uniqueName(
  views: readonly SavedView[],
  name: string,
  kindKey: string,
  clusterId: string | null,
  exceptId?: string,
): string {
  const base = name.trim();
  const taken = new Set(
    views
      .filter((v) => v.kindKey === kindKey && v.clusterId === clusterId && v.id !== exceptId)
      .map((v) => v.name.toLowerCase()),
  );
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}
