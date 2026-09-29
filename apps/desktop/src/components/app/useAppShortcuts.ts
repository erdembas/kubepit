import { useEffect } from 'react';
import { requestCloseTabs } from '@/components/workbench/dock/tabs';
import { IS_MAC } from '@/lib/platform';
import { duplicateWindow } from '@/lib/windowing';
import { tabFromKey } from '@/store/mainLayout';
import { focusedGroup } from '@/store/splitLayout';
import { useAppStore } from '@/store/useAppStore';
import { useDockStore } from '@/store/useDockStore';
import { openFleetSearch } from '@/store/useFleetSearchStore';
import { useWorkbenchStore, viewLayoutOf } from '@/store/useWorkbenchStore';
import { closeTarget } from './closeTarget';

function isEditable(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/** ⌘W closes the innermost tab, ⌘⇧W the main tab (see `closeTarget`). */
function closeFocused(event: KeyboardEvent) {
  const store = useAppStore.getState();
  const tab = tabFromKey(store.activeMainTabKey);
  const clusterId = tab?.kind === 'cluster' ? tab.refId : null;
  const dockEl = (event.target as Element | null)?.closest?.('[data-dock]');
  const target = closeTarget({
    mainTab: store.activeMainTabKey,
    mainPane: store.mainLayout.focused,
    whole: event.shiftKey,
    dock:
      clusterId && dockEl?.getAttribute('data-dock') === clusterId
        ? (useDockStore.getState().docks[clusterId] ?? null)
        : null,
    views:
      clusterId && store.statuses[clusterId]?.state === 'connected'
        ? viewLayoutOf(clusterId)
        : null,
  });
  if (!target) return;
  event.preventDefault();
  if (target.kind === 'dock-tab') requestCloseTabs(target.clusterId, [target.tabId]);
  else if (target.kind === 'view-tab')
    useWorkbenchStore.getState().closeTab(target.clusterId, target.key);
  else if (target.kind === 'view-pane')
    useWorkbenchStore.getState().closePane(target.clusterId, target.paneId);
  else if (target.kind === 'main-tab') store.closeMainTab(target.key);
  else store.closeMainPane(target.paneId);
}

/**
 * Global shortcuts (⌘ on macOS, Ctrl elsewhere):
 *   K palette · N add cluster · Shift+N new window · , settings · B toggle sidebar
 *   W close the innermost tab · Shift+W close the main tab · 1–9 switch tab
 *   Shift+[ / Shift+] previous / next tab · Shift+F fleet search (works from
 *   text fields too; so does ⌘W on macOS, where editors give it no meaning)
 * Tab shortcuts act on the focused pane.
 */
export function useAppShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // ⌘ on macOS only, so ⌃K / ⌃D stay free for terminals and keyboard mode.
      const mod = IS_MAC ? event.metaKey : event.ctrlKey;
      if (!mod || event.altKey) return;
      const store = useAppStore.getState();
      const key = event.key.toLowerCase();

      if (key === 'k') {
        event.preventDefault();
        store.setPaletteOpen(!store.paletteOpen);
        return;
      }
      if (key === 'f' && event.shiftKey) {
        event.preventDefault();
        openFleetSearch();
        return;
      }
      // Editors (Monaco, xterm, inputs) keep their own chords; Ctrl+W deletes a word.
      if (isEditable(event.target) && key !== ',' && !(IS_MAC && key === 'w')) return;

      if (key === 'n' && !event.shiftKey) {
        event.preventDefault();
        store.openClusterEditor({ mode: 'add' });
      } else if (key === 'n' && event.shiftKey) {
        event.preventDefault();
        void duplicateWindow();
      } else if (key === ',') {
        event.preventDefault();
        store.openSettings();
      } else if (key === 'b') {
        event.preventDefault();
        store.setSidebarPinned(!store.sidebarPinned);
      } else if (key === 'w') {
        closeFocused(event);
      } else if (/^[1-9]$/.test(event.key)) {
        const keys = focusedGroup(store.mainLayout).tabs;
        const tab = event.key === '9' ? keys.at(-1) : keys[Number(event.key) - 1];
        if (!tab) return;
        event.preventDefault();
        store.setActiveMainTab(tab);
      } else if (
        event.shiftKey &&
        (event.key === '[' || event.key === ']' || event.key === '{' || event.key === '}')
      ) {
        const keys = focusedGroup(store.mainLayout).tabs;
        const idx = keys.indexOf(store.activeMainTabKey);
        const step = event.key === '[' || event.key === '{' ? -1 : 1;
        const next = keys[(idx + step + keys.length) % keys.length];
        if (!next) return;
        event.preventDefault();
        store.setActiveMainTab(next);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
