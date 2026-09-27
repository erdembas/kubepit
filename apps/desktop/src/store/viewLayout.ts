import { VIEW_KEYS } from '@/lib/kube/nav';
import { createLayoutOps } from './splitLayout';
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
} from './splitLayout';
export type { LayoutNode, PaneNode, SplitNode, SplitOrientation, SplitSide } from './splitLayout';

export type ViewKey = TabKey;
export type ViewGroup = TabGroup;
export type ViewLayout = SplitLayout;
export type { FlatLayout };

export const {
  singleLayout,
  fromFlatLayout,
  openView,
  moveView,
  splitView,
  closeViews,
  closePane,
} = createLayoutOps({ home: VIEW_KEYS.clusterOverview });
