import { create } from 'zustand';
import { ipc } from '@/lib/ipc';
import { nextMinor } from '@/lib/kube/deprecations';
import type { ClusterId, UpgradeReport } from '@/types';
import { useAppStore } from './useAppStore';

/**
 * Upgrade readiness reports of this session, per cluster and target
 * version (`upgrade_readiness_scan`). The cluster view and the fleet card
 * on the dashboard share them; nothing is persisted.
 */

export interface UpgradeEntry {
  report: UpgradeReport | null;
  error: string | null;
  scanning: boolean;
}

interface UpgradeState {
  /** `${clusterId}|${target}`. */
  entries: Record<string, UpgradeEntry>;
  /** Target picked in a cluster's view (`null` = the next minor). */
  targets: Record<ClusterId, string | null>;
  setTarget: (clusterId: ClusterId, target: string | null) => void;
  scan: (clusterId: ClusterId, target: string | null) => Promise<void>;
  scanFleet: (clusterIds: ClusterId[]) => Promise<void>;
}

/** The version a scan with `target` (null = default) is about. */
export function effectiveTarget(clusterId: ClusterId, target: string | null): string | null {
  return target ?? nextMinor(useAppStore.getState().statuses[clusterId]?.version);
}

export function upgradeKey(clusterId: ClusterId, target: string | null): string {
  return `${clusterId}|${effectiveTarget(clusterId, target) ?? ''}`;
}

export const useUpgradeStore = create<UpgradeState>()((set, get) => ({
  entries: {},
  targets: {},
  setTarget: (clusterId, target) =>
    set((s) => ({ targets: { ...s.targets, [clusterId]: target } })),
  scan: async (clusterId, target) => {
    const key = upgradeKey(clusterId, target);
    if (get().entries[key]?.scanning) return;
    const patch = (entry: Partial<UpgradeEntry>) =>
      set((s) => ({
        entries: {
          ...s.entries,
          [key]: { report: null, error: null, scanning: false, ...s.entries[key], ...entry },
        },
      }));
    patch({ scanning: true, error: null });
    try {
      const report = await ipc.upgradeReadinessScan(clusterId, {
        target_version: target,
        metrics: true,
      });
      patch({ report, scanning: false, error: null });
    } catch (e) {
      patch({ scanning: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
  scanFleet: async (clusterIds) => {
    // A few at a time: every scan lists many kinds on its cluster.
    const queue = [...clusterIds];
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) await get().scan(id, null);
    };
    await Promise.all([worker(), worker(), worker()]);
  },
}));

export function useUpgradeEntry(clusterId: ClusterId, target: string | null): UpgradeEntry | null {
  const version = useAppStore((s) => s.statuses[clusterId]?.version);
  const key = `${clusterId}|${target ?? nextMinor(version) ?? ''}`;
  return useUpgradeStore((s) => s.entries[key] ?? null);
}
