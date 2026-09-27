import type {
  AppInfo,
  ClusterDef,
  ClusterId,
  ClusterOverview,
  ClusterStatus,
  PortForward,
  Section,
  SectionColor,
  SectionId,
  Settings,
} from '@/types';

export type MainTab =
  | { kind: 'dashboard' }
  | { kind: 'cluster'; refId: ClusterId }
  | { kind: 'settings' }
  | { kind: 'port-forwards' };

export const DASHBOARD_TAB: MainTab = { kind: 'dashboard' };
export const DASHBOARD_TAB_KEY = 'dashboard:dashboard';
export const SETTINGS_TAB_KEY = 'settings:settings';
export const PORT_FORWARDS_TAB_KEY = 'port-forwards:port-forwards';

export function mainTabKey(tab: MainTab): string {
  return tab.kind === 'cluster' ? `cluster:${tab.refId}` : `${tab.kind}:${tab.kind}`;
}

export type SidebarGroupBy = 'none' | 'environment' | 'status' | 'tag';
export type SidebarStatusFilter = 'all' | 'connected' | 'disconnected';
export type RightPanel = 'events' | 'forwards';
export type SettingsCategory = 'general' | 'kubeconfig' | 'terminal' | 'tools' | 'about';

export type ClusterEditorState = { mode: 'add' } | { mode: 'edit'; cluster: ClusterDef } | null;

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  tone?: 'danger' | 'default';
  /** When set, the user must type this exact text to confirm (production guard). */
  typeToConfirm?: string;
  onConfirm: () => void | Promise<void>;
}

export interface Toast {
  id: string;
  tone: 'success' | 'error' | 'info';
  message: string;
}

export interface DataSlice {
  bootstrapped: boolean;
  appInfo: AppInfo | null;
  settings: Settings | null;
  clusters: ClusterDef[];
  statuses: Record<ClusterId, ClusterStatus>;
  overviews: Record<ClusterId, ClusterOverview>;
  overviewErrors: Record<ClusterId, string>;
  portForwards: PortForward[];
  setClusters: (clusters: ClusterDef[]) => void;
  setStatus: (status: ClusterStatus) => void;
  setOverview: (id: ClusterId, overview: ClusterOverview | null, error?: string) => void;
  setPortForwards: (forwards: PortForward[]) => void;
  setSettings: (settings: Settings) => void;
}

export interface SectionsSlice {
  sections: Section[];
  clusterSection: Record<ClusterId, SectionId>;
  collapsedSections: Record<SectionId, boolean>;
  sectionItemOrder: Record<SectionId, string[]>;
  hydrateWorkspace: (snapshot: {
    sections: Section[];
    clusterSection: Record<ClusterId, SectionId>;
    collapsedSections: Record<SectionId, boolean>;
    sectionItemOrder: Record<SectionId, string[]>;
  }) => void;
  addSection: (name: string, color?: SectionColor) => SectionId;
  renameSection: (id: SectionId, name: string) => void;
  recolorSection: (id: SectionId, color: SectionColor) => void;
  deleteSection: (id: SectionId) => void;
  reorderSections: (ids: SectionId[]) => void;
  toggleSectionCollapsed: (id: SectionId) => void;
  assignClusterToSection: (clusterId: ClusterId, sectionId: SectionId | null) => void;
  moveSidebarItem: (
    id: ClusterId,
    targetSectionId: SectionId | null,
    beforeKey: string | null,
  ) => void;
}

export interface TabsSlice {
  mainTabs: MainTab[];
  activeMainTabKey: string;
  pinnedMainTabKeys: string[];
  selectedClusterId: ClusterId | null;
  openCluster: (id: ClusterId) => void;
  openMainTab: (tab: MainTab) => void;
  goHome: () => void;
  closeMainTab: (key: string) => void;
  setActiveMainTab: (key: string) => void;
  closeOtherMainTabs: (keepKey: string) => void;
  closeMainTabsToRight: (key: string) => void;
  closeMainTabsToLeft: (key: string) => void;
  closeAllMainTabs: () => void;
  toggleMainTabPin: (key: string) => void;
  reorderMainTabs: (activeKey: string, overKey: string | null) => void;
  moveMainTabLeft: (key: string) => void;
  moveMainTabRight: (key: string) => void;
}

export interface UiSlice {
  search: string;
  setSearch: (search: string) => void;
  environmentFilter: string[];
  tagFilter: string[];
  sidebarStatusFilter: SidebarStatusFilter;
  sidebarGroupBy: SidebarGroupBy;
  toggleEnvironmentFilter: (env: string) => void;
  toggleTagFilter: (tag: string) => void;
  setSidebarStatusFilter: (filter: SidebarStatusFilter) => void;
  setSidebarGroupBy: (groupBy: SidebarGroupBy) => void;
  clearFilters: () => void;
  sidebarPinned: boolean;
  setSidebarPinned: (pinned: boolean) => void;
  rightPanel: RightPanel | null;
  rightPanelWidth: number;
  toggleRightPanel: (panel: RightPanel) => void;
  setRightPanelWidth: (width: number) => void;
  settingsCategory: SettingsCategory;
  openSettings: (category?: SettingsCategory) => void;
  clusterEditor: ClusterEditorState;
  openClusterEditor: (state: ClusterEditorState) => void;
  importDialogOpen: boolean;
  setImportDialogOpen: (open: boolean) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  confirm: ConfirmRequest | null;
  requestConfirm: (request: ConfirmRequest) => void;
  closeConfirm: () => void;
  toasts: Toast[];
  pushToast: (tone: Toast['tone'], message: string) => void;
  dismissToast: (id: string) => void;
}

export type AppState = DataSlice & SectionsSlice & TabsSlice & UiSlice;
