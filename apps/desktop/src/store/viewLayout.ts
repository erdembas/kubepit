import { VIEW_KEYS } from '@/lib/kube/nav';
import { createLayoutOps } from './splitLayout';
import { focusPane as focusLayoutPane, openKeys } from './splitLayout';
import type { FlatLayout, SplitLayout, TabGroup, TabKey } from './splitLayout';

/**
 * A cluster workbench's split layout of view tabs (see `splitLayout.ts`).
 * A lone empty pane shows the cluster overview, which may close once
 * something else is open. Pure helpers applied by the workbench store.
 */

export {
  MAX_PANES,
  focusPane,
  focusedGroup,
  groupOf,
  openKeys,
  paneAxis,
  paneIds,
  resizePanes,
  splitSides,
  withPaneTabs,
} from './splitLayout';
export type { LayoutNode, PaneNode, SplitNode, SplitOrientation, SplitSide } from './splitLayout';

export type ViewKey = TabKey;
export type ViewGroup = TabGroup;
export type ViewLayout = SplitLayout;
export type { FlatLayout };

/** Maximum pinned view tabs per cluster, shared by all of its split panes. */
export const MAX_PINNED_VIEW_TABS = 3;

export const {
  singleLayout,
  fromFlatLayout,
  openView,
  moveView,
  splitView,
  closeViews,
  closePane,
} = createLayoutOps({ home: VIEW_KEYS.clusterOverview });

/**
 * Swap the ephemeral tab `from` for `to` in its own pane, keeping the tab's
 * position, the pane's active tab and focus (VS Code's preview tab). `to`
 * must not be open anywhere; a missing `from` falls back to a plain open.
 */
export function replaceView(layout: ViewLayout, from: ViewKey, to: ViewKey): ViewLayout {
  const owner = layout.groups.find((g) => g.tabs.includes(from));
  if (!owner || openKeys(layout).has(to)) return openView(layout, to);
  const groups = layout.groups.map((g) =>
    g.id === owner.id
      ? {
          ...g,
          tabs: g.tabs.map((key) => (key === from ? to : key)),
          active: g.active === from ? to : g.active,
        }
      : g,
  );
  return focusLayoutPane({ ...layout, groups }, owner.id);
}

/** First index after the pinned tabs in one pane. */
export function pinBoundary(tabs: readonly ViewKey[], pinned: ReadonlySet<ViewKey>): number {
  let at = 0;
  while (at < tabs.length && pinned.has(tabs[at]!)) at++;
  return at;
}

/** Keep each pane's pinned tabs first, preserving order within both groups. */
export function withPinnedTabs(layout: ViewLayout, pinned: ReadonlySet<ViewKey>): ViewLayout {
  if (!pinned.size) return layout;
  let changed = false;
  const groups = layout.groups.map((group) => {
    const tabs = [
      ...group.tabs.filter((key) => pinned.has(key)),
      ...group.tabs.filter((key) => !pinned.has(key)),
    ];
    if (tabs.every((key, index) => key === group.tabs[index])) return group;
    changed = true;
    return { ...group, tabs };
  });
  return changed ? { ...layout, groups } : layout;
}
