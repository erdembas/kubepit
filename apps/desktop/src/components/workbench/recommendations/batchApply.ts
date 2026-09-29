import * as i18n from '@/i18n/core';
import { ipc } from '@/lib/ipc';
import { applyMode, workloadKey } from '@/lib/kube/recommendations/model';
import { changesOf } from '@/lib/kube/rightsizing/model';
import { useAppStore } from '@/store/useAppStore';
import { useRecommendationsStore } from '@/store/useRecommendationsStore';
import type {
  ClusterDef,
  ClusterId,
  ContainerResourceChange,
  WorkloadRecommendation,
} from '@/types';
import { refreshRightsizing } from '../cost/useCost';
import { errorText } from '../util';
import {
  appliedInSession,
  applyRefusal,
  dryRunCheck,
  exclusiveApply,
  isApplying,
  refusalText,
  targetOf,
} from './quickApply';

/**
 * "Apply {n} high-confidence" (spec §8): the checked `one-click` rows are
 * dry-run one at a time, then "Apply" patches only the rows whose dry run
 * passed in this session, one at a time, through the audited
 * `rightsizing_apply`. A session applies at most once; it stops before the
 * next row when the cluster disconnects, turns read-only, or the user
 * stops or closes it.
 */

/**
 * The checked rows the batch may cover: shown (the tab, lenses and search
 * applied), checked, `one-click` on this cluster, not applied in this
 * session and not known to be denied by RBAC (`blocked`). Unknown,
 * read-only and production clusters have none.
 */
export function batchTargets(
  shown: readonly WorkloadRecommendation[],
  selected: ReadonlySet<string>,
  cluster: Pick<ClusterDef, 'read_only' | 'environment'> | undefined,
  applied: Readonly<Record<string, number>>,
  blocked: (rec: WorkloadRecommendation) => string | null = () => null,
): WorkloadRecommendation[] {
  if (!cluster || !selected.size) return [];
  return shown.filter((rec) => {
    const key = workloadKey(rec);
    return (
      selected.has(key) &&
      !(key in applied) &&
      applyMode(rec, cluster) === 'one-click' &&
      !blocked(rec)
    );
  });
}

export type BatchRowState =
  /** Waits for its dry run. */
  | 'waiting'
  | 'checking'
  /** Its dry run passed in this session. */
  | 'ready'
  /** Not applied: refused, or its dry run failed. */
  | 'rejected'
  | 'applying'
  | 'applied'
  /** The patch failed. */
  | 'failed'
  /** Passed its dry run but was not applied (stopped, disconnected, applied elsewhere). */
  | 'skipped';

export interface BatchRow {
  key: string;
  rec: WorkloadRecommendation;
  state: BatchRowState;
  /** Why it was rejected, failed or skipped. */
  message: string | null;
  /** What its dry run checked and its patch writes. */
  changes: ContainerResourceChange[];
}

export type BatchPhase = 'refused' | 'checking' | 'ready' | 'applying' | 'done';

export interface BatchState {
  phase: BatchPhase;
  rows: readonly BatchRow[];
  /** Why the whole batch is refused (read-only, production, unknown cluster). */
  refusal: string | null;
  /** Why applying stopped before the last row. */
  stopped: string | null;
}

export interface BatchSession {
  getState: () => BatchState;
  subscribe: (listener: (state: BatchState) => void) => () => void;
  /** Dry-runs every waiting row in turn (once). */
  check: () => Promise<void>;
  /** Applies the rows whose dry run passed (once, after `check`). */
  apply: () => Promise<void>;
  /** Stops applying before the next row. */
  stop: () => void;
  /** The dialog closed: nothing more is dry-run or applied, nobody is told. */
  dispose: () => void;
}

export interface BatchOptions {
  /** Why the user may not apply `rec` (RBAC), checked before each dry run and patch. */
  blocked?: (rec: WorkloadRecommendation) => string | null;
}

/** A session's rows before anything ran: refused, rejected up front, or waiting for a dry run. */
export function batchInitialState(
  clusterId: ClusterId,
  recs: readonly WorkloadRecommendation[],
): BatchState {
  const cluster = useAppStore.getState().clusters.find((c) => c.id === clusterId);
  const refusal = !cluster
    ? refusalText('unknown-cluster')
    : cluster.read_only
      ? i18n.t('This cluster is read-only: nothing can be applied.')
      : cluster.environment === 'production'
        ? refusalText('production')
        : null;
  const seen = new Set<string>();
  const rows: BatchRow[] = [];
  for (const rec of recs) {
    const key = workloadKey(rec);
    if (seen.has(key)) continue;
    seen.add(key);
    const changes = changesOf(rec);
    const reason = refusal
      ? null
      : applyMode(rec, cluster!) !== 'one-click'
        ? refusalText('not-one-click')
        : appliedInSession(clusterId, key)
          ? i18n.t('Already applied')
          : !changes.length
            ? i18n.t('Nothing to change')
            : null;
    rows.push({
      key,
      rec,
      changes,
      state: refusal || reason ? 'rejected' : 'waiting',
      message: reason,
    });
  }
  return { phase: refusal ? 'refused' : 'checking', rows, refusal, stopped: null };
}

/** A batch apply session over `recs` (the list's `batchTargets`). */
export function createBatchSession(
  clusterId: ClusterId,
  recs: readonly WorkloadRecommendation[],
  { blocked = () => null }: BatchOptions = {},
): BatchSession {
  let state = batchInitialState(clusterId, recs);
  const listeners = new Set<(state: BatchState) => void>();
  let disposed = false;
  let stopRequested = false;
  let checking: Promise<void> | null = null;
  let applying: Promise<void> | null = null;

  const set = (next: Partial<BatchState>) => {
    state = { ...state, ...next };
    for (const l of listeners) l(state);
  };
  const setRow = (key: string, patch: Partial<BatchRow>) =>
    set({ rows: state.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) });
  const rowOf = (key: string) => state.rows.find((r) => r.key === key)!;

  const check = () => {
    if (checking) return checking;
    if (state.phase !== 'checking') return Promise.resolve();
    checking = (async () => {
      const keys = state.rows.filter((r) => r.state === 'waiting').map((r) => r.key);
      for (let i = 0; i < keys.length; i++) {
        if (disposed) return;
        const row = rowOf(keys[i]!);
        const refusal = applyRefusal(clusterId, row.rec);
        if (refusal && refusal !== 'not-one-click') {
          // Cluster-wide (disconnected, read-only…): nothing more is checked.
          const message = refusalText(refusal);
          for (const key of keys.slice(i)) setRow(key, { state: 'rejected', message });
          break;
        }
        const denied = refusal ? refusalText(refusal) : blocked(row.rec);
        if (denied) {
          setRow(row.key, { state: 'rejected', message: denied });
          continue;
        }
        setRow(row.key, { state: 'checking' });
        const outcome = await dryRunCheck(clusterId, row.rec, row.changes);
        if (disposed) return;
        setRow(
          row.key,
          outcome.ok
            ? { state: 'ready', message: null }
            : { state: 'rejected', message: outcome.message },
        );
      }
      set({ phase: 'ready' });
    })();
    return checking;
  };

  const apply = () => {
    if (applying) return applying;
    if (state.phase !== 'ready' || !state.rows.some((r) => r.state === 'ready'))
      return Promise.resolve();
    // Synchronous, so a second click finds `applying` set.
    set({ phase: 'applying' });
    applying = (async () => {
      const keys = state.rows.filter((r) => r.state === 'ready').map((r) => r.key);
      let applied = 0;
      for (let i = 0; i < keys.length; i++) {
        const row = rowOf(keys[i]!);
        const refusal = applyRefusal(clusterId, row.rec);
        const stop = disposed
          ? i18n.t('Not applied: the dialog was closed.')
          : stopRequested
            ? i18n.t('Not applied: stopped.')
            : refusal && refusal !== 'not-one-click'
              ? refusalText(refusal)
              : null;
        if (stop) {
          for (const key of keys.slice(i)) setRow(key, { state: 'skipped', message: stop });
          set({ stopped: stop });
          break;
        }
        const denied = refusal ? refusalText(refusal) : blocked(row.rec);
        const elsewhere = appliedInSession(clusterId, row.key)
          ? i18n.t('Already applied')
          : isApplying(clusterId, row.key)
            ? i18n.t('Already being applied')
            : null;
        if (denied || elsewhere) {
          setRow(row.key, { state: 'skipped', message: denied ?? elsewhere });
          continue;
        }
        setRow(row.key, { state: 'applying' });
        let failure: string | null = null;
        await exclusiveApply(clusterId, row.key, async () => {
          try {
            await ipc.rightsizingApply(clusterId, targetOf(row.rec), row.changes, false);
            useRecommendationsStore.getState().markApplied(clusterId, row.key);
            return 'applied';
          } catch (e) {
            failure = errorText(e);
            return 'review';
          }
        });
        if (failure == null) applied++;
        setRow(
          row.key,
          failure == null ? { state: 'applied' } : { state: 'failed', message: failure },
        );
      }
      if (applied) {
        refreshRightsizing(clusterId);
        useAppStore
          .getState()
          .pushToast(
            'success',
            i18n.plural('Right-sized {count} workload', 'Right-sized {count} workloads', applied),
          );
      }
      set({ phase: 'done' });
    })();
    return applying;
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    check,
    apply,
    stop: () => {
      stopRequested = true;
    },
    dispose: () => {
      disposed = true;
      listeners.clear();
    },
  };
}

/** Rows per state, for the progress and the summary. */
export function batchCounts(rows: readonly BatchRow[]): Record<BatchRowState, number> {
  const counts: Record<BatchRowState, number> = {
    waiting: 0,
    checking: 0,
    ready: 0,
    rejected: 0,
    applying: 0,
    applied: 0,
    failed: 0,
    skipped: 0,
  };
  for (const r of rows) counts[r.state]++;
  return counts;
}
