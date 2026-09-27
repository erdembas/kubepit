import { create } from 'zustand';
import type { StateCreator } from 'zustand';
import { nextSectionColor } from '@/lib/sectionColors';
import type { ClusterId, Section, SectionId } from '@/types';
import {
  DASHBOARD_TAB,
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
// Tab helpers (ported from RunHQ's mainTab slices)
// ---------------------------------------------------------------------------

function pinBoundaryIndex(tabs: MainTab[], pinned: ReadonlySet<string>) {
  let idx = 0;
  for (let i = 0; i < tabs.length; i++) {
    const key = mainTabKey(tabs[i]!);
    if (key === DASHBOARD_TAB_KEY || pinned.has(key)) idx = i + 1;
    else break;
  }
  return idx;
}

function insertTab(tabs: MainTab[], tab: MainTab) {
  return [...tabs, tab];
}

function selectionFor(tabs: MainTab[], key: string) {
  const tab = tabs.find((t) => mainTabKey(t) === key);
  return tab?.kind === 'cluster' ? tab.refId : null;
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
      const mainTabs = s.mainTabs.filter((t) => t.kind !== 'cluster' || ids.has(t.refId));
      const activeOk = mainTabs.some((t) => mainTabKey(t) === s.activeMainTabKey);
      const activeMainTabKey = activeOk ? s.activeMainTabKey : DASHBOARD_TAB_KEY;
      return {
        clusters,
        mainTabs,
        activeMainTabKey,
        selectedClusterId: selectionFor(mainTabs, activeMainTabKey),
      };
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
  mainTabs: [DASHBOARD_TAB],
  activeMainTabKey: DASHBOARD_TAB_KEY,
  pinnedMainTabKeys: prefs.pinnedMainTabKeys ?? [],
  selectedClusterId: null,
  openCluster: (id) => get().openMainTab({ kind: 'cluster', refId: id }),
  openMainTab: (tab) =>
    set((s) => {
      const key = mainTabKey(tab);
      const exists = s.mainTabs.some((t) => mainTabKey(t) === key);
      const mainTabs = exists ? s.mainTabs : insertTab(s.mainTabs, tab);
      return {
        mainTabs,
        activeMainTabKey: key,
        selectedClusterId: tab.kind === 'cluster' ? tab.refId : null,
      };
    }),
  goHome: () => set({ activeMainTabKey: DASHBOARD_TAB_KEY, selectedClusterId: null }),
  closeMainTab: (key) =>
    set((s) => {
      // The dashboard is the home base and never closes.
      if (key === DASHBOARD_TAB_KEY) return s;
      const idx = s.mainTabs.findIndex((t) => mainTabKey(t) === key);
      if (idx < 0) return s;
      const next = s.mainTabs.filter((_, i) => i !== idx);
      let activeKey = s.activeMainTabKey;
      if (activeKey === key) {
        // Land on the tab that shifted into the closed slot, then the left neighbour.
        const fallback = next[idx] ?? next[idx - 1] ?? null;
        activeKey = fallback ? mainTabKey(fallback) : DASHBOARD_TAB_KEY;
      }
      return {
        mainTabs: next,
        activeMainTabKey: activeKey,
        selectedClusterId: selectionFor(next, activeKey),
      };
    }),
  setActiveMainTab: (key) =>
    set((s) => {
      if (!s.mainTabs.some((t) => mainTabKey(t) === key)) return s;
      return { activeMainTabKey: key, selectedClusterId: selectionFor(s.mainTabs, key) };
    }),
  closeOtherMainTabs: (keepKey) =>
    set((s) => {
      const pinned = new Set(s.pinnedMainTabKeys);
      const next = s.mainTabs.filter((t) => {
        const k = mainTabKey(t);
        return k === keepKey || k === DASHBOARD_TAB_KEY || pinned.has(k);
      });
      if (next.length === s.mainTabs.length) return s;
      const activeKey = next.some((t) => mainTabKey(t) === keepKey) ? keepKey : DASHBOARD_TAB_KEY;
      return {
        mainTabs: next,
        activeMainTabKey: activeKey,
        selectedClusterId: selectionFor(next, activeKey),
      };
    }),
  closeMainTabsToRight: (key) =>
    set((s) => {
      const idx = s.mainTabs.findIndex((t) => mainTabKey(t) === key);
      if (idx < 0 || idx === s.mainTabs.length - 1) return s;
      const pinned = new Set(s.pinnedMainTabKeys);
      const next = [
        ...s.mainTabs.slice(0, idx + 1),
        ...s.mainTabs.slice(idx + 1).filter((t) => pinned.has(mainTabKey(t))),
      ];
      const activeKey = next.some((t) => mainTabKey(t) === s.activeMainTabKey)
        ? s.activeMainTabKey
        : key;
      return {
        mainTabs: next,
        activeMainTabKey: activeKey,
        selectedClusterId: selectionFor(next, activeKey),
      };
    }),
  closeMainTabsToLeft: (key) =>
    set((s) => {
      const idx = s.mainTabs.findIndex((t) => mainTabKey(t) === key);
      if (idx <= 0) return s;
      const pinned = new Set(s.pinnedMainTabKeys);
      const headPinned = s.mainTabs.slice(0, idx).filter((t) => pinned.has(mainTabKey(t)));
      const tail = s.mainTabs.slice(idx);
      const next = [DASHBOARD_TAB, ...headPinned, ...tail.filter((t) => t.kind !== 'dashboard')];
      const activeKey = next.some((t) => mainTabKey(t) === s.activeMainTabKey)
        ? s.activeMainTabKey
        : key;
      return {
        mainTabs: next,
        activeMainTabKey: activeKey,
        selectedClusterId: selectionFor(next, activeKey),
      };
    }),
  closeAllMainTabs: () =>
    set((s) => {
      const pinned = new Set(s.pinnedMainTabKeys);
      const kept = s.mainTabs.filter(
        (t) => mainTabKey(t) === DASHBOARD_TAB_KEY || pinned.has(mainTabKey(t)),
      );
      if (kept.length === s.mainTabs.length) return s;
      const activeKey = kept.some((t) => mainTabKey(t) === s.activeMainTabKey)
        ? s.activeMainTabKey
        : DASHBOARD_TAB_KEY;
      return {
        mainTabs: kept,
        activeMainTabKey: activeKey,
        selectedClusterId: selectionFor(kept, activeKey),
      };
    }),
  toggleMainTabPin: (key) =>
    set((s) => {
      if (key === DASHBOARD_TAB_KEY) return s;
      const idx = s.mainTabs.findIndex((t) => mainTabKey(t) === key);
      const tab = s.mainTabs[idx];
      if (idx < 0 || !tab) return s;
      const isPinned = s.pinnedMainTabKeys.includes(key);
      const withoutTab = [...s.mainTabs.slice(0, idx), ...s.mainTabs.slice(idx + 1)];
      const nextPinned = isPinned
        ? s.pinnedMainTabKeys.filter((k) => k !== key)
        : [...s.pinnedMainTabKeys, key];
      // Newest pin lands at the right edge of the pinned zone (Chrome parity).
      const insertAt = pinBoundaryIndex(withoutTab, new Set(nextPinned));
      savePrefs({ pinnedMainTabKeys: nextPinned });
      return {
        mainTabs: [...withoutTab.slice(0, insertAt), tab, ...withoutTab.slice(insertAt)],
        pinnedMainTabKeys: nextPinned,
      };
    }),
  reorderMainTabs: (activeKey, overKey) =>
    set((s) => {
      if (activeKey === DASHBOARD_TAB_KEY || activeKey === overKey) return s;
      const fromIdx = s.mainTabs.findIndex((t) => mainTabKey(t) === activeKey);
      const tab = s.mainTabs[fromIdx];
      if (fromIdx < 0 || !tab) return s;
      const pinned = new Set(s.pinnedMainTabKeys);
      const activePinned = pinned.has(activeKey);
      // Dragging never flips pin state; cross-zone drops are refused.
      if (
        overKey != null &&
        (overKey === DASHBOARD_TAB_KEY || pinned.has(overKey) !== activePinned)
      )
        return s;
      const withoutTab = [...s.mainTabs.slice(0, fromIdx), ...s.mainTabs.slice(fromIdx + 1)];
      let insertAt: number;
      if (overKey == null) {
        insertAt = activePinned ? pinBoundaryIndex(withoutTab, pinned) : withoutTab.length;
      } else {
        insertAt = withoutTab.findIndex((t) => mainTabKey(t) === overKey);
        if (insertAt < 0) return s;
        if (insertAt >= fromIdx) insertAt += 1;
      }
      return {
        mainTabs: [...withoutTab.slice(0, insertAt), tab, ...withoutTab.slice(insertAt)],
      };
    }),
  moveMainTabLeft: (key) =>
    set((s) => {
      const idx = s.mainTabs.findIndex((t) => mainTabKey(t) === key);
      const prev = s.mainTabs[idx - 1];
      if (key === DASHBOARD_TAB_KEY || idx <= 0 || !prev) return s;
      const pinned = new Set(s.pinnedMainTabKeys);
      const prevKey = mainTabKey(prev);
      if (prevKey === DASHBOARD_TAB_KEY || pinned.has(prevKey) !== pinned.has(key)) return s;
      const next = [...s.mainTabs];
      next[idx - 1] = next[idx]!;
      next[idx] = prev;
      return { mainTabs: next };
    }),
  moveMainTabRight: (key) =>
    set((s) => {
      const idx = s.mainTabs.findIndex((t) => mainTabKey(t) === key);
      const nextTab = s.mainTabs[idx + 1];
      if (key === DASHBOARD_TAB_KEY || idx < 0 || !nextTab) return s;
      const pinned = new Set(s.pinnedMainTabKeys);
      if (pinned.has(mainTabKey(nextTab)) !== pinned.has(key)) return s;
      const next = [...s.mainTabs];
      next[idx + 1] = next[idx]!;
      next[idx] = nextTab;
      return { mainTabs: next };
    }),
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
