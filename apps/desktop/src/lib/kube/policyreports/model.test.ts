import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@/types';
import {
  detectPolicyReports,
  policyReportGvk,
  policyReportKindOf,
  POLICY_REPORT_KEYS,
} from './kinds';
import {
  reportResultCounts,
  reportResults,
  reportScope,
  reportEngine,
  toResult,
  updatedAt,
} from './model';

function report(overrides: Record<string, unknown> = {}): KubeObject {
  return {
    apiVersion: 'wgpolicyk8s.io/v1alpha2',
    kind: 'PolicyReport',
    metadata: {
      name: 'pol-9f4c2e',
      namespace: 'checkout',
      uid: 'pol-uid',
      creationTimestamp: '2026-09-30T08:00:00Z',
      labels: { 'app.kubernetes.io/managed-by': 'kyverno' },
    },
    scope: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'payment-api', namespace: 'checkout' },
    results: [
      {
        policy: 'require-team-label',
        rule: 'check-team-label',
        result: 'fail',
        severity: 'medium',
        message: 'deployment "payment-api" has no "team" label',
        category: 'Governance',
        timestamp: { seconds: 1769500800, nanos: 0 },
      },
      {
        policy: 'disallow-privileged',
        rule: 'privileged-containers',
        result: 'pass',
        timestamp: { seconds: 1769500801, nanos: 0 },
      },
      {
        policy: 'restrict-image-registries',
        rule: 'validate-registries',
        result: 'warn',
        severity: 'low',
        message: 'image from an unapproved registry',
      },
      { policy: 'no-rule-no-result', result: 'weird' },
    ],
    ...overrides,
  };
}

const apiResource = (kind: string, plural: string, namespaced: boolean) => ({
  group: 'wgpolicyk8s.io',
  version: 'v1alpha2',
  kind,
  plural,
  namespaced,
  api_version: 'wgpolicyk8s.io/v1alpha2',
  verbs: ['get', 'list', 'watch'],
  short_names: [],
  categories: [],
});

describe('policy report kinds', () => {
  it('detects served report kinds only', () => {
    expect(detectPolicyReports(null)).toBe(false);
    expect(detectPolicyReports([])).toBe(false);
    expect(
      detectPolicyReports([apiResource('PolicyReport', 'policyreports', true)]),
    ).toBe(true);
    expect(
      detectPolicyReports([apiResource('ClusterPolicyReport', 'clusterpolicyreports', false)]),
    ).toBe(true);
    expect(
      detectPolicyReports([
        { ...apiResource('Deployment', 'deployments', true), group: 'apps' },
      ]),
    ).toBe(false);
  });

  it('resolves the served gvk', () => {
    const served = [
      apiResource('PolicyReport', 'policyreports', true),
      apiResource('ClusterPolicyReport', 'clusterpolicyreports', false),
    ];
    expect(policyReportGvk('PolicyReport', served)).toEqual({
      group: 'wgpolicyk8s.io',
      version: 'v1alpha2',
      kind: 'PolicyReport',
      plural: 'policyreports',
      namespaced: true,
    });
    expect(policyReportGvk('ClusterPolicyReport', null)).toBeNull();
  });

  it('matches objects by group and kind', () => {
    expect(policyReportKindOf(report())).toBe('PolicyReport');
    expect(POLICY_REPORT_KEYS.PolicyReport).toBe('policyreports.wgpolicyk8s.io');
    expect(
      policyReportKindOf({ apiVersion: 'wgpolicyk8s.io/v1alpha2', kind: 'Other' }),
    ).toBeNull();
  });
});

describe('policy report model', () => {
  it('reads the scope', () => {
    expect(reportScope(report())).toEqual({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      name: 'payment-api',
      namespace: 'checkout',
    });
    expect(reportScope(report({ scope: null }))).toBeNull();
  });

  it('parses results and skips unusable ones', () => {
    const results = reportResults(report());
    expect(results.map((r) => [r.policy, r.result])).toEqual([
      ['require-team-label', 'fail'],
      ['disallow-privileged', 'pass'],
      ['restrict-image-registries', 'warn'],
    ]);
    expect(results[0]).toMatchObject({
      rule: 'check-team-label',
      severity: 'MEDIUM',
      message: 'deployment "payment-api" has no "team" label',
      category: 'Governance',
      timestamp: '2026-01-27T08:00:00.000Z',
    });
    // No severity is null, not UNKNOWN.
    expect(results[1]!.severity).toBeNull();
  });

  it('normalizes result values', () => {
    expect(toResult('PASS')).toBe('pass');
    expect(toResult('fail')).toBe('fail');
    expect(toResult('skipped')).toBeNull();
  });

  it('counts from results, falling back to summary', () => {
    expect(reportResultCounts(report())).toEqual({
      fail: 1,
      error: 0,
      warn: 1,
      pass: 1,
      skip: 0,
    });
    const summaryOnly = report({
      results: undefined,
      summary: { pass: 3, fail: 2, warn: 0, error: 1, skip: 4 },
    });
    expect(reportResultCounts(summaryOnly)).toEqual({
      fail: 2,
      error: 1,
      warn: 0,
      pass: 3,
      skip: 4,
    });
  });

  it('derives the updated time from the newest result', () => {
    expect(updatedAt(report())).toBe('2026-01-27T08:00:01.000Z');
    expect(updatedAt(report({ results: undefined }))).toBe('2026-09-30T08:00:00Z');
  });

  it('reads the engine label', () => {
    expect(reportEngine(report())).toBe('kyverno');
    expect(reportEngine(report({ metadata: { name: 'x', uid: 'u' } }))).toBe('');
  });
});
