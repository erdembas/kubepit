import { useEffect } from 'react';
import { DASHBOARD_TAB_KEY, mainTabKey, useAppStore } from '@/store/useAppStore';

function isEditable(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/**
 * Global shortcuts (⌘ on macOS, Ctrl elsewhere):
 *   K palette · N add cluster · , settings · B toggle sidebar
 *   W close tab · 1–9 switch tab · Shift+[ / Shift+] previous / next tab
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
      } else if (key === ',') {
        event.preventDefault();
        store.openSettings();
      } else if (key === 'b') {
        event.preventDefault();
        store.setSidebarPinned(!store.sidebarPinned);
      } else if (key === 'w') {
        if (store.activeMainTabKey === DASHBOARD_TAB_KEY) return;
        event.preventDefault();
        store.closeMainTab(store.activeMainTabKey);
      } else if (/^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1;
        const tab = event.key === '9' ? store.mainTabs.at(-1) : store.mainTabs[index];
        if (!tab) return;
        event.preventDefault();
        store.setActiveMainTab(mainTabKey(tab));
      } else if (
        event.shiftKey &&
        (event.key === '[' || event.key === ']' || event.key === '{' || event.key === '}')
      ) {
        const keys = store.mainTabs.map(mainTabKey);
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
