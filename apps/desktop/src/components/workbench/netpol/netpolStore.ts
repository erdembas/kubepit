import { create } from 'zustand';
import type { NpSelection, Protocol } from '@/lib/kube/netpol';
import { useAppStore } from '@/store/useAppStore';
import { useWorkbenchStore, VIEW } from '@/store/useWorkbenchStore';
import type { ClusterId } from '@/types';

/** Simulator state per cluster (session only), shared with the entry points that prefill it. */

export type NetpolMode = 'simulate' | 'matrix' | 'protection';

export interface NetpolViewState {
  mode: NetpolMode;
  source: NpSelection | null;
  destination: NpSelection | null;
  protocol: Protocol;
  /** Port as typed: a number, a named port or empty (declared ports). */
  port: string;
  matrixNamespace: string | null;
  matrixProtocol: Protocol;
  matrixPort: string;
  /** Resource map: colour nodes by reachability from the selected pod. */
  mapOverlay: boolean;
}

export const DEFAULT_VIEW_STATE: NetpolViewState = {
  mode: 'simulate',
  source: null,
  destination: null,
  protocol: 'TCP',
  port: '',
  matrixNamespace: null,
  matrixProtocol: 'TCP',
  matrixPort: '',
  mapOverlay: false,
};

interface State {
  byCluster: Record<ClusterId, NetpolViewState>;
  patch: (clusterId: ClusterId, patch: Partial<NetpolViewState>) => void;
}

export const useNetpolStore = create<State>((set) => ({
  byCluster: {},
  patch: (clusterId, patch) =>
    set((s) => ({
      byCluster: {
        ...s.byCluster,
        [clusterId]: { ...DEFAULT_VIEW_STATE, ...s.byCluster[clusterId], ...patch },
      },
    })),
}));

export function useNetpolViewState(clusterId: ClusterId): NetpolViewState {
  return useNetpolStore((s) => s.byCluster[clusterId] ?? DEFAULT_VIEW_STATE);
}

/** Open the simulator view of a cluster, optionally prefilled. */
export function openNetpolSimulator(clusterId: ClusterId, patch: Partial<NetpolViewState> = {}) {
  useNetpolStore.getState().patch(clusterId, patch);
  useWorkbenchStore.getState().setActiveKind(clusterId, VIEW.netpolSimulator);
  const app = useAppStore.getState();
  if (app.activeMainTabKey !== `cluster:${clusterId}`) app.openCluster(clusterId);
}
