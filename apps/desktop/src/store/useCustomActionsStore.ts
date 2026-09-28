import { create } from 'zustand';
import { builtinExamples } from '@/lib/customActionExamples';
import { ipc } from '@/lib/ipc';
import type { CustomAction } from '@/types';

/**
 * Custom actions (`~/.kubepit/actions.json`, backend-owned) mirrored for
 * the UI. Loaded once by `CustomActionHost`, kept in sync across windows
 * through `customactions://changed`. The first load of a fresh data folder
 * seeds the built-in examples (disabled) in the current language.
 */
interface CustomActionsState {
  actions: CustomAction[];
  loaded: boolean;
  setActions: (actions: CustomAction[]) => void;
  load: () => Promise<void>;
  /** Persists the whole list (order included); resolves to what the backend saved. */
  save: (actions: CustomAction[]) => Promise<CustomAction[]>;
}

export const useCustomActionsStore = create<CustomActionsState>((set) => ({
  actions: [],
  loaded: false,
  setActions: (actions) => set({ actions, loaded: true }),
  load: async () => {
    const state = await ipc.customActionsList();
    if (state.initialized) {
      set({ actions: state.actions, loaded: true });
      return;
    }
    try {
      const saved = await ipc.customActionsSave([...state.actions, ...builtinExamples()]);
      set({ actions: saved, loaded: true });
    } catch {
      set({ actions: state.actions, loaded: true });
    }
  },
  save: async (actions) => {
    const saved = await ipc.customActionsSave(actions);
    set({ actions: saved, loaded: true });
    return saved;
  },
}));

/** Enabled actions, for surfaces that offer them. */
export function enabledCustomActions(): CustomAction[] {
  return useCustomActionsStore.getState().actions.filter((a) => a.enabled);
}
