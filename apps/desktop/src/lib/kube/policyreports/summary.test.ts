import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@/types';
import { policyGroups, policyTotals, reportRows, searchPolicyResults } from './summary';

function report(
  name: string,
  scope: { kind: string; name: string; namespace?: string } | null,
  results: Array<{ policy: string; rule?: string; result: string; severity?: string; message?: string }>,
): KubeObject {
  return {
    apiVersion: 'wgpolicyk8s.io/v1alpha2',
    kind: 'PolicyReport',
    metadata: { name, namespace: 'checkout', uid: `uid-${name}`, creationTimestamp: '2026-09-01T00:00:00Z' },
    ...(scope ? { scope: { apiVersion: 'apps/v1', ...scope, namespace: scope.namespace ?? 'checkout' } } : {}),
    results: results.map((r) => ({
      policy: r.policy,
      rule: r.rule ?? r.policy,
      result: r.result,
      ...(r.severity ? { severity: r.severity } : {}),
      ...(r.message ? { message: r.message } : {}),
      timestamp: { seconds: 1769500800 },
    })),
  };
}

const reports = [
  report(
    'pol-a',
    { kind: 'Deployment', name: 'payment-api' },
    [
      { policy: 'require-team-label', result: 'fail', severity: 'medium', message: 'no team label' },
      { policy: 'disallow-privileged', result: 'pass' },
      { policy: 'restrict-image-registries', result: 'fail', severity: 'high', message: 'legacy registry' },
    ],
  ),
  report(
    'pol-b',
    { kind: 'Deployment', name: 'web-shop' },
    [
      { policy: 'require-team-label', result: 'fail', severity: 'low' },
      { policy: 'audit-annotations', result: 'warn' },
      { policy: 'probe-policy', result: 'error', message: 'rule engine: timeout' },
    ],
  ),
  report('pol-c', { kind: 'ConfigMap', name: 'shop-config' }, [
    { policy: 'disallow-privileged', result: 'pass' },
  ]),
];

describe('policy totals', () => {
  it('sums results across reports', () => {
    expect(policyTotals(reports)).toEqual({
      fail: 3,
      error: 1,
      warn: 1,
      pass: 2,
      skip: 0,
      reports: 3,
    });
  });
});

describe('policy groups', () => {
  it('groups failing, erroring and warning results by policy', () => {
    const groups = policyGroups(reports);
    expect(groups.map((g) => g.policy)).toEqual([
      'require-team-label',
      'restrict-image-registries',
      'probe-policy',
      'audit-annotations',
    ]);
    const team = groups.find((g) => g.policy === 'require-team-label')!;
    expect(team.results.map((r) => r.scope?.name)).toEqual(['payment-api', 'web-shop']);
    // Worst severity wins across the group's results.
    expect(team.severity).toBe('MEDIUM');
    expect(groups.find((g) => g.policy === 'audit-annotations')!.severity).toBeNull();
  });

  it('keeps pass and skip out of the groups', () => {
    expect(policyGroups(reports).some((g) => g.policy === 'disallow-privileged')).toBe(false);
  });
});

describe('report rows', () => {
  it('lists rows worst first and filters by scope text', () => {
    const all = reportRows(reports);
    expect(all.total).toBe(3);
    // The failing reports come before the passing-only one.
    expect(all.rows[2]!.report.metadata.name).toBe('pol-c');
    expect(all.rows[0]!.counts.fail).toBeGreaterThan(0);
    const filtered = reportRows(reports, 'shop-config');
    expect(filtered.rows.map((r) => r.scope?.name)).toEqual(['shop-config']);
  });
});

describe('policy search', () => {
  it('matches policy, rule, message and scope', () => {
    expect(searchPolicyResults(reports, 'legacy')).toHaveLength(1);
    expect(searchPolicyResults(reports, 'payment-api')).toHaveLength(3);
    expect(searchPolicyResults(reports, '')).toHaveLength(0);
  });
});
