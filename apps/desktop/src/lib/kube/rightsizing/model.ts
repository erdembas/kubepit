import * as i18n from '@/i18n/core';
import { formatBytes, formatCpu } from '@/lib/format';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import type {
  ContainerRecommendation,
  ContainerResourceChange,
  Gvk,
  RecommendationWarning,
  ResourceChange,
  RightsizingConfidence,
  RightsizingReport,
  RightsizingSettings,
  RightsizingSource,
  RightsizingStrategyInfo,
  RightsizingVerdict,
  WorkloadRecommendation,
} from '@/types';

/**
 * Right-sizing view model (pure). The backend computes the numbers
 * (percentiles, headroom, rounding, never below the observed peak); this
 * turns them into labels, filters, totals, the change list sent to
 * `rightsizing_apply` and the thresholds the Health engine uses.
 */

export const MiB = 1024 ** 2;

/** Defaults of the backend (`RightsizingSettings::default`). */
export const DEFAULT_RIGHTSIZING: RightsizingSettings = {
  cpu_headroom_percent: 15,
  memory_headroom_percent: 20,
  memory_limit_headroom_percent: 40,
  min_cpu_millicores: 10,
  min_memory_bytes: 32 * MiB,
  days: 7,
  min_hours: 24,
  min_coverage: 0.9,
  throttle_threshold_percent: 5,
};

/**
 * Kinds the recommendations cover (and `rightsizing_apply` patches). A
 * CronJob is patched at its job template (`spec.jobTemplate.spec.template`),
 * so only the Jobs it starts afterwards get the new values.
 */
export const RIGHTSIZABLE_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob'] as const;

export type RightsizableKind = (typeof RIGHTSIZABLE_KINDS)[number];

export function isRightsizable(kind: string): kind is RightsizableKind {
  return (RIGHTSIZABLE_KINDS as readonly string[]).includes(kind);
}

const WORKLOAD_GVK: Record<RightsizableKind, Gvk> = {
  Deployment: toGvk(BUILTIN.Deployment),
  StatefulSet: toGvk(BUILTIN.StatefulSet),
  DaemonSet: toGvk(BUILTIN.DaemonSet),
  CronJob: toGvk(BUILTIN.CronJob),
};

/** The API resource of a recommended workload (`apps/v1`, or `batch/v1` for CronJobs). */
export function workloadGvk(kind: string): Gvk {
  if (isRightsizable(kind)) return WORKLOAD_GVK[kind];
  return { group: 'apps', version: 'v1', kind, plural: `${kind.toLowerCase()}s`, namespaced: true };
}

export function cpuText(millicores: number | null | undefined): string {
  return millicores == null ? '—' : formatCpu(millicores);
}

export function memoryText(bytes: number | null | undefined): string {
  return bytes == null ? '—' : formatBytes(bytes);
}

export function confidenceLabel(c: RightsizingConfidence): string {
  if (c === 'high') return i18n.t('High confidence');
  if (c === 'medium') return i18n.t('Medium confidence');
  return i18n.t('Low confidence');
}

export function verdictLabel(v: RightsizingVerdict): string {
  switch (v) {
    case 'over':
      return i18n.t('Over-provisioned');
    case 'under':
      return i18n.t('Under-provisioned');
    case 'balanced':
      return i18n.t('Well sized');
    default:
      return i18n.t('No usage data');
  }
}

export function sourceLabel(source: RightsizingSource, days: number): string {
  if (source === 'prometheus')
    return i18n.plural('Prometheus, last {count} day', 'Prometheus, last {count} days', days);
  if (source === 'metrics-server') return i18n.t('metrics-server, last hour');
  return i18n.t('No usage history');
}

/** "3 days" / "5 hours" / "40 minutes" of history. */
export function coverageLabel(hours: number): string {
  if (hours >= 48) return i18n.plural('{count} day', '{count} days', Math.floor(hours / 24));
  if (hours >= 1) return i18n.plural('{count} hour', '{count} hours', Math.floor(hours));
  return i18n.plural('{count} minute', '{count} minutes', Math.max(1, Math.round(hours * 60)));
}

export function isChanged(change: ResourceChange): boolean {
  return change !== 'unchanged';
}

export function containerChanged(c: ContainerRecommendation): boolean {
  return [c.cpu, c.memory, c.memory_limit, c.cpu_limit].some(isChanged);
}

/** Memory limit changes the user may leave out (not forced by a larger request). */
export function hasOptionalLimitChanges(rec: WorkloadRecommendation): boolean {
  return rec.containers.some((c) => isChanged(c.memory_limit) && !c.memory_limit_raised);
}

/**
 * The values `rightsizing_apply` should write: only changed ones, per
 * container. `includeLimits: false` leaves optional memory limit changes
 * out; limits raised because a new request exceeds them are always sent.
 */
export function changesOf(
  rec: WorkloadRecommendation,
  { includeLimits = true }: { includeLimits?: boolean } = {},
): ContainerResourceChange[] {
  const out: ContainerResourceChange[] = [];
  for (const c of rec.containers) {
    const pick = (change: ResourceChange, value: number | null) =>
      isChanged(change) && value != null ? value : null;
    const change: ContainerResourceChange = {
      container: c.name,
      cpu_request: pick(c.cpu, c.recommended.cpu_request),
      cpu_limit: pick(c.cpu_limit, c.recommended.cpu_limit),
      memory_request: pick(c.memory, c.recommended.memory_request),
      memory_limit:
        includeLimits || c.memory_limit_raised
          ? pick(c.memory_limit, c.recommended.memory_limit)
          : null,
    };
    if (
      change.cpu_request != null ||
      change.cpu_limit != null ||
      change.memory_request != null ||
      change.memory_limit != null
    )
      out.push(change);
  }
  return out;
}

/** Limit ÷ request ratio kept by a proportional raise, e.g. "×2". */
export function limitRatio(request: number | null, limit: number | null): string | null {
  if (request == null || limit == null || request <= 0) return null;
  return `×${i18n.number(limit / request, { maximumFractionDigits: 2 })}`;
}

/** Translated caveat; codes of newer strategies fall back to their detail. */
export function warningText(w: RecommendationWarning): string {
  switch (w.code) {
    case 'no-usage':
      return i18n.t('No usage history for this container; nothing is recommended.');
    case 'short-history':
      return i18n.t('Less than three days of history; the numbers may miss weekly peaks.');
    case 'metrics-server-only':
      return i18n.t(
        'Only the last hour of metrics-server samples; install Prometheus for days of history.',
      );
    case 'memory-near-limit':
      return i18n.t('Memory peaks close to the current limit; the container risks OOM kills.');
    case 'cpu-bursts':
      return i18n.t(
        'CPU bursts far above the p95; expect throttling at the peaks if a CPU limit is set.',
      );
    case 'cpu-limit-raised':
      return i18n.t(
        'The CPU limit rises with the request, keeping the current limit-to-request ratio.',
      );
    case 'memory-limit-raised':
      return i18n.t(
        'The memory limit rises with the request, keeping the current limit-to-request ratio.',
      );
    case 'memory-limit-added':
      return i18n.t(
        'No memory limit yet; one is proposed at the peak plus headroom so a leak cannot take down the node.',
      );
    // Flags of the shared evidence step; details are data (hours, %, names).
    case 'identity-unclear':
      return i18n.t(
        'A pod name belonged to more than one workload; its usage is left out and this workload may be mixed up with another.',
      );
    case 'insufficient-history': {
      const hours = Number(w.detail ?? 0);
      return i18n.plural(
        'Only {count} hour of history, below the minimum; the numbers may miss peaks.',
        'Only {count} hours of history, below the minimum; the numbers may miss peaks.',
        Number.isFinite(hours) ? hours : 0,
      );
    }
    case 'low-coverage':
      return i18n.t(
        'Usage samples cover only {coverage} of the time the pods ran; gaps may hide peaks.',
        { coverage: w.detail ?? '' },
      );
    case 'partial-data':
      return i18n.t(
        'Part of the usage queries failed or returned warnings; the numbers may be incomplete.',
      );
    case 'hpa-target':
      return i18n.t(
        'The HorizontalPodAutoscaler {name} scales this workload; changing its requests changes how it scales.',
        { name: w.detail ?? '' },
      );
    case 'hpa-utilization':
      return i18n.t(
        'The autoscaler targets {targets} of the request; a new request moves the point where it scales.',
        { targets: w.detail ?? '' },
      );
    case 'oom-killed':
      return i18n.t(
        'A pod was OOM-killed within the window; the real memory peak is likely above what was measured.',
      );
    case 'cpu-throttled':
      return i18n.t('CPU was throttled in {ratio} of CFS periods; raise or remove the CPU limit.', {
        ratio: w.detail ?? '',
      });
    case 'identity-by-name':
      return i18n.t(
        'Pods were tied to this workload by name (no kube-state-metrics owners); a similarly named workload may be mixed in.',
      );
    default:
      return w.detail ?? w.code;
  }
}

/** Display name of a strategy (product names stay as they are). */
export function strategyLabel(info: Pick<RightsizingStrategyInfo, 'id' | 'name'>): string {
  if (info.id === 'percentile-headroom') return i18n.t('Percentile + headroom');
  if (info.id === 'workload-history') return i18n.t('Workload history');
  return info.name;
}

export type RightsizingFilter = 'changed' | 'over' | 'under' | 'all';

export function filterRecommendations(
  list: readonly WorkloadRecommendation[],
  filter: RightsizingFilter,
  namespaces: readonly string[],
  query: string,
): WorkloadRecommendation[] {
  const q = query.trim().toLowerCase();
  return list.filter((r) => {
    if (namespaces.length && !namespaces.includes(r.namespace)) return false;
    if (filter === 'changed' && !r.changed) return false;
    if (filter === 'over' && r.verdict !== 'over') return false;
    if (filter === 'under' && r.verdict !== 'under') return false;
    if (!q) return true;
    return `${r.kind} ${r.namespace}/${r.name} ${r.containers.map((c) => c.name).join(' ')}`
      .toLowerCase()
      .includes(q);
  });
}

export interface RightsizingTotals {
  workloads: number;
  changed: number;
  over: number;
  under: number;
  /** Sum of negative deltas (a positive number). */
  savings: number;
  /** Sum of positive deltas. */
  increases: number;
}

export function rightsizingTotals(list: readonly WorkloadRecommendation[]): RightsizingTotals {
  const t: RightsizingTotals = {
    workloads: list.length,
    changed: 0,
    over: 0,
    under: 0,
    savings: 0,
    increases: 0,
  };
  for (const r of list) {
    if (r.changed) t.changed++;
    if (r.verdict === 'over') t.over++;
    if (r.verdict === 'under') t.under++;
    if (!r.changed) continue;
    if (r.monthly_delta < 0) t.savings -= r.monthly_delta;
    else t.increases += r.monthly_delta;
  }
  return t;
}

/** Days of history the report covers. */
export function reportDays(report: RightsizingReport): number {
  return Math.max(1, Math.round(report.window_secs / 86_400));
}

// -- Health thresholds -----------------------------------------------------------

/** Per-replica request drop that makes over-provisioning worth a finding. */
const OVER_CPU_MILLICORES = 250;
const OVER_MEMORY_BYTES = 512 * MiB;

/**
 * Whether a recommendation deserves a Health finding. Only large, confident
 * deltas: over-provisioned needs high confidence, requests shrinking by at
 * least half and 250m CPU or 512 MiB in one container; under-provisioned
 * needs medium confidence and memory 25 % above its request, memory at
 * 90 % of its limit or CPU p95 at twice its request.
 */
export function healthVerdict(rec: WorkloadRecommendation): 'over' | 'under' | null {
  if (!rec.changed) return null;
  if (rec.verdict === 'under' && rec.confidence !== 'low') {
    const hot = rec.containers.some((c) => {
      const u = c.usage;
      if (!u) return false;
      const { memory_request: mr, memory_limit: ml, cpu_request: cr } = c.current;
      return (
        (mr != null && u.memory_max >= mr * 1.25) ||
        (ml != null && u.memory_max >= ml * 0.9) ||
        (cr != null && u.cpu_p95 >= cr * 2 && u.cpu_p95 - cr >= 200)
      );
    });
    return hot ? 'under' : null;
  }
  if (rec.verdict === 'over' && rec.confidence === 'high') {
    if (rec.monthly_current <= 0 || -rec.monthly_delta < rec.monthly_current * 0.5) return null;
    const big = rec.containers.some(
      (c) =>
        (c.current.cpu_request ?? 0) - (c.recommended.cpu_request ?? 0) >= OVER_CPU_MILLICORES ||
        (c.current.memory_request ?? 0) - (c.recommended.memory_request ?? 0) >= OVER_MEMORY_BYTES,
    );
    return big ? 'over' : null;
  }
  return null;
}
