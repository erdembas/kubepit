import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { gvkForKey, kindKey, resolveKindName } from '@/lib/kube/catalog';
import { VIEW_KEYS } from '@/lib/kube/nav';
import { registerObjectNavigator } from '@/lib/navigation';
import { useAppStore } from '@/store/useAppStore';
import type { ApiResourceInfo, ClusterId, Gvk } from '@/types';

/**
 * Cluster workbench UI state. One entry per cluster for navigation
 * (open view tabs, active kind, namespaces, selected object per tab) plus
 * global layout prefs. Layout prefs, namespaces, open tabs and the active
 * kind persist to localStorage (`kubepit.workbench.v1`); selections and
 * discovery data are session-only.
 *
 * Every view (kind list or pseudo page) opens in its own tab, at most once
 * per cluster; `activeKind` is the focused tab. Other surfaces (command
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
  /** Open view tabs per cluster in strip order; read through `openTabs`. */
  tabs: Record<ClusterId, ViewKey[]>;
  activeKind: Record<ClusterId, ViewKey>;
  /** Selected object per cluster and view tab (the tab's details panel). */
  selection: Record<ClusterId, Record<ViewKey, ObjectSelection>>;
  /**
   * Bumped on every programmatic navigation so views can scroll the target
   * into view. Keyed by `${clusterId}|${kindKey}`.
   */
  navRevision: Record<string, number>;
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
  sort: Record<string, SortPref>;
  detailsWidth: number;

  setNamespaces: (clusterId: ClusterId, namespaces: string[]) => void;
  /** Focus a view's tab, opening it next to the active tab when needed. */
  setActiveKind: (clusterId: ClusterId, key: ViewKey) => void;
  closeTab: (clusterId: ClusterId, key: ViewKey) => void;
  closeOtherTabs: (clusterId: ClusterId, key: ViewKey) => void;
  closeTabsToRight: (clusterId: ClusterId, key: ViewKey) => void;
  closeAllTabs: (clusterId: ClusterId) => void;
  moveTab: (clusterId: ClusterId, key: ViewKey, overKey: ViewKey) => void;
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
  setSort: (kind: string, column: string) => void;
  setDetailsWidth: (width: number) => void;
  /** Forget session state of a disconnected cluster. */
  forgetCluster: (clusterId: ClusterId) => void;
}

const clamp = (n: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, n)));

type TabState = Pick<WorkbenchState, 'tabs' | 'activeKind'>;

/** Open tabs of a cluster; always non-empty and always contains the active kind. */
export function openTabs(s: TabState, clusterId: ClusterId): ViewKey[] {
  const active = s.activeKind[clusterId] ?? VIEW.clusterOverview;
  const tabs = s.tabs[clusterId] ?? [];
  return tabs.includes(active) ? tabs : [...tabs, active];
}

/** State patch that focuses `key`, inserting its tab right after the active one. */
function focusTab(s: TabState, clusterId: ClusterId, key: ViewKey): TabState {
  const tabs = openTabs(s, clusterId);
  const next = [...tabs];
  if (!next.includes(key)) {
    const active = s.activeKind[clusterId] ?? VIEW.clusterOverview;
    next.splice(next.indexOf(active) + 1, 0, key);
  }
  return {
    tabs: { ...s.tabs, [clusterId]: next },
    activeKind: { ...s.activeKind, [clusterId]: key },
  };
}

/**
 * State patch that closes the tabs `drop` matches. A closed active tab hands
 * focus to its right neighbour (else the left one); closing every tab
 * leaves the cluster overview. Closed tabs forget their selection and filter.
 */
function dropTabs(
  s: WorkbenchState,
  clusterId: ClusterId,
  drop: (key: ViewKey, index: number) => boolean,
): Partial<WorkbenchState> {
  const tabs = openTabs(s, clusterId);
  const closed = tabs.filter(drop);
  if (!closed.length) return {};
  const kept = tabs.filter((k) => !closed.includes(k));
  if (!kept.length) kept.push(VIEW.clusterOverview);
  const active = s.activeKind[clusterId] ?? VIEW.clusterOverview;
  let nextActive = active;
  if (!kept.includes(active)) {
    const at = tabs.indexOf(active);
    nextActive =
      tabs.slice(at + 1).find((k) => kept.includes(k)) ??
      tabs
        .slice(0, at)
        .reverse()
        .find((k) => kept.includes(k)) ??
      kept[0]!;
  }
  const selection = { ...s.selection[clusterId] };
  const filters = { ...s.filters };
  for (const key of closed) {
    if (kept.includes(key)) continue;
    delete selection[key];
    delete filters[`${clusterId}|${key}`];
  }
  return {
    tabs: { ...s.tabs, [clusterId]: kept },
    activeKind: { ...s.activeKind, [clusterId]: nextActive },
    selection: { ...s.selection, [clusterId]: selection },
    filters,
  };
}

export const useWorkbenchStore = create<WorkbenchState>()(
  persist(
    (set, get) => ({
      namespaces: {},
      tabs: {},
      activeKind: {},
      selection: {},
      navRevision: {},
      customKinds: {},
      apiResources: {},
      pendingNav: {},
      filters: {},
      navWidth: NAV_WIDTH.default,
      navCollapsed: false,
      collapsedGroups: {},
      pinnedKinds: [],
      hiddenColumns: {},
      sort: {},
      detailsWidth: DETAILS_WIDTH.default,

      setNamespaces: (clusterId, namespaces) =>
        set((s) => ({
          namespaces: { ...s.namespaces, [clusterId]: [...new Set(namespaces)].sort() },
        })),
      setActiveKind: (clusterId, key) => set((s) => focusTab(s, clusterId, key)),
      closeTab: (clusterId, key) => set((s) => dropTabs(s, clusterId, (k) => k === key)),
      closeOtherTabs: (clusterId, key) => set((s) => dropTabs(s, clusterId, (k) => k !== key)),
      closeTabsToRight: (clusterId, key) =>
        set((s) => {
          const at = openTabs(s, clusterId).indexOf(key);
          return at < 0 ? {} : dropTabs(s, clusterId, (_, i) => i > at);
        }),
      closeAllTabs: (clusterId) => set((s) => dropTabs(s, clusterId, () => true)),
      moveTab: (clusterId, key, overKey) =>
        set((s) => {
          const tabs = [...openTabs(s, clusterId)];
          const from = tabs.indexOf(key);
          const to = tabs.indexOf(overKey);
          if (from < 0 || to < 0 || from === to) return {};
          tabs.splice(to, 0, ...tabs.splice(from, 1));
          return { tabs: { ...s.tabs, [clusterId]: tabs } };
        }),
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
          delete next[kind];
          return { hiddenColumns: next };
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
          delete selection[clusterId];
          delete apiResources[clusterId];
          return { selection, apiResources };
        }),
    }),
    {
      name: 'kubepit.workbench.v1',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        namespaces: s.namespaces,
        tabs: s.tabs,
        activeKind: s.activeKind,
        navWidth: s.navWidth,
        navCollapsed: s.navCollapsed,
        collapsedGroups: s.collapsedGroups,
        pinnedKinds: s.pinnedKinds,
        hiddenColumns: s.hiddenColumns,
        sort: s.sort,
        detailsWidth: s.detailsWidth,
      }),
    },
  ),
);

/** Resolve a kind key for a cluster: built-ins, discovery, then link-registered CRDs. */
export function gvkForCluster(clusterId: ClusterId, key: string): Gvk | null {
  const s = useWorkbenchStore.getState();
  return gvkForKey(key, s.apiResources[clusterId]) ?? s.customKinds[clusterId]?.[key] ?? null;
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
  // Without a name the tab keeps whatever it had selected.
  useWorkbenchStore.setState((s) => ({
    ...focusTab(s, clusterId, key),
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
  }));
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
