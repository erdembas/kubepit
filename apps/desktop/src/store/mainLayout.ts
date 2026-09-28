import { createLayoutOps } from './splitLayout';
import {
  ACTIVITY_TAB_KEY,
  DASHBOARD_TAB,
  DASHBOARD_TAB_KEY,
  SEARCH_TAB_KEY,
  type MainTab,
} from './types';

/**
 * The main area's split layout of app tabs (dashboard, clusters, settings,
 * port forwards), keyed by `mainTabKey` (see `splitLayout.ts`). The
 * dashboard is the home base: it never closes and returns to the first pane
 * if its pane goes away. New tabs open at the end of the focused pane.
 */
export const mainLayouts = createLayoutOps({
  home: DASHBOARD_TAB_KEY,
  homeRequired: true,
  insert: 'end',
});

export function tabFromKey(key: string): MainTab | null {
  if (key === DASHBOARD_TAB_KEY) return DASHBOARD_TAB;
  if (key.startsWith('cluster:')) return { kind: 'cluster', refId: key.slice('cluster:'.length) };
  if (key === 'settings:settings') return { kind: 'settings' };
  if (key === 'port-forwards:port-forwards') return { kind: 'port-forwards' };
  if (key === SEARCH_TAB_KEY) return { kind: 'search' };
  if (key === ACTIVITY_TAB_KEY) return { kind: 'activity' };
  return null;
}

/** First index after the dashboard and the pinned tabs of a pane's tab list. */
export function pinBoundary(tabs: readonly string[], pinned: ReadonlySet<string>): number {
  let at = 0;
  while (at < tabs.length && (tabs[at] === DASHBOARD_TAB_KEY || pinned.has(tabs[at]!))) at++;
  return at;
}

/**
 * Clamp where `key` is inserted into `rest` (its pane's tabs without it):
 * nothing goes before the dashboard, and pinned tabs stay ahead of
 * unpinned ones.
 */
export function clampToZone(
  rest: readonly string[],
  key: string,
  index: number,
  pinned: ReadonlySet<string>,
): number {
  const low = rest[0] === DASHBOARD_TAB_KEY ? 1 : 0;
  const boundary = pinBoundary(rest, pinned);
  const [min, max] = pinned.has(key) ? [low, boundary] : [boundary, rest.length];
  return Math.max(min, Math.min(max, index));
}
