import type { KubeObject } from '@/types';
import {
  emptyResultCounts,
  addResultCounts,
  reportResultCounts,
  reportResults,
  reportScope,
  resultRank,
  updatedAt,
  type PolicyResult,
  type PolicyResultValue,
  type ReportScope,
  type ResultCounts,
} from './model';
import type { Severity } from '../trivy/model';

/**
 * Aggregations behind the Policy reports tab: totals by result, failing
 * policies grouped by name with the objects they flagged, and one row per
 * report. Pure and deterministic.
 */

export interface PolicyTotals extends ResultCounts {
  reports: number;
}

export function policyTotals(reports: readonly KubeObject[]): PolicyTotals {
  let counts = emptyResultCounts();
  for (const r of reports) counts = addResultCounts(counts, reportResultCounts(r));
  return { ...counts, reports: reports.length };
}

export interface PolicyGroupResult {
  scope: ReportScope | null;
  report: KubeObject;
  result: PolicyResult;
}

export interface PolicyGroup {
  policy: string;
  /** Worst severity the failing results carry; null when none sets one. */
  severity: Severity | null;
  /** Result counts of the grouped (failing) results. */
  counts: ResultCounts;
  results: PolicyGroupResult[];
}

/** Failing, erroring and warning results grouped by policy name, worst first. */
export function policyGroups(reports: readonly KubeObject[]): PolicyGroup[] {
  const groups = new Map<string, PolicyGroup & { seen: Set<string> }>();
  for (const report of reports) {
    const scope = reportScope(report);
    for (const result of reportResults(report)) {
      if (result.result === 'pass' || result.result === 'skip') continue;
      const key = result.policy;
      let g = groups.get(key);
      if (!g) {
        g = {
          policy: result.policy,
          severity: null,
          counts: emptyResultCounts(),
          results: [],
          seen: new Set(),
        };
        groups.set(key, g);
      }
      const target = `${report.metadata.uid}|${result.rule}`;
      if (g.seen.has(target)) continue;
      g.seen.add(target);
      g.counts[result.result]++;
      if (result.severity && result.severity !== 'UNKNOWN') {
        const worst = g.severity ?? 'UNKNOWN';
        if (worst === 'UNKNOWN' || rank(result.severity) < rank(worst)) g.severity = result.severity;
      }
      g.results.push({ scope, report, result });
    }
  }
  return [...groups.values()]
    .map(({ seen: _seen, ...g }) => g)
    .sort(
      (a, b) =>
        worstRank(a) - worstRank(b) ||
        b.results.length - a.results.length ||
        a.policy.localeCompare(b.policy),
    );
}

function rank(s: Severity): number {
  return ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'].indexOf(s);
}

function worstRank(g: Pick<PolicyGroup, 'counts'>): number {
  let best = 99;
  if (g.counts.fail) best = Math.min(best, 0);
  if (g.counts.error) best = Math.min(best, 1);
  if (g.counts.warn) best = Math.min(best, 2);
  return best === 99 ? 3 : best;
}

export interface ReportRow {
  report: KubeObject;
  scope: ReportScope | null;
  counts: ResultCounts;
  updated: string;
}

export function matchesReport(row: ReportRow, q: string): boolean {
  const scope = row.scope;
  return [
    scope?.kind ?? '',
    scope?.name ?? '',
    scope?.namespace ?? '',
    row.report.metadata.name,
    row.report.metadata.namespace ?? '',
  ]
    .join(' ')
    .toLowerCase()
    .includes(q);
}

/** One row per report, worst first. */
export function reportRows(
  reports: readonly KubeObject[],
  query = '',
  limit = 400,
): { rows: ReportRow[]; total: number } {
  const q = query.trim().toLowerCase();
  const rows = reports.map<ReportRow>((report) => ({
    report,
    scope: reportScope(report),
    counts: reportResultCounts(report),
    updated: updatedAt(report),
  }));
  const filtered = q ? rows.filter((r) => matchesReport(r, q)) : rows;
  const worstOf = (c: ResultCounts): PolicyResultValue =>
    c.fail ? 'fail' : c.error ? 'error' : c.warn ? 'warn' : 'pass';
  filtered.sort(
    (a, b) =>
      resultRank(worstOf(a.counts)) - resultRank(worstOf(b.counts)) ||
      (b.updated > a.updated ? 1 : b.updated < a.updated ? -1 : 0) ||
      (a.scope?.name ?? a.report.metadata.name).localeCompare(
        b.scope?.name ?? b.report.metadata.name,
      ),
  );
  return { rows: filtered.slice(0, limit), total: filtered.length };
}

/** Search across policy names, rules, messages and scope names. */
export function searchPolicyResults(
  reports: readonly KubeObject[],
  query: string,
  limit = 200,
): PolicyGroupResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: PolicyGroupResult[] = [];
  for (const report of reports) {
    const scope = reportScope(report);
    for (const result of reportResults(report)) {
      const haystack = [
        result.policy,
        result.rule,
        result.message,
        result.category,
        scope?.kind ?? '',
        scope?.name ?? '',
        scope?.namespace ?? '',
      ]
        .join(' ')
        .toLowerCase();
      if (haystack.includes(q)) out.push({ scope, report, result });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
