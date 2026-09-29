import { useAppStore } from '@/store/useAppStore';

/** How the left explorer behaves: pinned open, a rail that expands on hover, or a rail only. */
export type SidebarMode = 'expanded' | 'hover' | 'compact';

export function sidebarModeOf(pinned: boolean, hoverExpand: boolean): SidebarMode {
  if (pinned) return 'expanded';
  return hoverExpand ? 'hover' : 'compact';
}

export function setSidebarMode(mode: SidebarMode) {
  const store = useAppStore.getState();
  store.setSidebarPinned(mode === 'expanded');
  // Pinning keeps the hover choice for the next time the rail is collapsed.
  if (mode !== 'expanded') store.setSidebarHoverExpand(mode === 'hover');
}
