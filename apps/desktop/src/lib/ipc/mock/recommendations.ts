import type {
  ClusterDef,
  ClusterRecommendationSummary,
  ClusterStatus,
  RecommendationExportFormat,
  RecommendationLatest,
  RecommendationRun,
  RecommendationScanStatus,
  RecommendationScanView,
  RecommendationTrendPoint,
  RightsizingReport,
  RightsizingSettings,
  RightsizingSource,
  ScanProgress,
  ScanState,
  ScanTrigger,
  Settings,
  WorkloadRecommendation,
  WorkloadRef,
  WorkloadUsageHistory,
} from '@/types';
import { mockEmit, sleep } from './bus';
import { collect, effectiveSettings, pricingOf, savedStrategy, usageSource } from './cost';
import { resolveStrategy, workloadRecommendations } from './fixtures/cost';
import { getDb } from './fixtures/db';
import {
  alignedWindowEnd,
  assembleReport,
  autoStep,
  collectionNotes,
  demoCollection,
  exportJson,
  exportYaml,
  noDataNamespaces,
  sameSettings,
  seedRuns,
  sourceConfig,
  strategyDefaults,
  summarize,
  usageSeries,
  validateHistoryRequest,
  workloadCount,
} from './fixtures/recommendations';
import { DAY } from './fixtures/util';
import { provideRecommendationHistory } from './history';
import { handlers, register, type MockArgs } from './registry';

/**
 * Demo recommendation scans, like `recommendations/{scan,schedule}.rs` and
 * the read commands: a seeded history per cluster (see
 * `fixtures/recommendations.ts`), "Scan now" with queued → running (a
 * growing progress total) → success, background scans of opted-in
 * connected clusters, re-evaluation with the current strategy and
 * settings, trends, the fleet, exports and usage-history charts. Runs keep
 * how they were collected, not their rows: a report is rebuilt from the
 * fixtures at the run's time (deterministic), so re-evaluating one is
 * rebuilding it with other settings on the same window.
 */

const MANUAL_COOLDOWN_MS = 60_000;
const FIRST_DELAY_MS = 120_000;
const MAX_CONCURRENT = 2;
const ERROR_STOPPED = 'stopped';

/** How a successful run was collected (its report is rebuilt from this). */
interface RunInputs {
  source: RightsizingSource;
  strategy: string;
  strategyAuto: boolean;
  settings: RightsizingSettings;
  at: number;
}

interface DemoRun {
  run: RecommendationRun;
  sourceConfig: string;
  inputs: RunInputs | null;
  report?: RightsizingReport;
}

const runs = new Map<string, DemoRun[]>();
let nextRunId = 1;
let seeded = false;
const statuses = new Map<string, RecommendationScanStatus>();
const lastManual = new Map<string, number>();
/** Scans in progress per cluster; `cancel` stops one (disconnect, removal). */
const scanning = new Map<string, { cancelled: boolean }>();
/** Schedulers per cluster: connect time, jitter and a source change's due time. */
const schedules = new Map<
  string,
  { connectedAt: number; jitter: number; dueOverride: number | null }
>();

function clusters(): ClusterDef[] {
  return (handlers.cluster_list?.({}) as ClusterDef[] | undefined) ?? [];
}

function clusterDef(id: string): ClusterDef {
  const cluster = clusters().find((c) => c.id === id);
  if (!cluster) throw new Error(`cluster ${id} is not registered`);
  return cluster;
}

function connectionOf(id: string): ClusterStatus | undefined {
  return (handlers.cluster_statuses?.({}) as Record<string, ClusterStatus> | undefined)?.[id];
}

const connected = (id: string) => connectionOf(id)?.state === 'connected';

function settings(): Settings['recommendations'] | undefined {
  return (handlers.settings_get?.({}) as Settings | undefined)?.recommendations;
}

const intervalMinutes = () => Math.min(1440, Math.max(15, settings()?.interval_minutes ?? 60));

// -- The seeded history ----------------------------------------------------------

function ensureSeeded() {
  if (seeded) return;
  seeded = true;
  const now = Date.now();
  const all: Array<{ clusterId: string; seed: ReturnType<typeof seedRuns>[number] }> = [];
  for (const c of clusters())
    for (const seed of seedRuns(c.id, now)) all.push({ clusterId: c.id, seed });
  all.sort((a, b) => a.seed.startedAt - b.seed.startedAt);
  for (const { clusterId, seed } of all) {
    const cluster = clusterDef(clusterId);
    const collection = demoCollection(getDb(clusterId));
    const resolved = resolveStrategy(null, seed.source === 'prometheus' && collection.ownerMetrics);
    const inputs: RunInputs | null =
      seed.status === 'success'
        ? {
            source: seed.source,
            strategy: resolved.id,
            strategyAuto: resolved.auto,
            // What the strategy ran with at the time: its defaults.
            settings: strategyDefaults(resolved.id),
            at: seed.startedAt,
          }
        : null;
    const list = runs.get(clusterId) ?? [];
    list.push({
      run: {
        id: nextRunId++,
        cluster_id: clusterId,
        started_at: seed.startedAt,
        finished_at: seed.finishedAt,
        status: seed.status,
        trigger: seed.trigger,
        error: seed.error,
        source: inputs ? seed.source : null,
        strategy: inputs?.strategy ?? null,
        window_secs: null,
        workloads: 0,
        rows_kept: !!inputs,
        summary: null,
      },
      sourceConfig: sourceConfig(cluster),
      inputs,
    });
    runs.set(clusterId, list);
  }
}

function runsOf(clusterId: string): DemoRun[] {
  ensureSeeded();
  return runs.get(clusterId) ?? [];
}

/** The report a run stored (rebuilt once, then kept). */
function storedReport(clusterId: string, stored: DemoRun): RightsizingReport | null {
  const inputs = stored.inputs;
  if (!inputs) return null;
  stored.report ??= buildReport(
    clusterId,
    inputs,
    inputs.strategy,
    inputs.strategyAuto,
    inputs.settings,
  );
  return stored.report;
}

/** A report of the run collected by `inputs`, computed with `strategy` and `settings` on its window. */
function buildReport(
  clusterId: string,
  inputs: RunInputs,
  strategy: string,
  strategyAuto: boolean,
  settings: RightsizingSettings,
  only: WorkloadRef | null = null,
): RightsizingReport {
  const db = getDb(clusterId);
  const collection = demoCollection(db);
  const prometheus = inputs.source === 'prometheus';
  const pricing = pricingOf(clusterDef(clusterId));
  const workloads = workloadRecommendations(
    db,
    inputs.source,
    settings,
    pricing,
    { namespaces: [], workload: only },
    inputs.at,
    {
      strategy,
      ownerMetrics: collection.ownerMetrics,
      windowDays: inputs.settings.days,
      failedNamespaces: prometheus ? noDataNamespaces(collection) : [],
      partialNamespaces: prometheus ? collection.partialNamespaces : [],
      hpas: collection.hpas,
      at: inputs.at,
    },
  );
  return assembleReport({
    source: inputs.source,
    windowDays: inputs.settings.days,
    settings,
    pricing,
    workloads,
    notes: collectionNotes(collection, inputs.source, new Set(workloads.map((w) => w.namespace))),
    strategy,
    strategyAuto,
    computedAt: inputs.at,
    windowEnd: prometheus ? alignedWindowEnd(inputs.at) : inputs.at,
  });
}

/** The run with its summary and window filled in (from its report). */
function runView(clusterId: string, stored: DemoRun): RecommendationRun {
  const report = storedReport(clusterId, stored);
  if (!report) return structuredClone(stored.run);
  return {
    ...structuredClone(stored.run),
    window_secs: report.window_secs,
    workloads: report.workloads.length,
    summary: stored.run.summary ?? (stored.run.summary = summarize(report)),
  };
}

// -- Status and event ------------------------------------------------------------

function blankStatus(clusterId: string): RecommendationScanStatus {
  const last = [...runsOf(clusterId)].reverse().find((r) => r.run.status === 'success');
  return {
    cluster_id: clusterId,
    scheduled: false,
    interval_minutes: intervalMinutes(),
    state: 'idle',
    run_id: null,
    trigger: null,
    progress: null,
    started_at: null,
    finished_at: null,
    error: null,
    last_success_at: last?.run.finished_at ?? null,
    next_at: null,
    manual_available_at: null,
  };
}

function statusOf(clusterId: string): RecommendationScanStatus {
  const status = statuses.get(clusterId) ?? blankStatus(clusterId);
  statuses.set(clusterId, status);
  status.interval_minutes = intervalMinutes();
  const schedule = schedules.get(clusterId);
  status.scheduled = !!schedule;
  status.next_at = schedule ? dueAt(clusterId) : null;
  return status;
}

function update(clusterId: string, change: (s: RecommendationScanStatus) => void) {
  const status = statusOf(clusterId);
  change(status);
  const copy = structuredClone(status);
  mockEmit('recommendations://scan', copy);
  return copy;
}

function queued(s: RecommendationScanStatus, trigger: ScanTrigger) {
  Object.assign(s, {
    state: 'queued' satisfies ScanState,
    trigger,
    run_id: null,
    progress: null,
    started_at: null,
    finished_at: null,
    error: null,
  });
}

// -- Scans ----------------------------------------------------------------------

/** When the next background scan of an opted-in, connected cluster is due. */
function dueAt(clusterId: string): number | null {
  const schedule = schedules.get(clusterId);
  if (!schedule) return null;
  if (schedule.dueOverride != null) return schedule.dueOverride;
  const newest = runsOf(clusterId).at(-1)?.run;
  const first = schedule.connectedAt + FIRST_DELAY_MS + schedule.jitter;
  if (!newest) return first;
  const end = newest.finished_at ?? newest.started_at;
  return Math.max(first, end + intervalMinutes() * 60_000);
}

async function runScan(clusterId: string, trigger: ScanTrigger) {
  const token = { cancelled: false };
  scanning.set(clusterId, token);
  let run: DemoRun | null = null;
  const end = (state: ScanState, error: string | null) => {
    if (scanning.get(clusterId) === token) scanning.delete(clusterId);
    const schedule = schedules.get(clusterId);
    if (schedule) schedule.dueOverride = null;
    const now = Date.now();
    update(clusterId, (s) => {
      Object.assign(s, { state, error, progress: null, finished_at: now });
      if (state === 'success') s.last_success_at = now;
    });
  };
  try {
    if (!statuses.get(clusterId) || statuses.get(clusterId)!.state !== 'queued')
      update(clusterId, (s) => queued(s, trigger));
    // Two scans collect at a time; the rest stay queued.
    await sleep(250);
    while (
      [...scanning.keys()].filter((id) => statuses.get(id)?.state === 'running').length >=
      MAX_CONCURRENT
    )
      await sleep(250);
    if (token.cancelled) return;
    const cluster = clusterDef(clusterId);
    const startedAt = Date.now();
    run = {
      run: {
        id: nextRunId++,
        cluster_id: clusterId,
        started_at: startedAt,
        finished_at: null,
        status: 'running',
        trigger,
        error: null,
        source: null,
        strategy: null,
        window_secs: null,
        workloads: 0,
        rows_kept: false,
        summary: null,
      },
      sourceConfig: sourceConfig(cluster),
      inputs: null,
    };
    const list = runsOf(clusterId);
    list.push(run);
    runs.set(clusterId, list);
    const db = getDb(clusterId);
    const progress: ScanProgress = { completed: 0, total: 0, workloads: workloadCount(db) };
    update(clusterId, (s) => {
      Object.assign(s, {
        state: 'running',
        run_id: run!.run.id,
        started_at: startedAt,
        progress: { ...progress },
      });
    });
    const source = await usageSource(clusterId);
    if (source === 'prometheus') {
      // 16 queries per batch; each split adds two halves (the total grows),
      // answered over about three seconds, reported at most every 250 ms.
      const collection = demoCollection(db);
      progress.total = 16;
      let splits = collection.splits;
      while (progress.completed < progress.total) {
        await sleep(250);
        if (token.cancelled) return;
        progress.completed = Math.min(
          progress.total,
          progress.completed + Math.ceil(progress.total / 8),
        );
        if (splits > 0 && progress.completed >= 8) {
          splits -= 1;
          progress.total += 32;
        }
        update(clusterId, (s) => {
          s.progress = { ...progress };
        });
      }
    } else {
      await sleep(600);
      if (token.cancelled) return;
    }
    if (source === 'none') {
      Object.assign(run.run, {
        status: 'failed',
        error: 'no-usage-source',
        finished_at: Date.now(),
      });
      end('failed', 'no-usage-source');
      return;
    }
    const report = collect(clusterId, source, { namespaces: [] }, startedAt);
    const now = Date.now();
    run.inputs = {
      source,
      strategy: report.strategy,
      strategyAuto: report.strategy_auto,
      settings: report.settings,
      at: startedAt,
    };
    run.report = report;
    Object.assign(run.run, {
      status: 'success',
      finished_at: now,
      source,
      strategy: report.strategy,
      rows_kept: true,
    });
    end('success', null);
  } finally {
    if (token.cancelled && run && run.run.status === 'running') {
      Object.assign(run.run, {
        status: 'interrupted',
        error: ERROR_STOPPED,
        finished_at: Date.now(),
      });
    }
    if (token.cancelled) end('interrupted', ERROR_STOPPED);
  }
}

/** Disconnect, removal: stop the cluster's scan (it ends as interrupted). */
function stopScan(clusterId: string) {
  const token = scanning.get(clusterId);
  if (token) token.cancelled = true;
}

/** Start or stop schedulers after a settings or connection change. */
function syncSchedules() {
  const opted = new Set(settings()?.scan_clusters ?? []);
  for (const c of clusters()) {
    const wanted = opted.has(c.id) && connected(c.id);
    const has = schedules.has(c.id);
    if (wanted && !has) {
      schedules.set(c.id, {
        connectedAt: connectionOf(c.id)?.connected_at ?? Date.now(),
        jitter: Math.floor(Math.random() * 60_000),
        dueOverride: null,
      });
    } else if (!wanted && has) {
      // Opting out stops the scheduler and its scan; a manual scan keeps running.
      schedules.delete(c.id);
      if (statuses.get(c.id)?.trigger === 'schedule') stopScan(c.id);
    }
    if (statuses.has(c.id) || wanted !== has) update(c.id, () => {});
  }
}

let ticking = false;

/** Background scans: every opted-in, connected cluster whose scan is due. */
function startTicker() {
  if (ticking) return;
  ticking = true;
  setInterval(() => {
    const now = Date.now();
    for (const id of schedules.keys()) {
      const due = dueAt(id);
      if (due != null && now >= due && !scanning.has(id)) void runScan(id, 'schedule');
    }
  }, 5_000);
}

// -- Reads ------------------------------------------------------------------------

/** The strategy a stored report is shown with now (like the backend's `current_strategy`). */
function currentStrategy(clusterId: string, inputs: RunInputs): { id: string; auto: boolean } {
  const saved = savedStrategy();
  if (saved) return { id: saved, auto: false };
  if (inputs.strategyAuto) return { id: inputs.strategy, auto: true };
  const collection = demoCollection(getDb(clusterId));
  return resolveStrategy(null, inputs.source === 'prometheus' && collection.ownerMetrics);
}

function scanView(clusterId: string, stored: DemoRun): RecommendationScanView {
  const inputs = stored.inputs!;
  const report = storedReport(clusterId, stored)!;
  const current = currentStrategy(clusterId, inputs);
  const settings = effectiveSettings(current.id);
  const reevaluated = current.id !== inputs.strategy || !sameSettings(settings, inputs.settings);
  return {
    run: runView(clusterId, stored),
    report: reevaluated
      ? buildReport(clusterId, inputs, current.id, current.auto, settings)
      : { ...structuredClone(report), strategy_auto: current.auto },
    reevaluated,
    days_changed: settings.days !== inputs.settings.days,
  };
}

function latest(clusterId: string, runId: number | null): RecommendationLatest {
  const cluster = clusterDef(clusterId);
  const list = runsOf(clusterId);
  const last = [...list].reverse().find((r) => r.run.status === 'success' && r.inputs);
  const sourceChanged = !!last && last.sourceConfig !== sourceConfig(cluster);
  let picked: DemoRun | undefined;
  if (runId != null) {
    picked = list.find((r) => r.run.id === runId && r.run.status === 'success' && r.inputs);
    if (!picked) throw new Error(`scan ${runId} is no longer stored`);
  }
  const shown = picked ?? (sourceChanged ? undefined : last);
  const failure = [...list]
    .reverse()
    .find(
      (r) =>
        (r.run.status === 'failed' || r.run.status === 'interrupted') &&
        r.run.id > (last?.run.id ?? 0),
    );
  return {
    scan: shown ? scanView(clusterId, shown) : null,
    source_changed: sourceChanged,
    last_failure: failure ? structuredClone(failure.run) : null,
  };
}

function trend(clusterId: string, workload: WorkloadRef): RecommendationTrendPoint[] {
  return runsOf(clusterId)
    .filter((r) => r.run.status === 'success' && r.run.rows_kept && r.inputs)
    .flatMap((r) => {
      const inputs = r.inputs!;
      const rec = buildReport(
        clusterId,
        inputs,
        inputs.strategy,
        inputs.strategyAuto,
        inputs.settings,
        workload,
      ).workloads[0];
      if (!rec) return [];
      return [
        {
          run_id: r.run.id,
          at: r.run.started_at,
          verdict: rec.verdict,
          confidence: rec.confidence,
          monthly_delta: rec.monthly_delta,
          containers: rec.containers.map((c) => ({
            name: c.name,
            cpu_request: c.current.cpu_request,
            cpu_recommended: c.recommended.cpu_request,
            memory_request: c.current.memory_request,
            memory_recommended: c.recommended.memory_request,
            cpu_p95: c.usage?.cpu_p95 ?? null,
            memory_max: c.usage?.memory_max ?? null,
          })),
        },
      ];
    });
}

async function usageHistory(args: MockArgs): Promise<WorkloadUsageHistory> {
  const clusterId = String(args.clusterId);
  const workload = args.workload as WorkloadRef;
  const container = String(args.container);
  const pods = (args.pods as string[] | undefined) ?? [];
  validateHistoryRequest(workload, container, pods);
  if (!connected(clusterId))
    throw new Error(`cluster "${clusterDef(clusterId).name}" is not connected`);
  if ((await usageSource(clusterId)) !== 'prometheus') {
    const off = clusterDef(clusterId).prometheus?.mode === 'off';
    throw new Error(
      off ? 'Prometheus is turned off for this cluster' : 'no Prometheus was found on this cluster',
    );
  }
  const days = Math.min(30, Math.max(1, Number(args.days ?? 7) || 7));
  const endMs = alignedWindowEnd(Date.now());
  const span = days * 86_400;
  const step = autoStep(span);
  const start = Math.floor((endMs / 1000 - span) / step) * step * 1000;
  await sleep(350);
  const rec: WorkloadRecommendation | undefined = collect(clusterId, 'prometheus', {
    namespaces: [],
    workload,
  }).workloads[0];
  const usage = rec?.containers.find((c) => c.name === container)?.usage ?? null;
  const seed = `${clusterId}/${workload.namespace}/${workload.name}/${container}`;
  const cpu = usageSeries(
    `${seed}#cpu`,
    start,
    endMs,
    step,
    usage?.cpu_avg ?? usage?.cpu_p95 ?? 0,
    usage?.cpu_max ?? 0,
  );
  const memory = usageSeries(
    `${seed}#mem`,
    start,
    endMs,
    step,
    usage?.memory_avg ?? usage?.memory_max ?? 0,
    usage?.memory_max ?? 0,
  );
  return {
    start,
    end: endMs,
    step_secs: step,
    pod_filter: pods.length ? 'names' : 'pattern',
    cpu_avg: usage ? cpu.avg : [],
    cpu_peak: usage ? cpu.peak : [],
    memory_avg: usage ? memory.avg : [],
    memory_peak: usage ? memory.peak : [],
    warnings: [],
  };
}

function fleet(): ClusterRecommendationSummary[] {
  return clusters().map((c) => {
    const last = [...runsOf(c.id)].reverse().find((r) => r.run.status === 'success' && r.inputs);
    return {
      cluster_id: c.id,
      scheduled: schedules.has(c.id),
      source_changed: !!last && last.sourceConfig !== sourceConfig(c),
      run: last ? runView(c.id, last) : null,
    };
  });
}

/** Retention: runs older than `retention_days` go, except each cluster's latest. */
function applyRetention() {
  const days = Math.min(90, Math.max(1, settings()?.retention_days ?? 30));
  const before = Date.now() - days * DAY;
  for (const [id, list] of runs) {
    const latestId = [...list].reverse().find((r) => r.run.status === 'success')?.run.id;
    runs.set(
      id,
      list.filter((r) => r.run.started_at >= before || r.run.id === latestId),
    );
  }
}

provideRecommendationHistory({
  table: () => {
    ensureSeeded();
    const all = [...runs.values()].flat();
    // A run's rows are its workloads (the same fixture objects every time).
    const rows = all.reduce(
      (n, r) => n + (r.run.rows_kept && r.inputs ? workloadCount(getDb(r.run.cluster_id)) : 0),
      0,
    );
    return {
      rows,
      oldest_ts: all.length ? Math.min(...all.map((r) => r.run.started_at)) : null,
    };
  },
  clear: (clusterId) => {
    ensureSeeded();
    for (const id of clusterId ? [clusterId] : [...runs.keys()]) {
      runs.delete(id);
      const status = statuses.get(id);
      if (status) status.last_success_at = null;
    }
  },
});

// -- Wiring -----------------------------------------------------------------------

function wrapAfter(command: string, after: (args: MockArgs, result: unknown) => void) {
  const inner = handlers[command];
  if (!inner) return;
  register({
    [command]: async (args: MockArgs) => {
      const result = await inner(args);
      after(args, result);
      return result;
    },
  });
}

wrapAfter('settings_set', () => {
  applyRetention();
  syncSchedules();
});
wrapAfter('cluster_connect', () => {
  startTicker();
  syncSchedules();
});
wrapAfter('cluster_disconnect', (args) => {
  stopScan(String(args.id));
  syncSchedules();
});
wrapAfter('cluster_remove', (args) => {
  const id = String(args.id);
  stopScan(id);
  schedules.delete(id);
  runs.delete(id);
  statuses.delete(id);
  lastManual.delete(id);
});
{
  // A Prometheus configuration change makes the next scan due in two minutes.
  const inner = handlers.cluster_update;
  if (inner)
    register({
      cluster_update: async (args: MockArgs) => {
        const next = args.cluster as ClusterDef;
        const before = clusters().find((c) => c.id === next.id);
        const result = await inner(args);
        const schedule = schedules.get(next.id);
        if (before && schedule && sourceConfig(before) !== sourceConfig(next)) {
          schedule.dueOverride = Date.now() + FIRST_DELAY_MS;
          update(next.id, () => {});
        }
        return result;
      },
    });
}

register({
  // Like the backend: any id gets a status (idle when nothing is known).
  recommendations_status: ({ clusterId }: MockArgs) => structuredClone(statusOf(String(clusterId))),
  recommendations_scan: async ({ clusterId }: MockArgs) => {
    const id = String(clusterId);
    clusterDef(id);
    if (!connected(id)) throw new Error('connect to the cluster first');
    startTicker();
    if (scanning.has(id)) return structuredClone(statusOf(id));
    const now = Date.now();
    const available = (lastManual.get(id) ?? -Infinity) + MANUAL_COOLDOWN_MS;
    if (available > now)
      throw new Error(`wait ${Math.ceil((available - now) / 1000)} s before scanning again`);
    lastManual.set(id, now);
    const status = update(id, (s) => {
      queued(s, 'manual');
      s.manual_available_at = now + MANUAL_COOLDOWN_MS;
    });
    void runScan(id, 'manual');
    return status;
  },
  recommendations_latest: async ({ clusterId, runId }: MockArgs) => {
    await sleep(120);
    return latest(String(clusterId), runId == null ? null : Number(runId));
  },
  recommendations_runs: async ({ clusterId, limit }: MockArgs) => {
    await sleep(60);
    const n = Math.min(500, Math.max(1, Number(limit) || 500));
    return [...runsOf(String(clusterId))]
      .reverse()
      .slice(0, n)
      .map((r) => runView(String(clusterId), r));
  },
  recommendations_trend: async ({ clusterId, workload }: MockArgs) => {
    await sleep(80);
    return trend(String(clusterId), workload as WorkloadRef);
  },
  recommendations_usage_history: (args: MockArgs) => usageHistory(args),
  recommendations_fleet: async () => {
    await sleep(60);
    return fleet();
  },
  recommendations_export: async ({ clusterId, runId, workloads, format }: MockArgs) => {
    const id = String(clusterId);
    const l = latest(id, runId == null ? null : Number(runId));
    if (!l.scan)
      throw new Error(
        l.source_changed
          ? 'the last scan used another Prometheus configuration; scan again to export'
          : 'there is no scan to export yet',
      );
    await sleep(80);
    const selection = (workloads as WorkloadRef[] | undefined) ?? [];
    return (format as RecommendationExportFormat) === 'yaml'
      ? exportYaml(l.scan.report, selection)
      : exportJson(l.scan.report, clusterDef(id).name, l.scan.report.computed_at, selection);
  },
});
