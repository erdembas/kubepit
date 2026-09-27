import { create } from 'zustand';
import { VIEW_KEYS } from '@/lib/kube/nav';
import type { ClusterId } from '@/types';
import { useAppStore } from './useAppStore';
import { useWorkbenchStore } from './useWorkbenchStore';

/**
 * API explorer ("explain") state per cluster: which kind it shows and a
 * field to reveal. Editors, kind pages and the command palette open it
 * through `openExplain`; the page (`components/workbench/explain/`)
 * renders it. Session-only.
 */

export interface ExplainTarget {
  /** `v1`, `apps/v1`. */
  apiVersion: string;
  kind: string;
}

export interface ExplainFocus {
  /** Explorer path of the field (`spec.template.spec.containers.image`). */
  path: string[];
  /** Bumped on every request so revealing the same field twice still scrolls. */
  nonce: number;
}

interface ExplainState {
  target: Record<ClusterId, ExplainTarget>;
  focus: Record<ClusterId, ExplainFocus>;
  setTarget: (clusterId: ClusterId, target: ExplainTarget, path?: string[]) => void;
}

let nonce = 0;

export const useExplainStore = create<ExplainState>()((set) => ({
  target: {},
  focus: {},
  setTarget: (clusterId, target, path = []) =>
    set((s) => ({
      target: { ...s.target, [clusterId]: target },
      focus: { ...s.focus, [clusterId]: { path, nonce: ++nonce } },
    })),
}));

/**
 * Open the API explorer tab of a cluster workbench, optionally on a kind
 * and one of its fields, and bring the cluster's main tab to the front.
 */
export function openExplain(clusterId: ClusterId, target?: ExplainTarget | null, path?: string[]) {
  if (target) useExplainStore.getState().setTarget(clusterId, target, path);
  useWorkbenchStore.getState().setActiveKind(clusterId, VIEW_KEYS.apiExplorer);
  const app = useAppStore.getState();
  if (app.activeMainTabKey !== `cluster:${clusterId}`) app.openCluster(clusterId);
}
