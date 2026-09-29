import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { events, ipc } from '@/lib/ipc';
import type {
  ClusterId,
  RecommendationLatest,
  RecommendationRun,
  RecommendationScanStatus,
  RecommendationScanView,
  RightsizingReport,
  ScanState,
} from '@/types';
import type { AppState } from './types';
import { useAppStore } from './useAppStore';

/**
 * Stored recommendation scans per cluster: the latest scan (re-evaluated
 * by the backend with the current strategy and settings), a past run the
 * view picked, the runs, the scan status and the rows applied in this
 * session. Scan events (`recommendations://scan`) keep the status current
 * and reload the scan when one ends. Nothing is persisted here: the data
 * lives in `history.db`.
 */

export interface ClusterRecs {
  /** `recommendations_latest(clusterId, null)`: the latest scan, `source_changed`, `last_failure`. */
  latest: RecommendationLatest | null;
  status: RecommendationScanStatus | null;
  /** Stored runs, newest first. */
  runs: RecommendationRun[];
  /** The past run the view shows (null = the latest). */
  runId: number | null;
  /** `recommendations_latest(clusterId, runId)` for the picked run. */
  past: RecommendationLatest | null;
  loading: boolean;
  /** The last read of the latest scan failed (a backend message). */
  error: string | null;
  /** `workloadKey` → when it was applied in this session; cleared by a scan started later. */
  applied: Record<string, number>;
  /** Settings and source key of the last requested load (see `recommendationsKey`). */
  key: string | null;
  runsLoaded: boolean;
}

const BLANK: ClusterRecs = {
  latest: null,
  status: null,
  runs: [],
  runId: null,
  past: null,
  loading: false,
  error: null,
  applied: {},
  key: null,
  runsLoaded: false,
};

const TERMINAL: ReadonlySet<ScanState> = new Set(['success', 'failed', 'interrupted']);

interface RecommendationsState {
  byCluster: Record<ClusterId, ClusterRecs>;
  /**
   * Read the latest scan; with a picked run (`runId`, which also picks it;
   * `null` goes back to the latest) read that run too.
   */
  load: (clusterId: ClusterId, runId?: number | null) => Promise<void>;
  loadRuns: (clusterId: ClusterId) => Promise<void>;
  loadStatus: (clusterId: ClusterId) => Promise<void>;
  /**
   * "Scan now". A refusal (disconnected, rate-limited) only re-reads the
   * status: the view follows `manual_available_at` and the connection
   * instead of showing the backend's message.
   */
  scanNow: (clusterId: ClusterId) => Promise<void>;
  /** Show a past run (`null` = the latest). */
  selectRun: (clusterId: ClusterId, runId: number | null) => Promise<void>;
  markApplied: (clusterId: ClusterId, key: string) => void;
  /** A `recommendations://scan` status: when a scan ended, reload the scan and the runs. */
  onScanEvent: (status: RecommendationScanStatus) => void;
}

/** Sequence numbers per cluster, so an older answer never overwrites a newer one. */
const latestSeq = new Map<ClusterId, number>();
const pastSeq = new Map<ClusterId, number>();
/** Bumped by every status applied; a read started before a newer status is dropped. */
const statusSeq = new Map<ClusterId, number>();

const bump = (seqs: Map<ClusterId, number>, id: ClusterId) => {
  const next = (seqs.get(id) ?? 0) + 1;
  seqs.set(id, next);
  return next;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * What a stored scan's re-evaluation depends on besides the scan: the saved
 * strategy and overrides, and the cluster's Prometheus configuration
 * (`source_changed`). A change reloads the latest scan.
 */
export function recommendationsKey(s: Pick<AppState, 'settings' | 'clusters'>, id: ClusterId) {
  const rec = s.settings?.recommendations;
  const cluster = s.clusters.find((c) => c.id === id);
  return JSON.stringify([
    rec?.strategy ?? null,
    rec?.overrides ?? null,
    cluster?.prometheus ?? null,
    cluster?.prometheus_access ?? null,
  ]);
}

export const useRecommendationsStore = create<RecommendationsState>()((set, get) => {
  const patch = (
    id: ClusterId,
    change: Partial<ClusterRecs> | ((e: ClusterRecs) => Partial<ClusterRecs>),
  ) =>
    set((s) => {
      const entry = s.byCluster[id] ?? BLANK;
      const next = typeof change === 'function' ? change(entry) : change;
      return { byCluster: { ...s.byCluster, [id]: { ...entry, ...next } } };
    });

  const fetchLatest = async (id: ClusterId) => {
    const seq = bump(latestSeq, id);
    patch(id, { loading: true, key: recommendationsKey(useAppStore.getState(), id) });
    try {
      const latest = await ipc.recommendationsLatest(id, null);
      if (latestSeq.get(id) !== seq) return;
      // A scan that started after an apply reflects it.
      const since = latest.scan?.run.started_at ?? null;
      patch(id, (e) => ({
        latest,
        loading: false,
        error: null,
        applied:
          since == null
            ? e.applied
            : Object.fromEntries(Object.entries(e.applied).filter(([, at]) => at >= since)),
      }));
    } catch (e) {
      if (latestSeq.get(id) !== seq) return;
      patch(id, { loading: false, error: message(e) });
    }
  };

  const fetchPast = async (id: ClusterId, runId: number) => {
    const seq = bump(pastSeq, id);
    try {
      const past = await ipc.recommendationsLatest(id, runId);
      if (pastSeq.get(id) !== seq || get().byCluster[id]?.runId !== runId) return;
      patch(id, { past });
    } catch {
      // The run was pruned since the picker listed it: show the latest.
      if (pastSeq.get(id) !== seq || get().byCluster[id]?.runId !== runId) return;
      patch(id, { runId: null, past: null });
    }
  };

  const applyStatus = (status: RecommendationScanStatus, fromEvent: boolean) => {
    const id = status.cluster_id;
    bump(statusSeq, id);
    const entry = get().byCluster[id];
    const prev = entry?.status ?? null;
    patch(id, { status });
    // `next_at` and `scheduled` updates repeat the last state: only a new
    // (run, state) pair is a change.
    const changed = prev ? prev.run_id !== status.run_id || prev.state !== status.state : fromEvent;
    const loaded = !!entry && entry.key !== null;
    if (changed && loaded && TERMINAL.has(status.state)) {
      void get().load(id);
      void get().loadRuns(id);
    }
  };

  return {
    byCluster: {},
    load: async (id, runId) => {
      if (runId !== undefined)
        patch(id, (e) => ({ runId, past: runId === e.runId ? e.past : null }));
      const picked = get().byCluster[id]?.runId ?? null;
      await Promise.all([fetchLatest(id), picked != null ? fetchPast(id, picked) : null]);
    },
    loadRuns: async (id) => {
      try {
        const runs = await ipc.recommendationsRuns(id);
        patch(id, { runs, runsLoaded: true });
      } catch {
        patch(id, { runsLoaded: true });
      }
    },
    loadStatus: async (id) => {
      const seq = bump(statusSeq, id);
      try {
        const status = await ipc.recommendationsStatus(id);
        if (statusSeq.get(id) === seq) applyStatus(status, false);
      } catch {
        /* The next event or visit reads it again. */
      }
    },
    scanNow: async (id) => {
      const seq = bump(statusSeq, id);
      try {
        const status = await ipc.recommendationsScan(id);
        // Events of the scan may already be newer than this answer.
        if (statusSeq.get(id) === seq) applyStatus(status, false);
      } catch {
        await get().loadStatus(id);
      }
    },
    selectRun: async (id, runId) => {
      patch(id, (e) => ({ runId, past: runId === e.runId ? e.past : null }));
      if (runId != null) await fetchPast(id, runId);
    },
    markApplied: (id, key) => patch(id, (e) => ({ applied: { ...e.applied, [key]: Date.now() } })),
    onScanEvent: (status) => applyStatus(status, true),
  };
});

/** Listen to `recommendations://scan` for the whole window; returns the unsubscribe. */
export function startRecommendationEvents(): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  events
    .onRecommendationScan((status) => useRecommendationsStore.getState().onScanEvent(status))
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch((e: unknown) => console.warn('recommendation scan events unavailable', e));
  return () => {
    disposed = true;
    unlisten?.();
  };
}

export interface LatestRecommendations {
  /** The latest scan's re-evaluated report (null before the first scan or after a source change). */
  report: RightsizingReport | null;
  run: RecommendationRun | null;
  latest: RecommendationLatest | null;
  status: RecommendationScanStatus | null;
  loading: boolean;
  error: string | null;
}

/**
 * Keeps a cluster's latest scan and status loaded while `enabled`: the
 * first use reads them, a change of the saved strategy, the overrides or
 * the cluster's Prometheus configuration re-reads the scan, and a
 * connection change re-reads the status. Many views share one entry.
 */
export function useLatestRecommendations(
  clusterId: ClusterId,
  enabled: boolean,
): LatestRecommendations {
  const key = useAppStore((s) => recommendationsKey(s, clusterId));
  const connection = useAppStore((s) => s.statuses[clusterId]?.state ?? null);
  const entry = useRecommendationsStore((s) => s.byCluster[clusterId]);

  useEffect(() => {
    if (!enabled) return;
    if (useRecommendationsStore.getState().byCluster[clusterId]?.key === key) return;
    void useRecommendationsStore.getState().load(clusterId);
  }, [enabled, clusterId, key]);

  useEffect(() => {
    if (enabled) void useRecommendationsStore.getState().loadStatus(clusterId);
  }, [enabled, clusterId, connection]);

  return useMemo(() => {
    const latest = entry?.latest ?? null;
    return {
      report: latest?.scan?.report ?? null,
      run: latest?.scan?.run ?? null,
      latest,
      status: entry?.status ?? null,
      loading: entry?.loading ?? enabled,
      error: entry?.error ?? null,
    };
  }, [entry, enabled]);
}

export interface ShownRecommendations extends LatestRecommendations {
  /** The scan the view shows: the picked past run, else the latest. */
  scan: RecommendationScanView | null;
  /** The picked past run (null = the latest). */
  runId: number | null;
  /** A past run is shown (read-only). */
  past: boolean;
  runs: RecommendationRun[];
}

/**
 * What the Recommendations view shows: the latest scan, or the past run
 * picked in its header (`report` and `run` follow the pick; `latest` stays
 * the latest for its notes), plus the runs for the picker.
 */
export function useShownRecommendations(
  clusterId: ClusterId,
  enabled: boolean,
): ShownRecommendations {
  const base = useLatestRecommendations(clusterId, enabled);
  const entry = useRecommendationsStore((s) => s.byCluster[clusterId]);
  const runsLoaded = entry?.runsLoaded ?? false;

  useEffect(() => {
    if (enabled && !runsLoaded) void useRecommendationsStore.getState().loadRuns(clusterId);
  }, [enabled, clusterId, runsLoaded]);

  return useMemo(() => {
    const runId = entry?.runId ?? null;
    const pastScan = runId != null ? (entry?.past?.scan ?? null) : null;
    const scan = runId != null ? pastScan : (base.latest?.scan ?? null);
    return {
      ...base,
      scan,
      report: scan?.report ?? null,
      run: scan?.run ?? null,
      runId,
      past: runId != null,
      // A picked run is loading until its answer arrives.
      loading: base.loading || (runId != null && !pastScan),
      runs: entry?.runs ?? [],
    };
  }, [base, entry]);
}
