import type { KubeObject } from '@/types';
import { asArray, asObject, asString, isObject, type JsonObject } from '../accessors';
import type { ObjectRef } from '../columns/types';
import { toSeverity, type Severity } from '../trivy/model';

/**
 * Policy reports reduced to plain rows. Pure: no i18n, no IPC. Policy and
 * rule names, categories and result messages are Kubernetes data and are
 * shown verbatim.
 */

export type PolicyResultValue = 'pass' | 'fail' | 'warn' | 'error' | 'skip';

export const POLICY_RESULT_VALUES: readonly PolicyResultValue[] = [
  'fail',
  'error',
  'warn',
  'pass',
  'skip',
];

const RESULT_NAMES: Record<string, PolicyResultValue> = {
  pass: 'pass',
  fail: 'fail',
  warn: 'warn',
  error: 'error',
  skip: 'skip',
};

export function toResult(value: unknown): PolicyResultValue | null {
  const v = asString(value).toLowerCase();
  return RESULT_NAMES[v] ?? null;
}

/** Order for "worst first" sorts. */
export function resultRank(r: PolicyResultValue): number {
  return POLICY_RESULT_VALUES.indexOf(r);
}

export interface ResultCounts {
  fail: number;
  error: number;
  warn: number;
  pass: number;
  skip: number;
}

export const emptyResultCounts = (): ResultCounts => ({
  fail: 0,
  error: 0,
  warn: 0,
  pass: 0,
  skip: 0,
});

export function addResultCounts(a: ResultCounts, b: ResultCounts): ResultCounts {
  return {
    fail: a.fail + b.fail,
    error: a.error + b.error,
    warn: a.warn + b.warn,
    pass: a.pass + b.pass,
    skip: a.skip + b.skip,
  };
}

export function resultCount(c: ResultCounts, r: PolicyResultValue): number {
  return c[r];
}

/** The object a report describes (`scope` in v1alpha2). */
export interface ReportScope {
  kind: string;
  name: string;
  namespace: string | null;
  apiVersion: string;
}

export function reportScope(report: KubeObject): ReportScope | null {
  const scope = asObject(report.scope);
  const kind = asString(scope.kind);
  const name = asString(scope.name);
  if (!kind || !name) return null;
  return {
    kind,
    name,
    namespace: asString(scope.namespace) || report.metadata.namespace || null,
    apiVersion: asString(scope.apiVersion),
  };
}

export function scopeRef(scope: ReportScope | null): ObjectRef | null {
  return scope ? { kind: scope.kind, name: scope.name, namespace: scope.namespace } : null;
}

export interface PolicyResult {
  policy: string;
  rule: string;
  result: PolicyResultValue;
  /** Optional severity of the policy (`critical`…`low`); null when unset. */
  severity: Severity | null;
  message: string;
  category: string;
  timestamp: string;
}

export function reportResults(report: KubeObject): PolicyResult[] {
  const out: PolicyResult[] = [];
  for (const r of asArray(report.results).filter(isObject)) {
    const result = toResult(r.result);
    const policy = asString(r.policy);
    if (!result || !policy) continue;
    const severity = asString(r.severity);
    out.push({
      policy,
      rule: asString(r.rule),
      result,
      severity: severity ? toSeverity(severity) : null,
      message: asString(r.message),
      category: asString(r.category),
      timestamp: resultTimestamp(r),
    });
  }
  return out;
}

function resultTimestamp(r: JsonObject): string {
  const t = asObject(r.timestamp);
  const seconds = t.seconds;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0)
    return new Date(seconds * 1000).toISOString();
  return '';
}

/** Report summary counts: from `results`, falling back to `summary` when empty. */
export function reportResultCounts(report: KubeObject): ResultCounts {
  const results = reportResults(report);
  if (results.length) {
    const c = emptyResultCounts();
    for (const r of results) c[r.result]++;
    return c;
  }
  const s = asObject(report.summary);
  return {
    pass: numberOf(s.pass),
    fail: numberOf(s.fail),
    warn: numberOf(s.warn),
    error: numberOf(s.error),
    skip: numberOf(s.skip),
  };
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The policy engine that wrote the report (`managed-by` label), when it says. */
export function reportEngine(report: KubeObject): string {
  return asString(report.metadata.labels?.['app.kubernetes.io/managed-by']);
}

/** Most recent result timestamp, else the report's creation. */
export function updatedAt(report: KubeObject): string {
  let best = '';
  for (const r of reportResults(report)) if (r.timestamp > best) best = r.timestamp;
  return best || report.metadata.creationTimestamp || '';
}

/** Worst result present in the counts (for compact rows). */
export function worstResult(c: ResultCounts): PolicyResultValue | null {
  for (const r of POLICY_RESULT_VALUES) if (c[r] > 0) return r;
  return null;
}
