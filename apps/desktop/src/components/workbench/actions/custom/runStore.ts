import { create } from 'zustand';
import type {
  ClusterId,
  CustomAction,
  CustomActionResult,
  CustomActionTarget,
  ResolvedCustomAction,
} from '@/types';

/**
 * State of custom action runs shown by `CustomActionHost`: the pending
 * confirmation (with the resolved command), background runs and the run
 * whose output is open.
 */

export interface CustomActionRun {
  id: string;
  clusterId: ClusterId;
  action: CustomAction;
  target: CustomActionTarget;
  /** `namespace/name`, "3 objects" or the cluster name (display only). */
  label: string;
  status: 'running' | 'done' | 'failed';
  result: CustomActionResult | null;
  error: string | null;
  startedAt: number;
}

export interface CustomActionConfirm {
  clusterId: ClusterId;
  action: CustomAction;
  target: CustomActionTarget;
  label: string;
  /** Null while resolving. */
  resolved: ResolvedCustomAction | null;
  error: string | null;
  /** Production cluster + mutating action: the user types this to confirm. */
  typeToConfirm: string | null;
  run: () => void;
}

interface RunState {
  confirm: CustomActionConfirm | null;
  runs: CustomActionRun[];
  /** Run whose output dialog is open. */
  openRunId: string | null;
  setConfirm: (confirm: CustomActionConfirm | null) => void;
  patchConfirm: (patch: Partial<CustomActionConfirm>) => void;
  addRun: (run: CustomActionRun) => void;
  patchRun: (id: string, patch: Partial<CustomActionRun>) => void;
  dismissRun: (id: string) => void;
  openOutput: (id: string | null) => void;
}

/** Finished runs kept in the panel. */
const MAX_RUNS = 6;

export const useCustomActionRuns = create<RunState>((set) => ({
  confirm: null,
  runs: [],
  openRunId: null,
  setConfirm: (confirm) => set({ confirm }),
  patchConfirm: (patch) => set((s) => (s.confirm ? { confirm: { ...s.confirm, ...patch } } : s)),
  addRun: (run) =>
    set((s) => {
      const runs = [run, ...s.runs];
      // Drop the oldest finished runs beyond the limit; running ones stay.
      while (runs.length > MAX_RUNS) {
        const at = runs.map((r) => r.status).lastIndexOf('done');
        const failed = runs.map((r) => r.status).lastIndexOf('failed');
        const drop = Math.max(at, failed);
        if (drop < 0) break;
        runs.splice(drop, 1);
      }
      return { runs };
    }),
  patchRun: (id, patch) =>
    set((s) => ({ runs: s.runs.map((r) => (r.id === id ? { ...r, ...patch } : r)) })),
  dismissRun: (id) =>
    set((s) => ({
      runs: s.runs.filter((r) => r.id !== id),
      openRunId: s.openRunId === id ? null : s.openRunId,
    })),
  openOutput: (openRunId) => set({ openRunId }),
}));
