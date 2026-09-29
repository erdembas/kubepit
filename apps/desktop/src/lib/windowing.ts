import * as i18n from '@/i18n/core';
import { ipc } from '@/lib/ipc';
import { dropWindowSeed, stashWindowSeed, type WindowSeed } from '@/lib/windowSeed';
import { mainLayouts } from '@/store/mainLayout';
import type { SplitLayout } from '@/store/splitLayout';
import { DASHBOARD_TAB_KEY, useAppStore } from '@/store/useAppStore';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';

/** This window's session with `mainLayout` as the new window's tabs. */
function seedFrom(mainLayout: SplitLayout): WindowSeed {
  const { layouts, activeKind, namespaces, pinnedTabKeys } = useWorkbenchStore.getState();
  return { mainLayout, workbench: { layouts, activeKind, namespaces, pinnedTabKeys } };
}

async function openWindow(seed: WindowSeed): Promise<boolean> {
  const label = `win-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  stashWindowSeed(label, seed);
  try {
    await ipc.windowOpen(label);
    return true;
  } catch (error) {
    dropWindowSeed(label);
    useAppStore
      .getState()
      .pushToast('error', i18n.t('Could not open a new window: {error}', { error: String(error) }));
    return false;
  }
}

/**
 * Open a copy of this window: same tabs and split panes, same cluster
 * views and namespaces. Terminals and log streams stay here; the backend
 * (connections, port forwards) is shared.
 */
export function duplicateWindow(): Promise<boolean> {
  return openWindow(seedFrom(useAppStore.getState().mainLayout));
}

/** Open `key` in a new window (beside its dashboard) and close it here. */
export async function moveTabToNewWindow(key: string): Promise<void> {
  if (key === DASHBOARD_TAB_KEY) return;
  const layout = mainLayouts.singleLayout(key, [DASHBOARD_TAB_KEY, key]);
  if (await openWindow(seedFrom(layout))) useAppStore.getState().closeMainTab(key);
}
