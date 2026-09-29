import * as i18n from '@/i18n/core';
import { lensLabel } from '@/lib/kube/recommendations/model';
import { warningText } from '@/lib/kube/rightsizing/model';
import type { WorkloadRecommendation } from '@/types';

/**
 * Pure helpers of the Recommendations summary, capacity overview and
 * review spotlight (the view models the sections share live in
 * `lib/kube/recommendations/model.ts`).
 */

// -- Now → After ------------------------------------------------------------------

export type ChangeDirection = 'decrease' | 'increase' | 'none';

export interface TotalsChange {
  now: number;
  after: number;
  /** after − now (negative = the total shrinks). */
  delta: number;
  /** delta ÷ now; null when there is nothing now. */
  ratio: number | null;
  direction: ChangeDirection;
}

/**
 * The difference between two totals, with a tolerance for the float noise of
 * sums over fractional replicas (a CronJob's duty cycle).
 */
export function totalsChange(now: number, after: number): TotalsChange {
  const raw = after - now;
  const delta = Math.abs(raw) <= 1e-9 * Math.max(1, Math.abs(now)) ? 0 : raw;
  return {
    now,
    after,
    delta,
    ratio: now > 0 ? delta / now : null,
    direction: delta < 0 ? 'decrease' : delta > 0 ? 'increase' : 'none',
  };
}

/** "−51 %", "+8 %", "−0.4 %" (one decimal below 10 %). */
export function signedPercent(ratio: number): string {
  const abs = Math.abs(ratio);
  return i18n.number(ratio, {
    style: 'percent',
    signDisplay: 'exceptZero',
    maximumFractionDigits: abs > 0 && abs < 0.1 ? 1 : 0,
  });
}

/** Width of a bar in percent of `max`; a non-zero value stays visible. */
export function barPercent(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.min(100, Math.max(1, (value / max) * 100));
}

/**
 * Why the capacity overview has no bars: nothing in scope, no usage yet, or
 * no request to compare with.
 */
export function capacityEmptyText(list: readonly WorkloadRecommendation[]): string {
  if (!list.length) return i18n.t('No workloads in the namespaces in scope.');
  if (!list.some((r) => r.containers.some((c) => c.usage)))
    return i18n.t('Namespace comparisons appear after the first scan.');
  return i18n.t('No container in scope has a request to compare.');
}

// -- Spotlight ------------------------------------------------------------------------

export interface SpotlightReason {
  tone: 'critical' | 'warning';
  text: string;
  /** The longer explanation, for a tooltip. */
  title?: string;
}

/**
 * Why an under-provisioned workload is in the spotlight: an OOM kill, else
 * the largest usage ÷ request over its containers (memory peak, CPU p95)
 * when usage exceeds a request, else an unset request; null otherwise.
 */
export function spotlightReason(rec: WorkloadRecommendation): SpotlightReason | null {
  let ratio = 0;
  let unset = false;
  for (const c of rec.containers) {
    const oom = c.warnings.find((w) => w.code === 'oom-killed');
    if (oom) return { tone: 'critical', text: i18n.t('OOM-killed'), title: warningText(oom) };
    const u = c.usage;
    if (!u) continue;
    const pairs: Array<[number, number | null]> = [
      [u.memory_max, c.current.memory_request],
      [u.cpu_p95, c.current.cpu_request],
    ];
    for (const [used, request] of pairs) {
      if (request != null && request > 0) ratio = Math.max(ratio, used / request);
      else unset = true;
    }
  }
  if (ratio > 1)
    return {
      tone: 'warning',
      text: i18n.t('Usage peaks at {ratio}× the request', {
        ratio: i18n.number(ratio, { maximumFractionDigits: ratio < 10 ? 1 : 0 }),
      }),
    };
  if (unset) return { tone: 'warning', text: lensLabel('request-unset') };
  return null;
}

/**
 * Changed over- or under-provisioned workloads the spotlight leaves out for
 * their confidence (under: low; over: below high).
 */
export function lowConfidenceChanges(list: readonly WorkloadRecommendation[]): number {
  return list.filter(
    (r) =>
      r.changed &&
      ((r.verdict === 'under' && r.confidence === 'low') ||
        (r.verdict === 'over' && r.confidence !== 'high')),
  ).length;
}
