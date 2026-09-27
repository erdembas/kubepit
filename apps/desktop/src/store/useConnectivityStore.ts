import { create } from 'zustand';
import { mergeKubeconfigChange } from '@/lib/kubeconfigNotice';
import type { KubeconfigChanged, KubeconfigNewContext, SavedPortForward } from '@/types';

/**
 * Connectivity state shared by the shell: saved port forwards
 * (`portforward://saved`), the pending kubeconfig-change notice
 * (`kubeconfig://changed`), the contexts the discover dialog should
 * preselect and the saved forward being edited.
 */
interface ConnectivityState {
  savedForwards: SavedPortForward[];
  setSavedForwards: (saved: SavedPortForward[]) => void;
  /** Accumulated since the notice was last dismissed; null when nothing is pending. */
  kubeconfigNotice: KubeconfigChanged | null;
  addKubeconfigChange: (change: KubeconfigChanged) => void;
  dismissKubeconfigNotice: () => void;
  /** Consumed by the discover dialog when it opens. */
  discoverPreselect: KubeconfigNewContext[] | null;
  setDiscoverPreselect: (contexts: KubeconfigNewContext[] | null) => void;
  editingSaved: SavedPortForward | null;
  editSaved: (saved: SavedPortForward | null) => void;
}

export const useConnectivityStore = create<ConnectivityState>((set) => ({
  savedForwards: [],
  setSavedForwards: (savedForwards) => set({ savedForwards }),
  kubeconfigNotice: null,
  addKubeconfigChange: (change) =>
    set((s) => ({ kubeconfigNotice: mergeKubeconfigChange(s.kubeconfigNotice, change) })),
  dismissKubeconfigNotice: () => set({ kubeconfigNotice: null }),
  discoverPreselect: null,
  setDiscoverPreselect: (discoverPreselect) => set({ discoverPreselect }),
  editingSaved: null,
  editSaved: (editingSaved) => set({ editingSaved }),
}));
