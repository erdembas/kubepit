import { VIEW_KEYS } from '@/lib/kube/nav';
import { tabFromKey } from '@/store/mainLayout';
import { DASHBOARD_TAB_KEY } from '@/store/types';
import { focusedGroup, type ViewLayout } from '@/store/viewLayout';

export type CloseTarget =
  | { kind: 'dock-tab'; clusterId: string; tabId: string }
  | { kind: 'view-tab'; clusterId: string; key: string }
  | { kind: 'view-pane'; clusterId: string; paneId: string }
  | { kind: 'main-tab'; key: string }
  | { kind: 'main-pane'; paneId: string };

export interface CloseContext {
  /** The focused main pane's active tab ('' while that pane is empty). */
  mainTab: string;
  mainPane: string;
  /** ⌘⇧W: close the main tab itself, skipping what is open inside it. */
  whole: boolean;
  /** The cluster's dock, when keyboard focus is inside it. */
  dock: { tabs: ReadonlyArray<{ id: string }>; activeId: string | null; open: boolean } | null;
  /** The cluster's view tabs, while its workbench shows them (connected). */
  views: ViewLayout | null;
}

/** The lone overview of an unsplit workbench cannot close (see `ViewTabStrip`). */
function hasClosableView(views: ViewLayout): boolean {
  const [only, ...rest] = views.groups;
  return rest.length > 0 || !!only?.tabs.some((k) => k !== VIEW_KEYS.clusterOverview);
}

/**
 * What ⌘W closes: the innermost open tab first. Inside a cluster that is
 * the focused dock tab, else the active view tab of the focused pane (an
 * empty split pane closes itself); once only the overview is left, the
 * cluster tab. Null on the dashboard, so the native "Close Window" runs.
 */
export function closeTarget(ctx: CloseContext): CloseTarget | null {
  const { mainTab, mainPane, whole, dock, views } = ctx;
  if (mainTab === DASHBOARD_TAB_KEY) return null;
  if (!mainTab) return { kind: 'main-pane', paneId: mainPane };
  const tab = tabFromKey(mainTab);
  if (!whole && tab?.kind === 'cluster') {
    const clusterId = tab.refId;
    const activeId = dock?.activeId;
    if (dock?.open && activeId && dock.tabs.some((t) => t.id === activeId))
      return { kind: 'dock-tab', clusterId, tabId: activeId };
    if (views && hasClosableView(views)) {
      const pane = focusedGroup(views);
      return pane.active
        ? { kind: 'view-tab', clusterId, key: pane.active }
        : { kind: 'view-pane', clusterId, paneId: pane.id };
    }
  }
  return { kind: 'main-tab', key: mainTab };
}
