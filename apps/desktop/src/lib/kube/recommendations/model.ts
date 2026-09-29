import * as i18n from '@/i18n/core';
import type {
  ClusterDef,
  RecommendationLens,
  RecommendationRun,
  RecommendationScanStatus,
  RecommendationSummary,
  ResourceTotals,
  RightsizingConfidence,
  RightsizingReport,
  RightsizingSource,
  WorkloadRecommendation,
  WorkloadRef,
} from '@/types';
import { strategyLabel, type RightsizingFilter } from '../rightsizing/model';

/**
 * Recommendations view model (pure). The backend stores, re-evaluates and
 * summarizes scans; this ranks, groups and labels their rows for the view,
 * mirroring `rightsizing/summary.rs` where both compute the same thing
 * (risk score, totals) so the page and the stored summary agree.
 */

/** Byte-wise order, like Rust's `String::cmp` (deterministic across locales). */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Descending, with `NaN` never ahead and `+∞` equal to itself. */
const desc = (a: number, b: number) => (b > a ? 1 : b < a ? -1 : 0);

/** `kind/namespace/name`, the key of a row in `history.db` (`rec_rows.key`). */
export function workloadKey(r: Pick<WorkloadRef, 'kind' | 'namespace' | 'name'>): string {
  return `${r.kind}/${r.namespace}/${r.name}`;
}

/** Namespace, then name, like `summary.rs::by_name`. */
function byName(a: WorkloadRecommendation, b: WorkloadRecommendation): number {
  return cmp(a.namespace, b.namespace) || cmp(a.name, b.name);
}

// -- Lenses ------------------------------------------------------------------------

/** Every lens, in the backend's declaration order (spec §6.9). */
export const RECOMMENDATION_LENSES: readonly RecommendationLens[] = [
  'cpu-reduction',
  'memory-reduction',
  'increase',
  'request-unset',
  'missing-data',
  'needs-review',
  'limit-raised',
];

export function lensLabel(lens: RecommendationLens): string {
  switch (lens) {
    case 'cpu-reduction':
      return i18n.t('CPU reduction');
    case 'memory-reduction':
      return i18n.t('Memory reduction');
    case 'increase':
      return i18n.t('Increases');
    case 'request-unset':
      return i18n.t('Request not set');
    case 'missing-data':
      return i18n.t('Missing data');
    case 'needs-review':
      return i18n.t('Needs review');
    default:
      return i18n.t('Limit raised');
  }
}

/** Workloads per lens; every lens is present (0 when none). */
export function countLenses(
  list: readonly WorkloadRecommendation[],
): Record<RecommendationLens, number> {
  const counts = Object.fromEntries(RECOMMENDATION_LENSES.map((l) => [l, 0])) as Record<
    RecommendationLens,
    number
  >;
  for (const rec of list)
    for (const lens of rec.lenses ?? []) counts[lens] = (counts[lens] ?? 0) + 1;
  return counts;
}

/** Label of a verdict tab of the list (`filterRecommendations`). */
export function verdictFilterLabel(filter: RightsizingFilter): string {
  switch (filter) {
    case 'changed':
      return i18n.t('With changes');
    case 'over':
      return i18n.t('Over-provisioned');
    case 'under':
      return i18n.t('Under-provisioned');
    default:
      return i18n.t('All workloads');
  }
}

// -- Risk, sorting, spotlight ------------------------------------------------------------

/**
 * How urgently a workload needs more resources, like `summary.rs::risk_score`:
 * `+∞` when a container was OOM-killed, else the largest
 * `memory_max ÷ memory request` or `cpu_p95 ÷ cpu request` over the
 * containers with usage (a missing or zero request counts as 2); 0 without
 * usage.
 */
export function riskScore(rec: WorkloadRecommendation): number {
  const ratio = (used: number, request: number | null) =>
    request != null && request > 0 ? used / request : 2;
  let score = 0;
  for (const c of rec.containers) {
    if (c.warnings.some((w) => w.code === 'oom-killed')) return Infinity;
    const u = c.usage;
    if (!u) continue;
    const next = Math.max(
      ratio(u.memory_max, c.current.memory_request),
      ratio(u.cpu_p95, c.current.cpu_request),
    );
    if (next > score) score = next;
  }
  return score;
}

/**
 * Current − recommended requests × cost replicas over the containers that
 * have both (millicores or bytes; negative = the requests grow).
 */
export function requestReduction(rec: WorkloadRecommendation, resource: 'cpu' | 'memory'): number {
  let total = 0;
  for (const c of rec.containers) {
    const current = resource === 'cpu' ? c.current.cpu_request : c.current.memory_request;
    const next = resource === 'cpu' ? c.recommended.cpu_request : c.recommended.memory_request;
    if (current != null && next != null) total += (current - next) * rec.cost_replicas;
  }
  return total;
}

export type RecSort = 'priority' | 'delta' | 'cpu' | 'memory' | 'confidence' | 'name';

export const REC_SORTS: readonly RecSort[] = [
  'priority',
  'delta',
  'cpu',
  'memory',
  'confidence',
  'name',
];

export function sortLabel(sort: RecSort): string {
  switch (sort) {
    case 'priority':
      return i18n.t('Priority');
    case 'delta':
      return i18n.t('Monthly change');
    case 'cpu':
      return i18n.t('CPU reduction');
    case 'memory':
      return i18n.t('Memory reduction');
    case 'confidence':
      return i18n.t('Confidence');
    default:
      return i18n.t('Name');
  }
}

const CONFIDENCE_RANK: Record<RightsizingConfidence, number> = { high: 0, medium: 1, low: 2 };

/**
 * A sorted copy (the input is never mutated). `priority`: under-provisioned
 * first by risk (highest first), then the monthly delta (largest saving
 * first); `delta` by the monthly delta; `cpu` / `memory` by the request
 * reduction × cost replicas (largest first); `confidence` high first;
 * `name` by name. Ties always fall back to the workload key.
 */
export function sortRecommendations(
  list: readonly WorkloadRecommendation[],
  sort: RecSort,
): WorkloadRecommendation[] {
  const keyed = list.map((rec) => ({
    rec,
    key: workloadKey(rec),
    risk: sort === 'priority' && rec.verdict === 'under' ? riskScore(rec) : 0,
    reduction: sort === 'cpu' || sort === 'memory' ? requestReduction(rec, sort) : 0,
  }));
  type Keyed = (typeof keyed)[number];
  const order: (a: Keyed, b: Keyed) => number = (() => {
    switch (sort) {
      case 'priority':
        return (a, b) =>
          Number(b.rec.verdict === 'under') - Number(a.rec.verdict === 'under') ||
          desc(a.risk, b.risk) ||
          a.rec.monthly_delta - b.rec.monthly_delta;
      case 'delta':
        return (a, b) => a.rec.monthly_delta - b.rec.monthly_delta;
      case 'cpu':
      case 'memory':
        return (a, b) => desc(a.reduction, b.reduction);
      case 'confidence':
        return (a, b) => CONFIDENCE_RANK[a.rec.confidence] - CONFIDENCE_RANK[b.rec.confidence];
      default:
        return (a, b) => cmp(a.rec.name, b.rec.name);
    }
  })();
  return keyed.sort((a, b) => order(a, b) || cmp(a.key, b.key)).map((k) => k.rec);
}

/**
 * The review spotlight, like `summary.rs::summarize`'s `top` with `per`
 * entries each: under-provisioned workloads (confidence ≥ medium) by risk,
 * and high-confidence over-provisioned ones by saving; ties by namespace
 * and name.
 */
export function spotlight(
  list: readonly WorkloadRecommendation[],
  per = 3,
): { under: WorkloadRecommendation[]; over: WorkloadRecommendation[] } {
  const under = list
    .filter((r) => r.verdict === 'under' && r.confidence !== 'low')
    .map((rec) => ({ rec, risk: riskScore(rec) }))
    .sort((a, b) => desc(a.risk, b.risk) || byName(a.rec, b.rec))
    .slice(0, per)
    .map((x) => x.rec);
  const over = list
    .filter((r) => r.verdict === 'over' && r.confidence === 'high')
    .sort((a, b) => a.monthly_delta - b.monthly_delta || byName(a, b))
    .slice(0, per);
  return { under, over };
}

// -- Usage ranking and capacity ----------------------------------------------------------

export interface RankRow {
  /** `kind/namespace/name/container`. */
  key: string;
  rec: WorkloadRecommendation;
  container: string;
  /** Millicores or bytes. */
  value: number;
}

/**
 * One row per container with usage for `resource` / `stat` (average =
 * `cpu_avg` / `memory_avg`, peak = `cpu_max` / `memory_max`), highest first,
 * ties by key. Zeros stay; containers without the value are dropped and only
 * counted in `total`.
 */
export function rankUsage(
  list: readonly WorkloadRecommendation[],
  resource: 'cpu' | 'memory',
  stat: 'avg' | 'peak',
): { rows: RankRow[]; available: number; total: number } {
  const rows: RankRow[] = [];
  let total = 0;
  for (const rec of list) {
    for (const c of rec.containers) {
      total++;
      const u = c.usage;
      if (!u) continue;
      const value =
        resource === 'cpu'
          ? stat === 'avg'
            ? u.cpu_avg
            : u.cpu_max
          : stat === 'avg'
            ? u.memory_avg
            : u.memory_max;
      if (value == null || !Number.isFinite(value)) continue;
      rows.push({ key: `${workloadKey(rec)}/${c.name}`, rec, container: c.name, value });
    }
  }
  rows.sort((a, b) => desc(a.value, b.value) || cmp(a.key, b.key));
  return { rows, available: rows.length, total };
}

export interface NamespaceCapacity {
  namespace: string;
  /** Σ current requests × cost replicas of comparable containers. */
  current: number;
  /** Σ recommended requests × cost replicas of the same containers. */
  recommended: number;
  /** Containers with a current request and usage. */
  comparable: number;
  containers: number;
}

/**
 * Current vs. recommended requests per namespace (comparable containers
 * only, like the summary totals), the `top` largest by current requests;
 * namespaces without a comparable request are left out.
 */
export function capacityByNamespace(
  list: readonly WorkloadRecommendation[],
  resource: 'cpu' | 'memory',
  top = 5,
): NamespaceCapacity[] {
  const byNs = new Map<string, NamespaceCapacity>();
  for (const rec of list) {
    let entry = byNs.get(rec.namespace);
    if (!entry) {
      entry = {
        namespace: rec.namespace,
        current: 0,
        recommended: 0,
        comparable: 0,
        containers: 0,
      };
      byNs.set(rec.namespace, entry);
    }
    for (const c of rec.containers) {
      entry.containers++;
      const current = resource === 'cpu' ? c.current.cpu_request : c.current.memory_request;
      if (current == null || !c.usage) continue;
      const next =
        (resource === 'cpu' ? c.recommended.cpu_request : c.recommended.memory_request) ?? current;
      entry.current += current * rec.cost_replicas;
      entry.recommended += next * rec.cost_replicas;
      entry.comparable++;
    }
  }
  return [...byNs.values()]
    .filter((e) => e.current > 0)
    .sort((a, b) => desc(a.current, b.current) || cmp(a.namespace, b.namespace))
    .slice(0, top);
}

/** A run's summary without the currency and the spotlight, for any subset of its rows. */
export type OptimizationTotals = Omit<RecommendationSummary, 'currency' | 'top'>;

const emptyTotals = (): ResourceTotals => ({ current: 0, recommended: 0, comparable: 0, unset: 0 });

/** Adds one container's request, like `summary.rs::add`. */
function addRequest(
  totals: ResourceTotals,
  current: number | null,
  recommended: number | null,
  hasUsage: boolean,
  replicas: number,
) {
  if (current == null) {
    totals.unset++;
    return;
  }
  if (!hasUsage) return;
  totals.current += current * replicas;
  totals.recommended += (recommended ?? current) * replicas;
  totals.comparable++;
}

/**
 * The totals of `summary.rs::summarize` over `list` (for example the rows of
 * the namespaces in scope): counts, one-click count, CPU and memory requests
 * × cost replicas over comparable containers, monthly amounts.
 */
export function optimizationTotals(list: readonly WorkloadRecommendation[]): OptimizationTotals {
  const t: OptimizationTotals = {
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
    cpu: emptyTotals(),
    memory: emptyTotals(),
    monthly_current: 0,
    monthly_savings: 0,
    monthly_increases: 0,
  };
  const namespaces = new Set<string>();
  for (const w of list) {
    t.workloads++;
    namespaces.add(w.namespace);
    if (w.verdict === 'over') t.over++;
    else if (w.verdict === 'under') t.under++;
    else if (w.verdict === 'balanced') t.balanced++;
    else t.no_data++;
    t[w.confidence]++;
    if (w.changed) {
      t.changed++;
      if (w.monthly_delta < 0) t.monthly_savings -= w.monthly_delta;
      else t.monthly_increases += w.monthly_delta;
    }
    if (oneClickEligible(w)) t.one_click++;
    t.monthly_current += w.monthly_current;
    for (const c of w.containers) {
      t.containers++;
      const hasUsage = c.usage != null;
      addRequest(
        t.cpu,
        c.current.cpu_request,
        c.recommended.cpu_request,
        hasUsage,
        w.cost_replicas,
      );
      addRequest(
        t.memory,
        c.current.memory_request,
        c.recommended.memory_request,
        hasUsage,
        w.cost_replicas,
      );
    }
  }
  t.namespaces = namespaces.size;
  return t;
}

// -- Apply ------------------------------------------------------------------------

/**
 * High confidence, a change and no limit raised with its request: the
 * backend half of the one-click rule (`summary.rs::one_click_eligible`).
 */
export function oneClickEligible(rec: WorkloadRecommendation): boolean {
  return (
    rec.confidence === 'high' &&
    rec.changed &&
    !rec.containers.some((c) => c.cpu_limit_raised || c.memory_limit_raised)
  );
}

/**
 * How a recommendation can be applied (spec §8):
 * - `one-click`: a silent dry run, then apply (eligible rows on writable,
 *   non-production clusters);
 * - `review`: the dialog with the dry-run diff (typed confirmation on
 *   production);
 * - `read-only`: the cluster is read-only; the review still shows the dry
 *   run, but applying is refused;
 * - `none`: nothing changes.
 *
 * The caller checks the RBAC gate.
 */
export type ApplyMode = 'one-click' | 'review' | 'read-only' | 'none';

export function applyMode(
  rec: WorkloadRecommendation,
  cluster: Pick<ClusterDef, 'read_only' | 'environment'>,
): ApplyMode {
  if (!rec.changed) return 'none';
  if (cluster.read_only) return 'read-only';
  if (oneClickEligible(rec) && cluster.environment !== 'production') return 'one-click';
  return 'review';
}

// -- Scans ------------------------------------------------------------------------

/** When a run's results were collected. */
export function runTime(run: RecommendationRun): number {
  return run.finished_at ?? run.started_at;
}

/** "Workload history (automatic)". */
export function strategyText(report: RightsizingReport): string {
  const info = report.strategies.find((s) => s.id === report.strategy) ?? {
    id: report.strategy,
    name: report.strategy,
  };
  const label = strategyLabel(info);
  return report.strategy_auto ? i18n.t('{strategy} (automatic)', { strategy: label }) : label;
}

/**
 * Whole seconds until "Scan now" is allowed again (0 = now). `lastTick` is
 * the clock a component last rendered with; the wall clock wins when it is
 * later, so a stale tick never keeps the button disabled.
 */
export function manualScanWait(
  availableAt: number | null | undefined,
  lastTick: number,
  now = Date.now(),
): number {
  if (availableAt == null || availableAt <= now) return 0;
  return Math.max(0, Math.ceil((availableAt - Math.max(lastTick, now)) / 1000));
}

/** "Prometheus · 7 days" / "metrics-server · last hour". */
export function scanSourceLabel(source: RightsizingSource, days: number): string {
  if (source === 'prometheus')
    return i18n.plural('Prometheus · {count} day', 'Prometheus · {count} days', days);
  if (source === 'metrics-server') return i18n.t('metrics-server · last hour');
  return i18n.t('No usage source');
}

/**
 * A scan error: the backend's codes translated, anything else (a message
 * from Prometheus or the cluster) verbatim.
 */
export function runErrorText(error: string | null): string {
  switch (error) {
    case 'app-restarted':
      return i18n.t('Kubepit closed while the scan was running.');
    case 'stopped':
      return i18n.t('The scan was stopped before it finished.');
    case 'no-usage-source':
      return i18n.t('Neither Prometheus nor metrics-server returned usage.');
    case 'timed-out':
      return i18n.t('The scan took longer than 20 minutes and was stopped.');
    case 'cluster-label-mismatch':
      return i18n.t(
        'The shared Prometheus answered with data of another cluster: the cluster label does not match.',
      );
    case 'cluster-label-unverified':
      return i18n.t(
        'The shared Prometheus could not show that any namespace belongs to this cluster.',
      );
    default:
      return error ?? '';
  }
}

/** One line for a scan status. */
export function scanStateText(status: RecommendationScanStatus): string {
  switch (status.state) {
    case 'queued':
      return i18n.t('Waiting for a scan slot…');
    case 'running':
      return status.progress && status.progress.total > 0
        ? i18n.t('Scanning: {completed}/{total} queries', {
            completed: i18n.number(status.progress.completed),
            total: i18n.number(status.progress.total),
          })
        : i18n.t('Scanning…');
    case 'success':
      return i18n.t('The last scan succeeded.');
    case 'failed':
      return status.error
        ? i18n.t('The last scan failed: {error}', { error: runErrorText(status.error) })
        : i18n.t('The last scan failed.');
    case 'interrupted':
      return i18n.t('The last scan was interrupted: {error}', {
        error: runErrorText(status.error ?? 'stopped'),
      });
    default:
      return i18n.t('No scan is running.');
  }
}

/** A scan is queued or running. */
export function isScanning(status: RecommendationScanStatus | null | undefined): boolean {
  return status?.state === 'queued' || status?.state === 'running';
}

/**
 * Stored results are stale when the cluster is disconnected or the scan is
 * older than twice the scan interval.
 */
export function scanStale(
  at: number,
  connected: boolean,
  intervalMinutes: number,
  now: number,
): boolean {
  return !connected || now - at > 2 * intervalMinutes * 60_000;
}

/** The scan intervals offered (minutes; the backend accepts 15–1440). */
export const SCAN_INTERVALS: readonly number[] = [15, 30, 60, 180, 360, 720, 1440];

/** "Every 15 minutes" / "Every hour" / "Every 6 hours". */
export function intervalLabel(minutes: number): string {
  if (minutes === 60) return i18n.t('Every hour');
  if (minutes % 60 === 0)
    return i18n.plural('Every {count} hour', 'Every {count} hours', minutes / 60);
  return i18n.plural('Every {count} minute', 'Every {count} minutes', minutes);
}
