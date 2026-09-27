import { create } from 'zustand';
import type { Finding, HealthIgnore } from '@/lib/kube/health';
import type { ClusterId } from '@/types';

/**
 * Health check state. Ignored rules are part of the workspace snapshot
 * (`healthIgnores` in `~/.kubepit/workspace.json`, saved by
 * `useAppBootstrap`); the last scan per cluster is session-only and lets
 * the details panel show cross-object findings of the object it displays.
 */

export interface ScanPublication {
  /** Namespaces the scan covered ([] = all). */
  namespaces: string[];
  byUid: ReadonlyMap<string, Finding[]>;
  computedAt: number;
}

interface HealthState {
  ignores: Record<ClusterId, HealthIgnore[]>;
  scans: Record<ClusterId, ScanPublication>;
  hydrateIgnores: (ignores: Record<ClusterId, HealthIgnore[]>) => void;
  ignore: (clusterId: ClusterId, rule: string, namespace: string | null) => void;
  unignore: (clusterId: ClusterId, rule: string, namespace: string | null) => void;
  publishScan: (clusterId: ClusterId, scan: ScanPublication) => void;
}

const EMPTY: HealthIgnore[] = [];

function sanitize(raw: unknown): Record<ClusterId, HealthIgnore[]> {
  const out: Record<ClusterId, HealthIgnore[]> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [clusterId, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const items = list.flatMap((i): HealthIgnore[] =>
      i && typeof i === 'object' && typeof (i as HealthIgnore).rule === 'string'
        ? [
            {
              rule: (i as HealthIgnore).rule,
              namespace:
                typeof (i as HealthIgnore).namespace === 'string'
                  ? (i as HealthIgnore).namespace
                  : null,
            },
          ]
        : [],
    );
    if (items.length) out[clusterId] = items;
  }
  return out;
}

export const useHealthStore = create<HealthState>((set) => ({
  ignores: {},
  scans: {},
  hydrateIgnores: (ignores) => set({ ignores: sanitize(ignores) }),
  ignore: (clusterId, rule, namespace) =>
    set((s) => {
      const list = s.ignores[clusterId] ?? [];
      if (list.some((i) => i.rule === rule && i.namespace === namespace)) return {};
      // An "everywhere" ignore replaces the per-namespace ones of the same rule.
      const kept = namespace === null ? list.filter((i) => i.rule !== rule) : list;
      return { ignores: { ...s.ignores, [clusterId]: [...kept, { rule, namespace }] } };
    }),
  unignore: (clusterId, rule, namespace) =>
    set((s) => {
      const list = (s.ignores[clusterId] ?? []).filter(
        (i) => !(i.rule === rule && i.namespace === namespace),
      );
      const ignores = { ...s.ignores };
      if (list.length) ignores[clusterId] = list;
      else delete ignores[clusterId];
      return { ignores };
    }),
  publishScan: (clusterId, scan) => set((s) => ({ scans: { ...s.scans, [clusterId]: scan } })),
}));

export function useHealthIgnores(clusterId: ClusterId): HealthIgnore[] {
  return useHealthStore((s) => s.ignores[clusterId] ?? EMPTY);
}
