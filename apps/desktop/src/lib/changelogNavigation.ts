import { create } from 'zustand';
import { useAppStore } from '@/store/useAppStore';
import { openFleetSearch } from '@/store/useFleetSearchStore';
import { isChangelogAction, type ChangelogAction } from './changelogActions';

interface ChangelogNavigation {
  entryId: string | null;
  revision: number;
  action: ChangelogAction | null;
  closeAction: () => void;
}

export const useChangelogNavigation = create<ChangelogNavigation>((set) => ({
  entryId: null,
  revision: 0,
  action: null,
  closeAction: () => set({ action: null }),
}));

export function openChangelog(entryId?: string) {
  useChangelogNavigation.setState((state) => ({
    entryId: entryId ?? null,
    revision: state.revision + 1,
    action: null,
  }));
  useAppStore.getState().openSettings('about');
}

export function openChangelogAction(action: unknown): boolean {
  if (!isChangelogAction(action)) return false;
  if (action === 'fleet-search') {
    useChangelogNavigation.setState({ action: null });
    openFleetSearch();
  } else if (action === 'image-matrix') {
    useChangelogNavigation.setState({ action: null });
    useAppStore.getState().openMainTab({ kind: 'image-matrix' });
  } else useChangelogNavigation.setState({ action });
  return true;
}
