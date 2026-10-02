import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { HelmInstallRequest } from '@/types';
import {
  KYVERNO_NAMESPACE,
  KYVERNO_RELEASE,
  KYVERNO_REPO_URL,
  POLICY_REPORT_KEYS,
  kyvernoInstallRequest,
  reportResultCounts,
  reportResults,
  reportScope,
} from '@/lib/kube/policyreports';

// The policy report fixtures: reports derived from the demo workloads,
// served through the generic resource handlers (like Trivy's) — and the
// one-click Kyverno install of the Security view.

let db: typeof import('./fixtures/db');
let handlers: Record<string, import('./registry').MockHandler>;

beforeAll(async () => {
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('location', { search: '', href: 'http://localhost:1430/' });
  ({ handlers } = await import('./registry'));
  await import('./helmCharts');
  await import('./resources');
  db = await import('./fixtures/db');
});

describe('policy report fixtures', () => {
  it('builds reports for the policy clusters only', () => {
    const eu = db.getDb('c-prod-eu');
    const staging = db.getDb('c-staging');
    const kind = db.getDb('c-kind');
    expect(db.list(eu, POLICY_REPORT_KEYS.PolicyReport).length).toBeGreaterThan(10);
    expect(db.list(eu, POLICY_REPORT_KEYS.ClusterPolicyReport).length).toBeGreaterThan(0);
    expect(db.list(staging, POLICY_REPORT_KEYS.PolicyReport).length).toBeGreaterThan(0);
    expect(db.list(kind, POLICY_REPORT_KEYS.PolicyReport)).toHaveLength(0);
    expect(db.list(kind, POLICY_REPORT_KEYS.ClusterPolicyReport)).toHaveLength(0);
  });

  it('writes scoped reports whose summary matches the results', () => {
    const eu = db.getDb('c-prod-eu');
    for (const report of db.list(eu, POLICY_REPORT_KEYS.PolicyReport)) {
      const scope = reportScope(report);
      expect(scope?.name, report.metadata.name).toBeTruthy();
      const counts = reportResultCounts(report);
      const results = reportResults(report);
      expect(counts.pass + counts.fail + counts.warn, report.metadata.name).toBe(results.length);
      // Workload reports evaluate the five demo policies.
      expect(results.length).toBeGreaterThanOrEqual(5);
    }
  });

  it('derives failures from the demo data', () => {
    const eu = db.getDb('c-prod-eu');
    const failing = db
      .list(eu, POLICY_REPORT_KEYS.PolicyReport)
      .flatMap((r) => reportResults(r).map((x) => [r, x] as const))
      .filter(([, x]) => x.result === 'fail');
    expect(failing.length).toBeGreaterThan(0);
    // The monitoring stack runs images from unapproved registries.
    const registries = failing.filter(([, x]) => x.policy === 'restrict-image-registries');
    expect(registries.length).toBeGreaterThan(0);
    const scoped = registries.find(([r]) => reportScope(r)?.namespace === 'monitoring');
    expect(scoped).toBeTruthy();
  });

  it('keeps one scope per cluster report', () => {
    const eu = db.getDb('c-prod-eu');
    for (const report of db.list(eu, POLICY_REPORT_KEYS.ClusterPolicyReport)) {
      const scope = reportScope(report);
      expect(scope?.kind === 'ClusterRole' || scope?.kind === 'Namespace').toBe(true);
    }
  });

  it('serves the report kinds after the one-click Kyverno install', async () => {
    vi.useFakeTimers();
    try {
      // c-kind ships without policy reports; install like the Security view does:
      // add the repository, then install the chart.
      const add = handlers.helm_repo_add!({
        name: 'kyverno',
        url: KYVERNO_REPO_URL,
        options: {
          username: null,
          password: null,
          insecure_skip_tls_verify: false,
          pass_credentials: false,
          force_update: false,
        },
      }) as Promise<void>;
      await vi.runAllTimersAsync();
      await add;

      const request: HelmInstallRequest = kyvernoInstallRequest('kyverno');
      const install = handlers.helm_install!({
        clusterId: 'c-kind',
        namespace: KYVERNO_NAMESPACE,
        request,
      }) as Promise<{ release: { name: string } | null }>;
      // Advancing the timers also fires the delayed first evaluations.
      await vi.runAllTimersAsync();
      const result = await install;
      expect(result.release?.name).toBe(KYVERNO_RELEASE);

      const reports = db.list(db.getDb('c-kind'), POLICY_REPORT_KEYS.PolicyReport);
      expect(reports.length).toBeGreaterThan(0);
      const counts = reportResultCounts(reports[0]!);
      expect(
        counts.pass + counts.fail + counts.warn + counts.error + counts.skip,
      ).toBe(reportResults(reports[0]!).length);
    } finally {
      vi.useRealTimers();
    }
  });
});
