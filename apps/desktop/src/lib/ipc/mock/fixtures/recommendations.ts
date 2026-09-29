import type {
  ClusterDef,
  ContainerRecommendation,
  CostPricing,
  PromPoint,
  RecommendationRunStatus,
  RecommendationSummary,
  ResourceTotals,
  RightsizingNote,
  RightsizingReport,
  RightsizingSettings,
  RightsizingSource,
  ScanTrigger,
  SummaryEntry,
  WorkloadRecommendation,
  WorkloadRef,
} from '@/types';
import { STRATEGIES, formatCpu, formatMemory } from './cost';
import { list, type ClusterDb } from './db';
import { DAY, HOUR, MIN, hashString } from './util';

/**
 * Demo recommendation scans: how each demo cluster's collection goes (the
 * backend pipeline's notes and flags), the scans seeded into its history,
 * and TS mirrors of the backend's summary, exports and usage history
 * ranges. Everything is a deterministic function of the fixture objects
 * and the time.
 */

const unit = (seed: string) => hashString(seed) / 4294967296;

/** Window ends are aligned to five minutes, like the backend's scans. */
export const alignedWindowEnd = (ms: number) => Math.floor(ms / 300_000) * 300_000;

// -- How a collection goes ----------------------------------------------------

/** One demo cluster's Prometheus collection (the backend pipeline's facts). */
export interface DemoCollection {
  /** kube-state-metrics owner series exist (else pods match by name). */
  ownerMetrics: boolean;
  /** HorizontalPodAutoscalers can be listed. */
  hpas: boolean;
  /** Namespaces whose batch was partial, and the refining queries that failed. */
  partialNamespaces: string[];
  failedQueries: string[];
  /** Namespaces that still failed as single batches. */
  failedNamespaces: string[];
  /** Namespaces the query budget did not reach. */
  leftOverNamespaces: string[];
  /** Batches split this often (the progress total grows by 16 × 2 each time). */
  splits: number;
}

const WORKLOAD_KEYS = [
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'cronjobs.batch',
];

/** Right-sizable workloads (a scan's rows). */
export function workloadCount(db: ClusterDb): number {
  return WORKLOAD_KEYS.reduce((n, key) => n + list(db, key).length, 0);
}

/** Namespaces with right-sizable workloads, sorted. */
export function workloadNamespaces(db: ClusterDb): string[] {
  const out = new Set<string>();
  for (const key of WORKLOAD_KEYS)
    for (const w of list(db, key)) out.add(w.metadata.namespace ?? '');
  return [...out].sort();
}

/**
 * prod-eu-west-1: complete with owner metrics, one partial namespace;
 * prod-us-east-1: no kube-state-metrics (pods matched by name), HPAs not
 * listable and one namespace over the query budget; dev-shared: one
 * namespace that failed even alone; everything else: a clean collection.
 */
export function demoCollection(db: ClusterDb): DemoCollection {
  const ns = workloadNamespaces(db);
  const prefer = (names: string[], fallback: number) =>
    names.find((n) => ns.includes(n)) ?? ns[fallback] ?? null;
  const some = (n: string | null) => (n ? [n] : []);
  const plain: DemoCollection = {
    ownerMetrics: true,
    hpas: true,
    partialNamespaces: [],
    failedQueries: [],
    failedNamespaces: [],
    leftOverNamespaces: [],
    splits: 0,
  };
  switch (db.id) {
    case 'c-prod-eu':
      return {
        ...plain,
        partialNamespaces: some(prefer(['search', 'catalog'], 0)),
        failedQueries: ['cpu_avg'],
        splits: 1,
      };
    case 'c-prod-us':
      return {
        ...plain,
        ownerMetrics: false,
        hpas: false,
        leftOverNamespaces: some(ns[ns.length - 1] ?? null),
        splits: 2,
      };
    case 'c-dev':
      return { ...plain, failedNamespaces: some(prefer(['identity'], 0)), splits: 1 };
    default:
      return plain;
  }
}

/** Namespaces without usage in a collection. */
export const noDataNamespaces = (c: DemoCollection) => [
  ...c.failedNamespaces,
  ...c.leftOverNamespaces,
];

/** The notes of a collection over the namespaces `scope`, in the backend's order. */
export function collectionNotes(
  c: DemoCollection,
  source: RightsizingSource,
  scope: Set<string>,
): RightsizingNote[] {
  const notes: RightsizingNote[] = [];
  const inScope = (list: string[]) => list.filter((n) => scope.has(n)).sort();
  if (!c.hpas) notes.push({ kind: 'hpa-unavailable', detail: null });
  if (source !== 'prometheus') {
    if (source === 'none') notes.push({ kind: 'no-usage', detail: null });
    return notes;
  }
  const failed = inScope(c.failedNamespaces);
  if (failed.length) notes.push({ kind: 'namespace-failed', detail: failed.join(', ') });
  const left = inScope(c.leftOverNamespaces);
  if (left.length) notes.push({ kind: 'query-budget-exceeded', detail: left.join(', ') });
  if (inScope(c.partialNamespaces).length)
    notes.push({ kind: 'partial-data', detail: c.failedQueries.join(', ') || null });
  if (!c.ownerMetrics) notes.push({ kind: 'ownership-unavailable', detail: null });
  return notes;
}

// -- Stored scans --------------------------------------------------------------

/** A scan seeded into a demo cluster's history. */
export interface SeedRun {
  startedAt: number;
  finishedAt: number;
  trigger: ScanTrigger;
  status: RecommendationRunStatus;
  error: string | null;
  source: RightsizingSource;
}

const TOO_MANY_SAMPLES = 'cpu_p95: query processing would load too many samples into memory';

/**
 * The seeded history (spec §15): prod-eu-west-1 30 days of scans (hourly
 * for 48 hours, then daily; one failed and one interrupted among them),
 * staging-gke half a day of metrics-server scans, dev-shared a failed last
 * scan after good ones, prod-us-east-1 three daily scans; kind and minikube
 * never scanned.
 */
export function seedRuns(clusterId: string, now: number): SeedRun[] {
  const out: SeedRun[] = [];
  const top = Math.floor(now / HOUR) * HOUR;
  // The run nearest to `ago` before now.
  const near = (ago: number) =>
    out.reduce<SeedRun | undefined>(
      (best, r) =>
        !best || Math.abs(r.startedAt - (now - ago)) < Math.abs(best.startedAt - (now - ago))
          ? r
          : best,
      undefined,
    );
  // At seven past every hour, the last one within the past hour or so.
  const hourly = (hours: number, source: RightsizingSource, took: number) => {
    for (let h = hours; h >= 1; h--) {
      const startedAt = top + 7 * MIN - h * HOUR;
      out.push({
        startedAt,
        finishedAt: startedAt + took,
        trigger: 'schedule',
        status: 'success',
        error: null,
        source,
      });
    }
  };
  const daily = (from: number, to: number, source: RightsizingSource, took: number) => {
    for (let d = to; d >= from; d--) {
      const day = Math.floor((now - d * DAY) / DAY) * DAY;
      const startedAt = day + 3 * HOUR + 7 * MIN;
      out.push({
        startedAt,
        finishedAt: startedAt + took,
        trigger: 'schedule',
        status: 'success',
        error: null,
        source,
      });
    }
  };
  switch (clusterId) {
    case 'c-prod-eu': {
      daily(3, 29, 'prometheus', 42_000);
      hourly(48, 'prometheus', 38_000);
      const failed = near(6 * DAY);
      if (failed) Object.assign(failed, { status: 'failed', error: TOO_MANY_SAMPLES });
      const stopped = near(30 * HOUR);
      if (stopped)
        Object.assign(stopped, {
          status: 'interrupted',
          error: 'stopped',
          finishedAt: stopped.startedAt + 9_000,
        });
      const manual = near(4 * HOUR);
      if (manual) manual.trigger = 'manual';
      break;
    }
    case 'c-staging':
      hourly(12, 'metrics-server', 2_500);
      break;
    case 'c-dev': {
      daily(1, 5, 'prometheus', 21_000);
      hourly(3, 'prometheus', 19_000);
      const last = out[out.length - 1];
      if (last) Object.assign(last, { status: 'failed', error: TOO_MANY_SAMPLES });
      break;
    }
    case 'c-prod-us':
      daily(1, 3, 'prometheus', 55_000);
      break;
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

// -- Summary (mirror of `rightsizing/summary.rs`) ---------------------------------

const RANK = { low: 0, medium: 1, high: 2 } as const;

/** `summary::risk_score`: OOM first, then usage ÷ request (a missing request counts 2). */
export function riskScore(rec: WorkloadRecommendation): number {
  const ratio = (used: number, request: number | null) =>
    request != null && request > 0 ? used / request : 2;
  return rec.containers.reduce((max, c) => {
    if (c.warnings.some((w) => w.code === 'oom-killed')) return Infinity;
    const u = c.usage;
    if (!u) return max;
    return Math.max(
      max,
      ratio(u.memory_max, c.current.memory_request),
      ratio(u.cpu_p95, c.current.cpu_request),
    );
  }, 0);
}

/** `summary::one_click_eligible`: high confidence, a change, no raised limit. */
export const oneClickEligible = (rec: WorkloadRecommendation) =>
  rec.confidence === 'high' &&
  rec.changed &&
  !rec.containers.some((c) => c.cpu_limit_raised || c.memory_limit_raised);

function add(
  totals: ResourceTotals,
  current: number | null,
  recommended: number | null,
  hasUsage: boolean,
  replicas: number,
): number {
  if (current == null) {
    totals.unset += 1;
    return 0;
  }
  if (!hasUsage) return 0;
  const next = recommended ?? current;
  totals.current += current * replicas;
  totals.recommended += next * replicas;
  totals.comparable += 1;
  return (next - current) * replicas;
}

const byName = (a: WorkloadRecommendation, b: WorkloadRecommendation) =>
  a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name);

/** `summary::summarize`. */
export function summarize(report: RightsizingReport): RecommendationSummary {
  const blankTotals = (): ResourceTotals => ({
    current: 0,
    recommended: 0,
    comparable: 0,
    unset: 0,
  });
  const s: RecommendationSummary = {
    workloads: 0,
    containers: 0,
    namespaces: 0,
    over: 0,
    under: 0,
    balanced: 0,
    no_data: 0,
    high: 0,
    medium: 0,
    low: 0,
    changed: 0,
    one_click: 0,
    cpu: blankTotals(),
    memory: blankTotals(),
    monthly_current: 0,
    monthly_savings: 0,
    monthly_increases: 0,
    currency: report.currency,
    top: [],
  };
  const namespaces = new Set<string>();
  const deltas: Array<[number, number]> = [];
  for (const w of report.workloads) {
    s.workloads += 1;
    namespaces.add(w.namespace);
    if (w.verdict === 'over') s.over += 1;
    else if (w.verdict === 'under') s.under += 1;
    else if (w.verdict === 'balanced') s.balanced += 1;
    else s.no_data += 1;
    s[w.confidence] += 1;
    if (w.changed) {
      s.changed += 1;
      if (w.monthly_delta < 0) s.monthly_savings -= w.monthly_delta;
      else s.monthly_increases += w.monthly_delta;
    }
    if (oneClickEligible(w)) s.one_click += 1;
    s.monthly_current += w.monthly_current;
    let cpu = 0;
    let memory = 0;
    for (const c of w.containers) {
      s.containers += 1;
      const has = c.usage != null;
      cpu += add(s.cpu, c.current.cpu_request, c.recommended.cpu_request, has, w.cost_replicas);
      memory += add(
        s.memory,
        c.current.memory_request,
        c.recommended.memory_request,
        has,
        w.cost_replicas,
      );
    }
    deltas.push([cpu, memory]);
  }
  s.namespaces = namespaces.size;
  const entry = (i: number): SummaryEntry => {
    const w = report.workloads[i]!;
    return {
      kind: w.kind,
      namespace: w.namespace,
      name: w.name,
      verdict: w.verdict,
      confidence: w.confidence,
      monthly_delta: w.monthly_delta,
      cpu_delta: deltas[i]![0],
      memory_delta: deltas[i]![1],
    };
  };
  const all = report.workloads.map((w, i) => ({ w, i }));
  const under = all
    .filter(({ w }) => w.verdict === 'under' && RANK[w.confidence] >= RANK.medium)
    .map(({ w, i }) => ({ w, i, risk: riskScore(w) }))
    .sort((a, b) => (b.risk === a.risk ? 0 : b.risk > a.risk ? 1 : -1) || byName(a.w, b.w));
  const over = all
    .filter(({ w }) => w.verdict === 'over' && w.confidence === 'high')
    .sort((a, b) => a.w.monthly_delta - b.w.monthly_delta || byName(a.w, b.w));
  s.top = [...under.slice(0, 5), ...over.slice(0, 5)].map(({ i }) => entry(i));
  return s;
}

// -- Exports (mirror of `rightsizing/export.rs`) --------------------------------

const selected = (report: RightsizingReport, selection: WorkloadRef[]) =>
  report.workloads.filter(
    (w) =>
      !selection.length ||
      selection.some((r) => r.kind === w.kind && r.namespace === w.namespace && r.name === w.name),
  );

/** `export_json`: the report data only, never connection metadata or notes. */
export function exportJson(
  report: RightsizingReport,
  clusterName: string,
  scannedAt: number,
  selection: WorkloadRef[],
): string {
  return JSON.stringify(
    {
      format: 'kubepit.recommendations/v1',
      cluster: clusterName,
      scanned_at: new Date(scannedAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      source: report.source,
      window_secs: report.window_secs,
      strategy: report.strategy,
      settings: report.settings,
      currency: report.currency,
      workloads: selected(report, selection),
    },
    null,
    2,
  );
}

/** `2`, `1.5`, `1.33`. */
const ratioText = (ratio: number) => ratio.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');

/** `strategy::limit_ratio`. */
function limitRatio(request: number | null, limit: number | null): number {
  const base = request ?? limit;
  return base != null && limit != null && base > 0 ? Math.max(1, limit / base) : 1;
}

function fragment(w: WorkloadRecommendation, c: ContainerRecommendation): string {
  let out =
    `# ${w.kind} ${w.namespace}/${w.name} · container ${c.name}\n` +
    '# Resource fragment, not a complete manifest. Values are rounded up.\n' +
    'resources:\n';
  const line = (key: string, value: string, comment: string | null = null) => {
    out += `    ${key}: "${value}"${comment ? `  # ${comment}` : ''}\n`;
  };
  const raised = (on: boolean, request: number | null, limit: number | null) =>
    on
      ? `raised with the request (limit ÷ request ×${ratioText(limitRatio(request, limit))})`
      : null;
  const next = c.recommended;
  if (next.cpu_request != null || next.memory_request != null) {
    out += '  requests:\n';
    if (next.cpu_request != null) line('cpu', formatCpu(next.cpu_request));
    if (next.memory_request != null) line('memory', formatMemory(next.memory_request));
  }
  if (next.cpu_limit != null || next.memory_limit != null) {
    out += '  limits:\n';
    if (next.cpu_limit != null)
      line(
        'cpu',
        formatCpu(next.cpu_limit),
        raised(c.cpu_limit_raised, c.current.cpu_request, c.current.cpu_limit),
      );
    if (next.memory_limit != null)
      line(
        'memory',
        formatMemory(next.memory_limit),
        raised(c.memory_limit_raised, c.current.memory_request, c.current.memory_limit),
      );
  }
  return out;
}

/** `export_yaml`: one YAML document per changed container. */
export function exportYaml(report: RightsizingReport, selection: WorkloadRef[]): string {
  const changed = (c: ContainerRecommendation) =>
    [c.cpu, c.memory, c.memory_limit, c.cpu_limit].some((x) => x !== 'unchanged');
  const fragments = selected(report, selection).flatMap((w) =>
    w.containers.filter(changed).map((c) => fragment(w, c)),
  );
  return fragments.length ? fragments.join('\n---\n') : '# No changes to export.\n';
}

// -- Source configuration and settings ---------------------------------------------

/** Like the backend's `source_config`: the Prometheus source and its access settings. */
export function sourceConfig(cluster: ClusterDef): string {
  const access = cluster.prometheus_access;
  return JSON.stringify({
    prometheus: cluster.prometheus ?? { mode: 'auto' },
    access: {
      tenant: access?.tenant ?? '',
      cluster_labels: Object.fromEntries(
        Object.entries(access?.cluster_labels ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
      auth: access?.auth ?? null,
      tls: access?.tls ?? null,
    },
  });
}

/** The defaults of a strategy (unknown ids: the first one's). */
export function strategyDefaults(id: string): RightsizingSettings {
  return (STRATEGIES.find((s) => s.id === id) ?? STRATEGIES[0]!).defaults;
}

/** `RightsizingSettings::normalized` (clamped like the backend). */
export function normalizedSettings(s: RightsizingSettings): RightsizingSettings {
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  const days = Math.round(clamp(s.days, 1, 30));
  return {
    ...s,
    days,
    min_hours: clamp(s.min_hours, 1, Math.min(720, days * 24)),
    min_coverage: clamp(s.min_coverage, 0.1, 1),
    throttle_threshold_percent: clamp(s.throttle_threshold_percent, 1, 50),
  };
}

export const sameSettings = (a: RightsizingSettings, b: RightsizingSettings) =>
  (Object.keys(a) as Array<keyof RightsizingSettings>).every((k) => a[k] === b[k]);

/** The report of a demo collection, like `compute_rightsizing` assembles it. */
export function assembleReport(parts: {
  source: RightsizingSource;
  windowDays: number;
  settings: RightsizingSettings;
  pricing: CostPricing;
  workloads: WorkloadRecommendation[];
  notes: RightsizingNote[];
  strategy: string;
  strategyAuto: boolean;
  computedAt: number;
  windowEnd: number;
}): RightsizingReport {
  return {
    source: parts.source,
    window_secs:
      parts.source === 'prometheus'
        ? parts.windowDays * 86_400
        : parts.source === 'metrics-server'
          ? 3600
          : 0,
    settings: parts.settings,
    currency: parts.pricing.currency,
    pricing: parts.pricing,
    workloads: parts.workloads,
    notes: parts.notes,
    strategy: parts.strategy,
    strategies: STRATEGIES,
    computed_at: parts.computedAt,
    strategy_auto: parts.strategyAuto,
    window_end: parts.windowEnd,
  };
}

// -- Usage history (range queries of the charts) -----------------------------------

const NICE_STEPS = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

/** `range::auto_step`: about 240 points. */
export function autoStep(rangeSecs: number): number {
  const raw = Math.max(15, Math.ceil(rangeSecs / 240));
  return NICE_STEPS.find((s) => s >= raw) ?? Math.ceil(raw / 86400) * 86400;
}

const dnsLabel = (v: string) => /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(v);
const dnsSubdomain = (v: string) => v.length <= 253 && v.split('.').every(dnsLabel);

/** `usage_history::history_queries`' checks, with the backend's messages. */
export function validateHistoryRequest(workload: WorkloadRef, container: string, pods: string[]) {
  if (!dnsLabel(workload.namespace)) throw new Error(`invalid namespace "${workload.namespace}"`);
  if (!dnsLabel(container)) throw new Error(`invalid container name "${container}"`);
  if (pods.length > 50) throw new Error('at most 50 pod names can be charted');
  const bad = pods.find((p) => !dnsSubdomain(p));
  if (bad !== undefined) throw new Error(`invalid pod name "${bad}"`);
}

/**
 * Average and peak series around `avg` / `peak`: a daily rhythm, noise
 * and a few gaps (a missing step stays missing), one point per step.
 */
export function usageSeries(
  seed: string,
  start: number,
  end: number,
  stepSecs: number,
  avg: number,
  peak: number,
): { avg: PromPoint[]; peak: PromPoint[] } {
  const outAvg: PromPoint[] = [];
  const outPeak: PromPoint[] = [];
  const step = stepSecs * 1000;
  const gapAt = start + (end - start) * (0.35 + unit(`${seed}#gap`) * 0.2);
  for (let t = start; t <= end; t += step) {
    // A scrape outage of a few steps, and the odd single missing step.
    if (t >= gapAt && t < gapAt + 3 * step) continue;
    if (unit(`${seed}#${t}#drop`) < 0.015) continue;
    const phase = ((t % DAY) / DAY) * 2 * Math.PI;
    const rhythm = 0.75 + 0.25 * Math.sin(phase - Math.PI / 2 - 0.9);
    const noise = 1 + (unit(`${seed}#${t}`) - 0.5) * 0.12;
    const a = Math.max(0, avg * rhythm * noise);
    const p = Math.max(a, peak * (0.7 + 0.3 * rhythm) * (1 + (unit(`${seed}#${t}#p`) - 0.5) * 0.2));
    outAvg.push([t, a]);
    outPeak.push([t, p]);
  }
  return { avg: outAvg, peak: outPeak };
}
