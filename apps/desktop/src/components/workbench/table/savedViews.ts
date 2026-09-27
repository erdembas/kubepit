import { useMemo } from 'react';
import { create } from 'zustand';
import { resolveDefault, type SavedView, type TableState } from '@/lib/savedViews';
import { useAppStore } from '@/store/useAppStore';
import { useSavedViewsStore } from '@/store/useSavedViewsStore';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';

/**
 * Saved views on top of the workbench store: read a kind's table state,
 * apply a view, apply a kind's default view once per session. Every piece
 * of table state already lives in stores (filter per cluster+kind, column
 * prefs and sort per kind, namespaces per cluster), so views can be applied
 * from anywhere, including the command palette.
 */

const NONE: readonly string[] = [];

function effectiveNamespaces(clusterId: string): string[] {
  const stored = useWorkbenchStore.getState().namespaces[clusterId];
  if (stored) return stored;
  const fallback = useAppStore
    .getState()
    .clusters.find((c) => c.id === clusterId)?.default_namespace;
  return fallback ? [fallback] : [];
}

/** The kind's table state right now (`withNamespaces` false leaves namespaces out). */
export function currentTableState(
  clusterId: string,
  kindKey: string,
  withNamespaces = true,
): TableState {
  const s = useWorkbenchStore.getState();
  return {
    filter: s.filters[`${clusterId}|${kindKey}`] ?? '',
    namespaces: withNamespaces ? [...effectiveNamespaces(clusterId)] : null,
    hiddenColumns: [...(s.hiddenColumns[kindKey] ?? [])],
    columnOrder: [...(s.columnOrder[kindKey] ?? [])],
    columnWidths: { ...s.columnWidths[kindKey] },
    sort: s.sort[kindKey] ? { ...s.sort[kindKey] } : null,
  };
}

/** Live table state of a kind, for "modified" markers. */
export function useTableState(clusterId: string, kindKey: string): TableState {
  const filter = useWorkbenchStore((s) => s.filters[`${clusterId}|${kindKey}`] ?? '');
  const stored = useWorkbenchStore((s) => s.namespaces[clusterId]);
  const fallback = useAppStore(
    (s) => s.clusters.find((c) => c.id === clusterId)?.default_namespace ?? null,
  );
  const hidden = useWorkbenchStore((s) => s.hiddenColumns[kindKey] ?? NONE);
  const order = useWorkbenchStore((s) => s.columnOrder[kindKey] ?? NONE);
  const widths = useWorkbenchStore((s) => s.columnWidths[kindKey]);
  const sort = useWorkbenchStore((s) => s.sort[kindKey] ?? null);
  return useMemo(
    () => ({
      filter,
      namespaces: stored ?? (fallback ? [fallback] : []),
      hiddenColumns: [...hidden],
      columnOrder: [...order],
      columnWidths: { ...widths },
      sort,
    }),
    [filter, stored, fallback, hidden, order, widths, sort],
  );
}

function withEntry<T>(map: Record<string, T>, key: string, value: T | null): Record<string, T> {
  const next = { ...map };
  if (value === null) delete next[key];
  else next[key] = value;
  return next;
}

/** Restore `view` on a cluster; `open` also focuses the kind's tab. */
export function applySavedView(clusterId: string, view: SavedView, open = false) {
  const k = view.kindKey;
  useWorkbenchStore.setState((s) => ({
    filters: { ...s.filters, [`${clusterId}|${k}`]: view.filter },
    namespaces: view.namespaces
      ? { ...s.namespaces, [clusterId]: [...new Set(view.namespaces)].sort() }
      : s.namespaces,
    hiddenColumns: withEntry(
      s.hiddenColumns,
      k,
      view.hiddenColumns.length ? [...view.hiddenColumns] : null,
    ),
    columnOrder: withEntry(
      s.columnOrder,
      k,
      view.columnOrder.length ? [...view.columnOrder] : null,
    ),
    columnWidths: withEntry(
      s.columnWidths,
      k,
      Object.keys(view.columnWidths).length ? { ...view.columnWidths } : null,
    ),
    sort: withEntry(s.sort, k, view.sort ? { ...view.sort } : null),
  }));
  useSavedViewsStore.getState().markApplied(clusterId, k, view.id);
  if (open) useWorkbenchStore.getState().setActiveKind(clusterId, k);
}

/** Back to the kind's defaults: no filter, default columns and sort (namespaces stay). */
export function clearTableView(clusterId: string, kindKey: string) {
  useWorkbenchStore.setState((s) => ({
    filters: { ...s.filters, [`${clusterId}|${kindKey}`]: '' },
    hiddenColumns: withEntry(s.hiddenColumns, kindKey, null),
    columnOrder: withEntry(s.columnOrder, kindKey, null),
    columnWidths: withEntry(s.columnWidths, kindKey, null),
    sort: withEntry(s.sort, kindKey, null),
  }));
  useSavedViewsStore.getState().markApplied(clusterId, kindKey, null);
}

/** Overwrite `view` with the kind's current state (namespaces only if it saved them). */
export function updateSavedView(clusterId: string, view: SavedView) {
  const state = currentTableState(clusterId, view.kindKey, view.namespaces !== null);
  useSavedViewsStore.getState().update(view.id, state);
  useSavedViewsStore.getState().markApplied(clusterId, view.kindKey, view.id);
}

const defaultsApplied = new Set<string>();

/**
 * Apply the kind's default view the first time its table opens in this
 * session (tabs moved between panes remount; that must not reset them).
 */
export function applyDefaultViewOnce(clusterId: string, kindKey: string) {
  const key = `${clusterId}|${kindKey}`;
  if (defaultsApplied.has(key)) return;
  defaultsApplied.add(key);
  const { views, defaults, applied } = useSavedViewsStore.getState();
  if (applied[key]) return;
  const view = resolveDefault(views, defaults, clusterId, kindKey);
  if (view) applySavedView(clusterId, view);
}

/** The "Save view" dialog, opened from the views menu or the palette. */
interface SaveViewDialogState {
  target: { clusterId: string; kindKey: string } | null;
  open: (clusterId: string, kindKey: string) => void;
  close: () => void;
}

export const useSaveViewDialog = create<SaveViewDialogState>((set) => ({
  target: null,
  open: (clusterId, kindKey) => set({ target: { clusterId, kindKey } }),
  close: () => set({ target: null }),
}));
