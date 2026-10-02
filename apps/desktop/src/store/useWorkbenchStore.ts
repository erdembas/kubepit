import { useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { gvkForKey, kindKey, resolveKindName } from '@/lib/kube/catalog';
import { VIEW_KEYS } from '@/lib/kube/nav';
import { registerObjectNavigator } from '@/lib/navigation';
import { windowSeed } from '@/lib/windowSeed';
import { useAppStore } from '@/store/useAppStore';
import type { ApiResourceInfo, ClusterId, Gvk } from '@/types';
import * as layouts from './viewLayout';
import type { SplitSide, ViewLayout } from './viewLayout';
import { syncPreferences, windowStorage } from './windowStorage';

/**
 * Cluster workbench UI state. One entry per cluster for navigation
 * (split panes with their view tabs, active kind, namespaces, selected
 * object per tab) plus global layout prefs. Layout prefs, namespaces, panes,
 * pins and the active kind persist to localStorage (`kubepit.workbench.v1`);
 * with several windows only `main` persists that session and every window
 * shares the layout prefs (see `windowStorage.ts`);
 * selections and discovery data are session-only.
 *
 * Every view (kind list or pseudo page) opens in its own tab, at most once
 * per cluster (see `viewLayout.ts`); `activeKind` mirrors the focused
 * pane's active tab ('' while that pane is empty). Other surfaces (command
 * palette, shell links) drive the workbench through
 * `setActiveKind(clusterId, kindKey)` and `navigateTo(clusterId, gvk, ns, name)`.
 */

/** Pseudo kind keys for the non-resource pages of the navigator. */
export const VIEW = VIEW_KEYS;

export type ViewKey = string;

export interface ObjectSelection {
  key: string;
  namespace: string | null;
  name: string;
}

export interface SortPref {
  column: string;
  desc: boolean;
}

interface PendingNav {
  kind: string;
  namespace: string | null;
  name: string | null;
}

export const NAV_WIDTH = { min: 180, max: 360, default: 220 };
export const DETAILS_WIDTH = { min: 380, max: 1100, default: 560 };

interface WorkbenchState {
  /** Selected namespaces per cluster; missing = cluster default, [] = all namespaces. */
  namespaces: Record<ClusterId, string[]>;
  /** Split panes and their tabs per cluster; read through `useViewLayout`. */
  layouts: Record<ClusterId, ViewLayout>;
  activeKind: Record<ClusterId, ViewKey>;
  /** Pinned view tabs per cluster (separate from the navigator's favourite kinds). */
  pinnedTabKeys: Record<ClusterId, ViewKey[]>;
  /**
   * The ephemeral tab per cluster: a single click in the navigator replaces
   * it instead of opening another tab (VS Code's preview tab). Null while
   * the cluster has none; a double click (or pin) makes it permanent.
   */
  previewTabKeys: Record<ClusterId, ViewKey | null>;
  /** Selected object per cluster and view tab (the tab's details panel). */
  selection: Record<ClusterId, Record<ViewKey, ObjectSelection>>;
  /**
   * Bumped on every programmatic navigation so views can scroll the target
   * into view. Keyed by `${clusterId}|${kindKey}`.
   */
  navRevision: Record<string, number>;
  /** Reveal a tab even when its already active navigator row is clicked again. */
  viewRevealRevision: Record<string, number>;
  /** CRD kinds reached through links before discovery arrived. */
  customKinds: Record<ClusterId, Record<string, Gvk>>;
  apiResources: Record<ClusterId, ApiResourceInfo[]>;
  pendingNav: Record<ClusterId, PendingNav>;
  /** Table text filters keyed by `${clusterId}|${kindKey}`. */
  filters: Record<string, string>;

  navWidth: number;
  navCollapsed: boolean;
  collapsedGroups: Record<string, boolean>;
  pinnedKinds: string[];
  hiddenColumns: Record<string, string[]>;
  /** Column ids per kind in the user's order (fixed columns keep their place). */
  columnOrder: Record<string, string[]>;
  /** Column widths in px per kind, set by dragging a header edge. */
  columnWidths: Record<string, Record<string, number>>;
  sort: Record<string, SortPref>;
  detailsWidth: number;

  setNamespaces: (clusterId: ClusterId, namespaces: string[]) => void;
  /**
   * Focus a view's tab, opening it in the focused pane when needed.
   * `preview` opens it as the cluster's ephemeral tab (replacing the
   * previous one); `keep` makes the current ephemeral tab permanent.
   */
  setActiveKind: (
    clusterId: ClusterId,
    key: ViewKey,
    mode?: { preview?: boolean; keep?: boolean },
  ) => void;
  /** Make the cluster's ephemeral tab permanent (double click, tab pin). */
  keepPreviewTab: (clusterId: ClusterId) => void;
  closeTab: (clusterId: ClusterId, key: ViewKey) => void;
  closeOtherTabs: (clusterId: ClusterId, key: ViewKey) => void;
  closeTabsToRight: (clusterId: ClusterId, key: ViewKey) => void;
  closeAllTabs: (clusterId: ClusterId, paneId: string) => void;
  toggleTabPin: (clusterId: ClusterId, key: ViewKey) => void;
  moveTabLeft: (clusterId: ClusterId, key: ViewKey) => void;
  moveTabRight: (clusterId: ClusterId, key: ViewKey) => void;
  /** Move an unpinned tab before `index` (end when omitted), always after the destination's pins. */
  moveTab: (clusterId: ClusterId, key: ViewKey, paneId: string, index?: number) => void;
  /** Open a pane beside `paneId`, moving `key` into it or leaving it empty. */
  splitPane: (clusterId: ClusterId, paneId: string, side: SplitSide, key?: ViewKey | null) => void;
  closePane: (clusterId: ClusterId, paneId: string) => void;
  focusPane: (clusterId: ClusterId, paneId: string) => void;
  resizePanes: (clusterId: ClusterId, sizes: Record<string, number>) => void;
  select: (clusterId: ClusterId, key: ViewKey, selection: ObjectSelection | null) => void;
  registerKind: (clusterId: ClusterId, gvk: Gvk) => void;
  setApiResources: (clusterId: ClusterId, resources: ApiResourceInfo[]) => void;
  setFilter: (clusterId: ClusterId, key: string, text: string) => void;
  setNavWidth: (width: number) => void;
  setNavCollapsed: (collapsed: boolean) => void;
  toggleGroup: (id: string) => void;
  togglePinned: (key: string) => void;
  toggleColumn: (kind: string, column: string) => void;
  resetColumns: (kind: string) => void;
  setColumnOrder: (kind: string, order: string[]) => void;
  /** `null` restores the column's default width. */
  setColumnWidth: (kind: string, column: string, width: number | null) => void;
  setSort: (kind: string, column: string) => void;
  setDetailsWidth: (width: number) => void;
  /** Forget session state of a disconnected cluster. */
  forgetCluster: (clusterId: ClusterId) => void;
}

const STORAGE_KEY = 'kubepit.workbench.v1';
const STORAGE_VERSION = 4;
/** Persisted per window; the rest of the persisted state is shared layout prefs. */
const SESSION_KEYS = ['namespaces', 'layouts', 'activeKind', 'pinnedTabKeys'] as const;
const PREF_KEYS = [
  'navWidth',
  'navCollapsed',
  'collapsedGroups',
  'pinnedKinds',
  'hiddenColumns',
  'columnOrder',
  'columnWidths',
  'sort',
  'detailsWidth',
] as const;
type Persisted = Pick<WorkbenchState, (typeof SESSION_KEYS)[number] | (typeof PREF_KEYS)[number]>;

const clamp = (n: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, n)));

function layoutOf(s: WorkbenchState, clusterId: ClusterId): ViewLayout {
  return s.layouts[clusterId] ?? layouts.singleLayout(s.activeKind[clusterId]);
}

/**
 * A pin never gets pulled into an empty focused pane by navigator navigation.
 * `replace` swaps the cluster's ephemeral tab for the new key in its own pane
 * (VS Code's preview tab) instead of opening another tab.
 */
function openTab(
  s: WorkbenchState,
  clusterId: ClusterId,
  key: ViewKey,
  replace: ViewKey | null = null,
): ViewLayout {
  let layout = layoutOf(s, clusterId);
  if (s.pinnedTabKeys[clusterId]?.includes(key)) {
    const owner = layouts.groupOf(layout, key);
    if (owner) layout = layouts.focusPane(layout, owner.id);
  }
  if (replace != null && replace !== key) {
    const owner = layouts.groupOf(layout, replace);
    layout = owner ? layouts.replaceView(layout, replace, key) : layouts.openView(layout, key);
  } else layout = layouts.openView(layout, key);
  return layout;
}

function revealTab(s: WorkbenchState, clusterId: ClusterId, key: ViewKey) {
  const revision = `${clusterId}|${key}`;
  return {
    ...s.viewRevealRevision,
    [revision]: (s.viewRevealRevision[revision] ?? 0) + 1,
  };
}

/**
 * State patch storing a cluster's layout and its `activeKind` mirror.
 * Closed tabs that are no longer open anywhere forget their selection and filter.
 */
function commit(
  s: WorkbenchState,
  clusterId: ClusterId,
  layout: ViewLayout,
  closed: readonly ViewKey[] = [],
  pins: readonly ViewKey[] = s.pinnedTabKeys[clusterId] ?? [],
): Partial<WorkbenchState> {
  const open = layouts.openKeys(layout);
  const pinned = [...new Set(pins)]
    .filter((key) => open.has(key))
    .slice(0, layouts.MAX_PINNED_VIEW_TABS);
  layout = layouts.withPinnedTabs(layout, new Set(pinned));
  const patch: Partial<WorkbenchState> = {
    layouts: { ...s.layouts, [clusterId]: layout },
    activeKind: { ...s.activeKind, [clusterId]: layouts.focusedGroup(layout).active ?? '' },
  };
  const previous = s.pinnedTabKeys[clusterId] ?? [];
  if (pinned.length !== previous.length || pinned.some((key, i) => key !== previous[i])) {
    const pinnedTabKeys = { ...s.pinnedTabKeys };
    if (pinned.length) pinnedTabKeys[clusterId] = pinned;
    else delete pinnedTabKeys[clusterId];
    patch.pinnedTabKeys = pinnedTabKeys;
  }
  const gone = closed.filter((k) => !open.has(k));
  if (gone.length) {
    const selection = { ...s.selection[clusterId] };
    const filters = { ...s.filters };
    const viewRevealRevision = { ...s.viewRevealRevision };
    for (const key of gone) {
      delete selection[key];
      delete filters[`${clusterId}|${key}`];
      delete viewRevealRevision[`${clusterId}|${key}`];
    }
    patch.selection = { ...s.selection, [clusterId]: selection };
    patch.filters = filters;
    patch.viewRevealRevision = viewRevealRevision;
    const preview = s.previewTabKeys[clusterId];
    if (preview != null && !open.has(preview)) {
      const previewTabKeys = { ...s.previewTabKeys };
      delete previewTabKeys[clusterId];
      patch.previewTabKeys = previewTabKeys;
    }
  }
  return patch;
}

/** State patch that closes tabs of the pane holding `key`. */
function closeIn(
  s: WorkbenchState,
  clusterId: ClusterId,
  key: ViewKey,
  pick: (k: ViewKey, index: number, at: number) => boolean,
  keepPinned = false,
): Partial<WorkbenchState> {
  const layout = layoutOf(s, clusterId);
  const pane = layouts.groupOf(layout, key);
  if (!pane) return {};
  const at = pane.tabs.indexOf(key);
  const pinned = new Set(s.pinnedTabKeys[clusterId]);
  const result = layouts.closeViews(
    layout,
    pane.id,
    (k, i) => (!keepPinned || !pinned.has(k)) && pick(k, i, at),
  );
  return result.closed.length ? commit(s, clusterId, result.layout, result.closed) : {};
}

/** Move an unpinned tab one place without changing the pane's active view. */
function swapTab(s: WorkbenchState, clusterId: ClusterId, key: ViewKey, step: -1 | 1) {
  const layout = layoutOf(s, clusterId);
  const pane = layouts.groupOf(layout, key);
  const pinned = new Set(s.pinnedTabKeys[clusterId]);
  if (!pane || pinned.has(key)) return {};
  const at = pane.tabs.indexOf(key);
  const other = pane.tabs[at + step];
  if (!other || pinned.has(other)) return {};
  const tabs = [...pane.tabs];
  tabs[at] = other;
  tabs[at + step] = key;
  return commit(s, clusterId, layouts.withPaneTabs(layout, pane.id, tabs));
}

export const useWorkbenchStore = create<WorkbenchState>()(
  persist<WorkbenchState, [], [], Persisted>(
    (set, get) => ({
      namespaces: {},
      layouts: {},
      activeKind: {},
      pinnedTabKeys: {},
      previewTabKeys: {},
      selection: {},
      navRevision: {},
      viewRevealRevision: {},
      customKinds: {},
      apiResources: {},
      pendingNav: {},
      filters: {},
      navWidth: NAV_WIDTH.default,
      navCollapsed: false,
      collapsedGroups: {},
      pinnedKinds: [],
      hiddenColumns: {},
      columnOrder: {},
      columnWidths: {},
      sort: {},
      detailsWidth: DETAILS_WIDTH.default,

      setNamespaces: (clusterId, namespaces) =>
        set((s) => ({
          namespaces: { ...s.namespaces, [clusterId]: [...new Set(namespaces)].sort() },
        })),
      setActiveKind: (clusterId, key, mode) =>
        set((s) => {
          // `preview` (navigator, preview mode) replaces the ephemeral tab;
          // a persistent open (navigator, persistent mode) promotes it, like
          // VS Code locking its preview on a non-preview open. Focusing an
          // already open tab (tab strip) changes no tab's permanence, and an
          // explicit `keep` (double click) promotes it.
          const explicit = mode != null;
          const preview = mode?.preview ?? false;
          const previous = s.previewTabKeys[clusterId] ?? null;
          const keep = !!mode?.keep || (explicit && !preview);
          const replaced = preview ? previous : null;
          const open = replaced === key ? null : replaced;
          return {
            ...commit(s, clusterId, openTab(s, clusterId, key, open), open ? [open] : []),
            previewTabKeys: keep
              ? { ...s.previewTabKeys, [clusterId]: null }
              : { ...s.previewTabKeys, [clusterId]: preview ? key : previous },
            viewRevealRevision: revealTab(s, clusterId, key),
          };
        }),
      keepPreviewTab: (clusterId) =>
        set((s) => {
          const preview = s.previewTabKeys[clusterId];
          if (preview == null) return {};
          return { previewTabKeys: { ...s.previewTabKeys, [clusterId]: null } };
        }),
      closeTab: (clusterId, key) => set((s) => closeIn(s, clusterId, key, (k) => k === key)),
      closeOtherTabs: (clusterId, key) =>
        set((s) => closeIn(s, clusterId, key, (k) => k !== key, true)),
      closeTabsToRight: (clusterId, key) =>
        set((s) => closeIn(s, clusterId, key, (_, i, at) => i > at, true)),
      closeAllTabs: (clusterId, paneId) =>
        set((s) => {
          const pinned = new Set(s.pinnedTabKeys[clusterId]);
          const result = layouts.closeViews(layoutOf(s, clusterId), paneId, (k) => !pinned.has(k));
          return result.closed.length ? commit(s, clusterId, result.layout, result.closed) : {};
        }),
      toggleTabPin: (clusterId, key) =>
        set((s) => {
          const layout = layoutOf(s, clusterId);
          const pane = layouts.groupOf(layout, key);
          if (!pane) return {};
          const pinned = s.pinnedTabKeys[clusterId] ?? [];
          if (!pinned.includes(key) && pinned.length >= layouts.MAX_PINNED_VIEW_TABS) return {};
          const next = pinned.includes(key) ? pinned.filter((k) => k !== key) : [...pinned, key];
          // Pin at the end of the pinned group; unpin at the start of the rest.
          const rest = pane.tabs.filter((k) => k !== key);
          const at = layouts.pinBoundary(rest, new Set(next));
          const tabs = [...rest.slice(0, at), key, ...rest.slice(at)];
          // A pinned tab is never ephemeral.
          const previewTabKeys = { ...s.previewTabKeys };
          if (previewTabKeys[clusterId] === key) previewTabKeys[clusterId] = null;
          return {
            ...commit(s, clusterId, layouts.withPaneTabs(layout, pane.id, tabs), [], next),
            previewTabKeys,
          };
        }),
      moveTabLeft: (clusterId, key) => set((s) => swapTab(s, clusterId, key, -1)),
      moveTabRight: (clusterId, key) => set((s) => swapTab(s, clusterId, key, 1)),
      moveTab: (clusterId, key, paneId, index) =>
        set((s) => {
          const layout = layoutOf(s, clusterId);
          const pinned = new Set(s.pinnedTabKeys[clusterId]);
          const pane = layout.groups.find((g) => g.id === paneId);
          if (pinned.has(key) || !pane || !layouts.groupOf(layout, key)) return {};
          const rest = pane.tabs.filter((k) => k !== key);
          const at = Math.max(
            layouts.pinBoundary(rest, pinned),
            Math.min(index ?? rest.length, rest.length),
          );
          // Dragging an ephemeral tab out of its pane makes it permanent.
          const previewTabKeys = { ...s.previewTabKeys };
          const movedPreview = previewTabKeys[clusterId] === key;
          if (movedPreview) previewTabKeys[clusterId] = null;
          return {
            ...commit(s, clusterId, layouts.moveView(layout, key, paneId, at)),
            ...(movedPreview && { previewTabKeys }),
          };
        }),
      splitPane: (clusterId, paneId, side, key = null) =>
        set((s) => {
          if (key && s.pinnedTabKeys[clusterId]?.includes(key)) return {};
          // Splitting an ephemeral tab into its own pane makes it permanent.
          const previewTabKeys = { ...s.previewTabKeys };
          const splitPreview = key != null && previewTabKeys[clusterId] === key;
          if (splitPreview) previewTabKeys[clusterId] = null;
          return {
            ...commit(s, clusterId, layouts.splitView(layoutOf(s, clusterId), paneId, side, key)),
            ...(splitPreview && { previewTabKeys }),
          };
        }),
      closePane: (clusterId, paneId) =>
        set((s) => {
          let layout = layoutOf(s, clusterId);
          const at = layout.groups.findIndex((g) => g.id === paneId);
          const pane = layout.groups[at];
          if (!pane) return {};
          const pinned = new Set(s.pinnedTabKeys[clusterId]);
          const heir = layout.groups[at - 1] ?? layout.groups[at + 1];
          if (!heir) {
            const result = layouts.closeViews(layout, paneId, (key) => !pinned.has(key));
            return commit(s, clusterId, result.layout, result.closed);
          }
          for (const key of pane.tabs.filter((k) => pinned.has(k))) {
            const rest = layout.groups.find((g) => g.id === heir.id)!.tabs;
            layout = layouts.moveView(layout, key, heir.id, layouts.pinBoundary(rest, pinned));
          }
          const result = layouts.closePane(layout, paneId);
          return commit(s, clusterId, result.layout, result.closed);
        }),
      focusPane: (clusterId, paneId) =>
        set((s) => {
          const layout = layoutOf(s, clusterId);
          const next = layouts.focusPane(layout, paneId);
          return next === layout ? {} : commit(s, clusterId, next);
        }),
      resizePanes: (clusterId, sizes) =>
        set((s) => commit(s, clusterId, layouts.resizePanes(layoutOf(s, clusterId), sizes))),
      select: (clusterId, key, selection) =>
        set((s) => {
          const current = { ...s.selection[clusterId] };
          if (selection) current[key] = selection;
          else delete current[key];
          return { selection: { ...s.selection, [clusterId]: current } };
        }),
      registerKind: (clusterId, gvk) =>
        set((s) => ({
          customKinds: {
            ...s.customKinds,
            [clusterId]: { ...s.customKinds[clusterId], [kindKey(gvk)]: gvk },
          },
        })),
      setApiResources: (clusterId, resources) => {
        set((s) => ({ apiResources: { ...s.apiResources, [clusterId]: resources } }));
        const pending = get().pendingNav[clusterId];
        if (!pending) return;
        set((s) => {
          const next = { ...s.pendingNav };
          delete next[clusterId];
          return { pendingNav: next };
        });
        const gvk = resolveKindName(pending.kind, resources);
        if (gvk) navigateTo(clusterId, gvk, pending.namespace, pending.name);
      },
      setFilter: (clusterId, key, text) =>
        set((s) => ({ filters: { ...s.filters, [`${clusterId}|${key}`]: text } })),
      setNavWidth: (width) => set({ navWidth: clamp(width, NAV_WIDTH.min, NAV_WIDTH.max) }),
      setNavCollapsed: (navCollapsed) => set({ navCollapsed }),
      toggleGroup: (id) =>
        set((s) => ({ collapsedGroups: { ...s.collapsedGroups, [id]: !s.collapsedGroups[id] } })),
      togglePinned: (key) =>
        set((s) => ({
          pinnedKinds: s.pinnedKinds.includes(key)
            ? s.pinnedKinds.filter((k) => k !== key)
            : [...s.pinnedKinds, key],
        })),
      toggleColumn: (kind, column) =>
        set((s) => {
          const hidden = s.hiddenColumns[kind] ?? [];
          return {
            hiddenColumns: {
              ...s.hiddenColumns,
              [kind]: hidden.includes(column)
                ? hidden.filter((c) => c !== column)
                : [...hidden, column],
            },
          };
        }),
      resetColumns: (kind) =>
        set((s) => {
          const next = { ...s.hiddenColumns };
          const order = { ...s.columnOrder };
          const widths = { ...s.columnWidths };
          delete next[kind];
          delete order[kind];
          delete widths[kind];
          return { hiddenColumns: next, columnOrder: order, columnWidths: widths };
        }),
      setColumnOrder: (kind, order) =>
        set((s) => ({ columnOrder: { ...s.columnOrder, [kind]: order } })),
      setColumnWidth: (kind, column, width) =>
        set((s) => {
          const widths = { ...s.columnWidths[kind] };
          if (width === null) delete widths[column];
          else widths[column] = Math.round(width);
          return { columnWidths: { ...s.columnWidths, [kind]: widths } };
        }),
      setSort: (kind, column) =>
        set((s) => {
          const current = s.sort[kind];
          const desc = current?.column === column ? !current.desc : false;
          return { sort: { ...s.sort, [kind]: { column, desc } } };
        }),
      setDetailsWidth: (width) =>
        set({ detailsWidth: clamp(width, DETAILS_WIDTH.min, DETAILS_WIDTH.max) }),
      forgetCluster: (clusterId) =>
        set((s) => {
          const selection = { ...s.selection };
          const apiResources = { ...s.apiResources };
          const viewRevealRevision = { ...s.viewRevealRevision };
          const previewTabKeys = { ...s.previewTabKeys };
          delete selection[clusterId];
          delete apiResources[clusterId];
          delete previewTabKeys[clusterId];
          for (const key of Object.keys(viewRevealRevision))
            if (key.startsWith(`${clusterId}|`)) delete viewRevealRevision[key];
          return { selection, apiResources, viewRevealRevision, previewTabKeys };
        }),
    }),
    {
      name: STORAGE_KEY,
      version: STORAGE_VERSION,
      storage: windowStorage<Persisted>({
        session: SESSION_KEYS,
        seed: windowSeed?.workbench ?? null,
        version: STORAGE_VERSION,
      }),
      // v1 kept one flat tab list per cluster (`tabs`); it becomes a single pane.
      // v2 laid panes out on one axis; they become one split of the tree.
      // v3 had no pinned view tabs.
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Partial<WorkbenchState> & {
          tabs?: Record<ClusterId, ViewKey[]>;
        };
        if (version < 2) {
          const next: Record<ClusterId, ViewLayout> = {};
          for (const [clusterId, active] of Object.entries(state.activeKind ?? {}))
            next[clusterId] = layouts.singleLayout(active, state.tabs?.[clusterId]);
          state.layouts = next;
          delete state.tabs;
        } else if (version < 3) {
          const flat = (state.layouts ?? {}) as unknown as Record<ClusterId, layouts.FlatLayout>;
          const next: Record<ClusterId, ViewLayout> = {};
          for (const [clusterId, layout] of Object.entries(flat))
            next[clusterId] = layouts.fromFlatLayout(layout);
          state.layouts = next;
        }
        // An older secondary-window session may have picked up main's newer
        // pins while windowStorage combined it with the shared preferences.
        if (version < 4) state.pinnedTabKeys = {};
        return state as WorkbenchState;
      },
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<Persisted>;
        const next = { ...current, ...saved, pinnedTabKeys: {} } as WorkbenchState;
        for (const [clusterId, raw] of Object.entries(saved.pinnedTabKeys ?? {})) {
          if (!next.layouts[clusterId] && next.activeKind[clusterId] === undefined) continue;
          const pins = Array.isArray(raw) ? raw.filter((key) => typeof key === 'string') : [];
          Object.assign(next, commit(next, clusterId, layoutOf(next, clusterId), [], pins));
        }
        return next;
      },
      partialize: (s) => ({
        namespaces: s.namespaces,
        layouts: s.layouts,
        activeKind: s.activeKind,
        pinnedTabKeys: s.pinnedTabKeys,
        navWidth: s.navWidth,
        navCollapsed: s.navCollapsed,
        collapsedGroups: s.collapsedGroups,
        pinnedKinds: s.pinnedKinds,
        hiddenColumns: s.hiddenColumns,
        columnOrder: s.columnOrder,
        columnWidths: s.columnWidths,
        sort: s.sort,
        detailsWidth: s.detailsWidth,
      }),
    },
  ),
);

// Column, sort and navigator prefs changed in another window apply here too.
syncPreferences<WorkbenchState>(STORAGE_KEY, PREF_KEYS, useWorkbenchStore);

/** Resolve a kind key for a cluster: built-ins, discovery, then link-registered CRDs. */
export function gvkForCluster(clusterId: ClusterId, key: string): Gvk | null {
  const s = useWorkbenchStore.getState();
  return gvkForKey(key, s.apiResources[clusterId]) ?? s.customKinds[clusterId]?.[key] ?? null;
}

/** A cluster's split layout (a single overview pane until something opens). */
export function useViewLayout(clusterId: ClusterId): ViewLayout {
  const stored = useWorkbenchStore((s) => s.layouts[clusterId]);
  const active = useWorkbenchStore((s) => s.activeKind[clusterId]);
  return useMemo(() => stored ?? layouts.singleLayout(active), [stored, active]);
}

/** A cluster's current view layout, outside React (keyboard shortcuts). */
export function viewLayoutOf(clusterId: ClusterId): ViewLayout {
  return layoutOf(useWorkbenchStore.getState(), clusterId);
}

/**
 * Open (or focus) a kind's tab in a cluster workbench and optionally select
 * one object (the details panel opens on it). Also focuses the cluster's
 * main tab.
 */
export function navigateTo(
  clusterId: ClusterId,
  gvk: Gvk,
  namespace: string | null = null,
  name: string | null = null,
) {
  const key = kindKey(gvk);
  const store = useWorkbenchStore.getState();
  if (!gvkForKey(key, store.apiResources[clusterId])) store.registerKind(clusterId, gvk);
  const revision = `${clusterId}|${key}`;
  // Without a name the tab keeps whatever it had selected. Links and other
  // programmatic navigation open a permanent tab, never an ephemeral one.
  useWorkbenchStore.setState((s) => {
    const previous = s.previewTabKeys[clusterId] ?? null;
    return {
      ...commit(s, clusterId, openTab(s, clusterId, key)),
      ...(previous != null && { previewTabKeys: { ...s.previewTabKeys, [clusterId]: null } }),
      ...(name && {
        selection: {
          ...s.selection,
          [clusterId]: {
            ...s.selection[clusterId],
            [key]: { key, namespace: gvk.namespaced ? namespace : null, name },
          },
        },
      }),
      navRevision: { ...s.navRevision, [revision]: (s.navRevision[revision] ?? 0) + 1 },
      viewRevealRevision: revealTab(s, clusterId, key),
    };
  });
  const app = useAppStore.getState();
  if (app.activeMainTabKey !== `cluster:${clusterId}`) app.openCluster(clusterId);
}

/** Shell surfaces only know kind names; resolve them here (deferring CRDs until discovery). */
registerObjectNavigator((clusterId, kind, namespace, name) => {
  const gvk = resolveKindName(kind, useWorkbenchStore.getState().apiResources[clusterId]);
  if (gvk) {
    navigateTo(clusterId, gvk, namespace, name);
    return;
  }
  useWorkbenchStore.setState((s) => ({
    pendingNav: { ...s.pendingNav, [clusterId]: { kind, namespace, name } },
  }));
});
