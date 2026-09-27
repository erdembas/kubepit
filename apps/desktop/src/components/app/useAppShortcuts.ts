import { useEffect } from 'react';
import { duplicateWindow } from '@/lib/windowing';
import { focusedGroup } from '@/store/splitLayout';
import { DASHBOARD_TAB_KEY, useAppStore } from '@/store/useAppStore';

function isEditable(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/**
 * Global shortcuts (⌘ on macOS, Ctrl elsewhere):
 *   K palette · N add cluster · Shift+N new window · , settings · B toggle sidebar
 *   W close tab · 1–9 switch tab · Shift+[ / Shift+] previous / next tab
 * Tab shortcuts act on the focused pane.
 */
export function useAppShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.altKey) return;
      const store = useAppStore.getState();
      const key = event.key.toLowerCase();

      if (key === 'k') {
        event.preventDefault();
        store.setPaletteOpen(!store.paletteOpen);
        return;
      }
      // Editors (Monaco, xterm, inputs) keep their own chords.
      if (isEditable(event.target) && key !== ',') return;

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
        if (store.activeMainTabKey === DASHBOARD_TAB_KEY) return;
        event.preventDefault();
        // An empty split pane has no tab to close: close the pane itself.
        if (store.activeMainTabKey) store.closeMainTab(store.activeMainTabKey);
        else store.closeMainPane(store.mainLayout.focused);
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
