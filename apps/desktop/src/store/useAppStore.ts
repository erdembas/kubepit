import { create } from 'zustand';
import type { StateCreator } from 'zustand';
import { nextSectionColor } from '@/lib/sectionColors';
import type { ClusterId, Section, SectionId } from '@/types';
import { clampToZone, mainLayouts, pinBoundary, tabFromKey } from './mainLayout';
import {
  focusPane,
  focusedGroup,
  groupOf,
  resizePanes,
  withPaneTabs,
  type SplitLayout,
} from './splitLayout';
import {
  DASHBOARD_TAB_KEY,
  SETTINGS_TAB_KEY,
  mainTabKey,
  type AppState,
  type DataSlice,
  type MainTab,
  type SectionsSlice,
  type TabsSlice,
  type UiSlice,
} from './types';

export * from './types';

type Slice<T> = StateCreator<AppState, [], [], T>;

// ---------------------------------------------------------------------------
// Local UI preferences (per machine, not part of the workspace file)
// ---------------------------------------------------------------------------

const PREFS_KEY = 'kubepit.ui.v1';

interface UiPrefs {
  sidebarPinned: boolean;
  rightPanelWidth: number;
  pinnedMainTabKeys: string[];
  sidebarGroupBy: AppState['sidebarGroupBy'];
}

function loadPrefs(): Partial<UiPrefs> {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as Partial<UiPrefs>) : {};
  } catch {
    return {};
  }
}

function savePrefs(patch: Partial<UiPrefs>) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
  } catch {
    /* Storage can be blocked; preferences are a convenience. */
  }
}

const prefs = loadPrefs();

// ---------------------------------------------------------------------------
// Section helpers (ported from RunHQ's appStoreSections)
// ---------------------------------------------------------------------------

/** Bucket key for the "Unassigned" pseudo-section. Mirrors `components/sidebar/dnd.ts`. */
export const UNASSIGNED_BUCKET: SectionId = '__unassigned__';

export function itemOrderKey(id: ClusterId): string {
  return `cluster:${id}`;
}

function genId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function dropItemKey(order: Record<SectionId, string[]>, key: string) {
  let changed = false;
  const next: Record<SectionId, string[]> = {};
  for (const [bucket, list] of Object.entries(order)) {
    const filtered = list.filter((k) => k !== key);
    if (filtered.length !== list.length) changed = true;
    next[bucket] = filtered;
  }
  return changed ? next : order;
}

/** Strip `key` everywhere, then insert it into `bucket` before `beforeKey` (or at the end). */
function placeItemKey(
  order: Record<SectionId, string[]>,
  bucket: SectionId,
  key: string,
  beforeKey: string | null,
) {
  const cleaned = dropItemKey(order, key);
  const list = cleaned[bucket] ? [...cleaned[bucket]] : [];
  const idx = beforeKey == null ? -1 : list.indexOf(beforeKey);
  if (idx < 0) list.push(key);
  else list.splice(idx, 0, key);
  return { ...cleaned, [bucket]: list };
}

// ---------------------------------------------------------------------------
// Tab helpers (RunHQ's mainTab slices, per split pane)
// ---------------------------------------------------------------------------

type TabsState = Pick<
  AppState,
  'mainLayout' | 'mainTabs' | 'activeMainTabKey' | 'selectedClusterId' | 'pinnedMainTabKeys'
>;

/**
 * State patch storing the main layout and its mirrors: `mainTabs` lists
 * every open tab in reading order (same array while the set and order hold)
 * and `activeMainTabKey` is the focused pane's active tab.
 */
function commitTabs(s: TabsState, layout: SplitLayout): Partial<AppState> {
  const keys = layout.groups.flatMap((g) => g.tabs);
  const same =
    keys.length === s.mainTabs.length && keys.every((k, i) => k === mainTabKey(s.mainTabs[i]!));
  const mainTabs = same ? s.mainTabs : keys.map(tabFromKey).filter((t): t is MainTab => !!t);
  const activeMainTabKey = focusedGroup(layout).active ?? '';
  const active = tabFromKey(activeMainTabKey);
  return {
    mainLayout: layout,
    mainTabs,
    activeMainTabKey,
    selectedClusterId: active?.kind === 'cluster' ? active.refId : null,
  };
}

/**
 * Close the tabs `pick` matches in the pane holding `key`; when the pane's
 * active tab was among them, `key` takes over (RunHQ parity).
 */
function closeAround(
  s: TabsState,
  key: string,
  pick: (k: string, index: number, at: number, pinned: ReadonlySet<string>) => boolean,
): Partial<AppState> {
  const pane = groupOf(s.mainLayout, key);
  if (!pane) return {};
  const at = pane.tabs.indexOf(key);
  const pinned = new Set(s.pinnedMainTabKeys);
  const result = mainLayouts.closeViews(s.mainLayout, pane.id, (k, i) => pick(k, i, at, pinned));
  if (!result.closed.length) return {};
  const layout =
    pane.active && result.closed.includes(pane.active) && !result.closed.includes(key)
      ? mainLayouts.openView(result.layout, key)
      : result.layout;
  return commitTabs(s, layout);
}

/** Swap `key` with its neighbour in its pane when both share a pin zone. */
function swapInPane(s: TabsState, key: string, step: -1 | 1): Partial<AppState> {
  const pane = groupOf(s.mainLayout, key);
  if (!pane || key === DASHBOARD_TAB_KEY) return {};
  const at = pane.tabs.indexOf(key);
  const other = pane.tabs[at + step];
  const pinned = new Set(s.pinnedMainTabKeys);
  if (!other || other === DASHBOARD_TAB_KEY || pinned.has(other) !== pinned.has(key)) return {};
  const tabs = [...pane.tabs];
  tabs[at] = other;
  tabs[at + step] = key;
  return commitTabs(s, withPaneTabs(s.mainLayout, pane.id, tabs));
}

// ---------------------------------------------------------------------------
// Slices
// ---------------------------------------------------------------------------

const createDataSlice: Slice<DataSlice> = (set) => ({
  bootstrapped: false,
  appInfo: null,
  settings: null,
  clusters: [],
  statuses: {},
  overviews: {},
  overviewErrors: {},
  portForwards: [],
  setClusters: (clusters) =>
    set((s) => {
      // Tabs for clusters that no longer exist must not linger.
      const ids = new Set(clusters.map((c) => c.id));
      const gone = (key: string) => {
        const tab = tabFromKey(key);
        return tab?.kind === 'cluster' && !ids.has(tab.refId);
      };
      let layout = s.mainLayout;
      for (const pane of s.mainLayout.groups)
        layout = mainLayouts.closeViews(layout, pane.id, gone).layout;
      return { clusters, ...(layout === s.mainLayout ? {} : commitTabs(s, layout)) };
    }),
  setStatus: (status) => set((s) => ({ statuses: { ...s.statuses, [status.id]: status } })),
  setOverview: (id, overview, error) =>
    set((s) => {
      const overviews = { ...s.overviews };
      const overviewErrors = { ...s.overviewErrors };
      if (overview) overviews[id] = overview;
      else delete overviews[id];
      if (error) overviewErrors[id] = error;
      else delete overviewErrors[id];
      return { overviews, overviewErrors };
    }),
  setPortForwards: (portForwards) => set({ portForwards }),
  setSettings: (settings) => set({ settings }),
});

const createSectionsSlice: Slice<SectionsSlice> = (set, get) => ({
  sections: [],
  clusterSection: {},
  collapsedSections: {},
  sectionItemOrder: {},
  hydrateWorkspace: (snapshot) => set(snapshot),
  addSection: (name, color) => {
    const id = genId('sec');
    const s = get();
    const section: Section = {
      id,
      name: name.trim() || 'New section',
      color: color ?? nextSectionColor(s.sections.map((x) => x.color)),
    };
    set({ sections: [...s.sections, section] });
    return id;
  },
  renameSection: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    set((s) => ({ sections: s.sections.map((x) => (x.id === id ? { ...x, name: trimmed } : x)) }));
  },
  recolorSection: (id, color) =>
    set((s) => ({ sections: s.sections.map((x) => (x.id === id ? { ...x, color } : x)) })),
  deleteSection: (id) =>
    set((s) => {
      const clusterSection = { ...s.clusterSection };
      for (const [cid, sid] of Object.entries(clusterSection)) {
        if (sid === id) delete clusterSection[cid];
      }
      const sectionItemOrder = { ...s.sectionItemOrder };
      const moved = sectionItemOrder[id] ?? [];
      delete sectionItemOrder[id];
      if (moved.length) {
        sectionItemOrder[UNASSIGNED_BUCKET] = [
          ...(sectionItemOrder[UNASSIGNED_BUCKET] ?? []),
          ...moved,
        ];
      }
      const collapsedSections = { ...s.collapsedSections };
      delete collapsedSections[id];
      return {
        sections: s.sections.filter((x) => x.id !== id),
        clusterSection,
        sectionItemOrder,
        collapsedSections,
      };
    }),
  reorderSections: (ids) =>
    set((s) => {
      const byId = new Map(s.sections.map((x) => [x.id, x]));
      const ordered = ids.map((id) => byId.get(id)).filter((x): x is Section => !!x);
      const rest = s.sections.filter((x) => !ids.includes(x.id));
      return { sections: [...ordered, ...rest] };
    }),
  toggleSectionCollapsed: (id) =>
    set((s) => ({
      collapsedSections: { ...s.collapsedSections, [id]: !s.collapsedSections[id] },
    })),
  assignClusterToSection: (clusterId, sectionId) =>
    get().moveSidebarItem(clusterId, sectionId, null),
  moveSidebarItem: (id, targetSectionId, beforeKey) =>
    set((s) => {
      const clusterSection = { ...s.clusterSection };
      if (targetSectionId) clusterSection[id] = targetSectionId;
      else delete clusterSection[id];
      return {
        clusterSection,
        sectionItemOrder: placeItemKey(
          s.sectionItemOrder,
          targetSectionId ?? UNASSIGNED_BUCKET,
          itemOrderKey(id),
          beforeKey,
        ),
      };
    }),
});

const createTabsSlice: Slice<TabsSlice> = (set, get) => ({
  mainLayout: mainLayouts.singleLayout(),
  mainTabs: [{ kind: 'dashboard' }],
  activeMainTabKey: DASHBOARD_TAB_KEY,
  pinnedMainTabKeys: prefs.pinnedMainTabKeys ?? [],
  selectedClusterId: null,
  openCluster: (id) => get().openMainTab({ kind: 'cluster', refId: id }),
  openMainTab: (tab) =>
    set((s) => commitTabs(s, mainLayouts.openView(s.mainLayout, mainTabKey(tab)))),
  goHome: () => set((s) => commitTabs(s, mainLayouts.openView(s.mainLayout, DASHBOARD_TAB_KEY))),
  closeMainTab: (key) =>
    // The dashboard is the home base and never closes.
    set((s) => (key === DASHBOARD_TAB_KEY ? {} : closeAround(s, key, (k) => k === key))),
  setActiveMainTab: (key) =>
    set((s) =>
      groupOf(s.mainLayout, key) ? commitTabs(s, mainLayouts.openView(s.mainLayout, key)) : {},
    ),
  closeOtherMainTabs: (keepKey) =>
    set((s) =>
      closeAround(
        s,
        keepKey,
        (k, _i, _at, pinned) => k !== keepKey && k !== DASHBOARD_TAB_KEY && !pinned.has(k),
      ),
    ),
  closeMainTabsToRight: (key) =>
    set((s) => closeAround(s, key, (k, i, at, pinned) => i > at && !pinned.has(k))),
  closeMainTabsToLeft: (key) =>
    set((s) =>
      closeAround(
        s,
        key,
        (k, i, at, pinned) => i < at && k !== DASHBOARD_TAB_KEY && !pinned.has(k),
      ),
    ),
  closeAllMainTabs: (key) =>
    set((s) => {
      const pane = key ? groupOf(s.mainLayout, key) : focusedGroup(s.mainLayout);
      if (!pane) return {};
      const pinned = new Set(s.pinnedMainTabKeys);
      const result = mainLayouts.closeViews(
        s.mainLayout,
        pane.id,
        (k) => k !== DASHBOARD_TAB_KEY && !pinned.has(k),
      );
      return result.closed.length ? commitTabs(s, result.layout) : {};
    }),
  toggleMainTabPin: (key) =>
    set((s) => {
      const pane = groupOf(s.mainLayout, key);
      if (key === DASHBOARD_TAB_KEY || !pane) return {};
      const nextPinned = s.pinnedMainTabKeys.includes(key)
        ? s.pinnedMainTabKeys.filter((k) => k !== key)
        : [...s.pinnedMainTabKeys, key];
      // Newest pin lands at the right edge of the pinned zone (Chrome parity).
      const rest = pane.tabs.filter((k) => k !== key);
      const at = pinBoundary(rest, new Set(nextPinned));
      savePrefs({ pinnedMainTabKeys: nextPinned });
      return {
        ...commitTabs(
          s,
          withPaneTabs(s.mainLayout, pane.id, [...rest.slice(0, at), key, ...rest.slice(at)]),
        ),
        pinnedMainTabKeys: nextPinned,
      };
    }),
  moveMainTab: (key, paneId, index) =>
    set((s) => {
      const dst = s.mainLayout.groups.find((g) => g.id === paneId);
      if (key === DASHBOARD_TAB_KEY || !dst || !groupOf(s.mainLayout, key)) return {};
      const rest = dst.tabs.filter((k) => k !== key);
      const at = clampToZone(rest, key, index ?? rest.length, new Set(s.pinnedMainTabKeys));
      return commitTabs(s, mainLayouts.moveView(s.mainLayout, key, paneId, at));
    }),
  moveMainTabLeft: (key) => set((s) => swapInPane(s, key, -1)),
  moveMainTabRight: (key) => set((s) => swapInPane(s, key, 1)),
  splitMainPane: (paneId, side, key = null) =>
    set((s) =>
      key === DASHBOARD_TAB_KEY
        ? {}
        : commitTabs(s, mainLayouts.splitView(s.mainLayout, paneId, side, key)),
    ),
  closeMainPane: (paneId) =>
    set((s) => {
      const panes = s.mainLayout.groups;
      const at = panes.findIndex((g) => g.id === paneId);
      const pane = panes[at];
      const heir = panes[at - 1] ?? panes[at + 1];
      if (!pane || !heir) return {};
      // The dashboard and pinned tabs survive: they move to the neighbouring pane.
      const pinned = new Set(s.pinnedMainTabKeys);
      let layout = s.mainLayout;
      for (const key of pane.tabs.filter((k) => k === DASHBOARD_TAB_KEY || pinned.has(k))) {
        const rest = layout.groups.find((g) => g.id === heir.id)!.tabs;
        const index = key === DASHBOARD_TAB_KEY ? 0 : pinBoundary(rest, pinned);
        layout = mainLayouts.moveView(layout, key, heir.id, index);
      }
      return commitTabs(s, mainLayouts.closePane(layout, paneId).layout);
    }),
  focusMainPane: (paneId) =>
    set((s) => {
      const layout = focusPane(s.mainLayout, paneId);
      return layout === s.mainLayout ? {} : commitTabs(s, layout);
    }),
  focusMainTabPane: (key) =>
    set((s) => {
      const pane = groupOf(s.mainLayout, key);
      const layout = pane ? focusPane(s.mainLayout, pane.id) : s.mainLayout;
      return layout === s.mainLayout ? {} : commitTabs(s, layout);
    }),
  resizeMainPanes: (sizes) => set((s) => commitTabs(s, resizePanes(s.mainLayout, sizes))),
  hydrateMainLayout: (layout) => set((s) => commitTabs(s, layout)),
});

const createUiSlice: Slice<UiSlice> = (set, get) => ({
  search: '',
  setSearch: (search) => set({ search }),
  environmentFilter: [],
  tagFilter: [],
  sidebarStatusFilter: 'all',
  sidebarGroupBy: prefs.sidebarGroupBy ?? 'none',
  toggleEnvironmentFilter: (env) =>
    set((s) => ({
      environmentFilter: s.environmentFilter.includes(env)
        ? s.environmentFilter.filter((x) => x !== env)
        : [...s.environmentFilter, env],
    })),
  toggleTagFilter: (tag) =>
    set((s) => ({
      tagFilter: s.tagFilter.includes(tag)
        ? s.tagFilter.filter((x) => x !== tag)
        : [...s.tagFilter, tag],
    })),
  setSidebarStatusFilter: (sidebarStatusFilter) => set({ sidebarStatusFilter }),
  setSidebarGroupBy: (sidebarGroupBy) => {
    savePrefs({ sidebarGroupBy });
    set({ sidebarGroupBy });
  },
  clearFilters: () => set({ environmentFilter: [], tagFilter: [], sidebarStatusFilter: 'all' }),
  sidebarPinned: prefs.sidebarPinned ?? true,
  setSidebarPinned: (sidebarPinned) => {
    savePrefs({ sidebarPinned });
    set({ sidebarPinned });
  },
  rightPanel: null,
  rightPanelWidth: prefs.rightPanelWidth ?? 360,
  toggleRightPanel: (panel) => set((s) => ({ rightPanel: s.rightPanel === panel ? null : panel })),
  setRightPanelWidth: (width) => {
    const clamped = Math.round(Math.min(720, Math.max(280, width)));
    savePrefs({ rightPanelWidth: clamped });
    set({ rightPanelWidth: clamped });
  },
  settingsCategory: 'general',
  openSettings: (category) => {
    if (category) set({ settingsCategory: category });
    get().openMainTab({ kind: 'settings' });
  },
  clusterEditor: null,
  openClusterEditor: (clusterEditor) => set({ clusterEditor }),
  importDialogOpen: false,
  setImportDialogOpen: (importDialogOpen) => set({ importDialogOpen }),
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  confirm: null,
  requestConfirm: (confirm) => set({ confirm }),
  closeConfirm: () => set({ confirm: null }),
  toasts: [],
  pushToast: (tone, message) => {
    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, tone, message }] }));
    window.setTimeout(() => get().dismissToast(id), tone === 'error' ? 8000 : 4000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
});

export const useAppStore = create<AppState>()((...a) => ({
  ...createDataSlice(...a),
  ...createSectionsSlice(...a),
  ...createTabsSlice(...a),
  ...createUiSlice(...a),
}));

export { SETTINGS_TAB_KEY };
