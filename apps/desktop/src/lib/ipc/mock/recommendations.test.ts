import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  AlertNotice,
  ClusterDef,
  ClusterRecommendationSummary,
  RecommendationLatest,
  RecommendationRun,
  RecommendationScanStatus,
  RightsizingReport,
  Settings,
  WorkloadRecommendation,
  WorkloadUsageHistory,
} from '@/types';

// The demo backend's recommendation scans follow the backend: seeded
// histories per cluster, the pipeline's notes and flags, re-evaluation with
// the current settings, scans whose progress total grows, aligned window
// ends, and exports shaped like `export.rs`.

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

let invoke: Invoke;
let listen: typeof import('./bus').mockListen;
let newSavings: typeof import('./recommendations').newSavings;
let planSavingAlerts: typeof import('./recommendations').planSavingAlerts;
let SAVING_ALERTS_PER_SCAN: number;

beforeAll(async () => {
  vi.useFakeTimers({ now: new Date('2026-09-28T10:30:00Z') });
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('location', { search: '', href: 'http://localhost:1430/' });
  const mock = await import('./index');
  invoke = (command, args = {}) => mock.mockInvoke(command, args);
  listen = (await import('./bus')).mockListen;
  ({ newSavings, planSavingAlerts, SAVING_ALERTS_PER_SCAN } = await import('./recommendations'));
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Run `promise` while the fake clock advances. */
async function settle<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
  const done = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(ms);
  const result = await done;
  if ('error' in result) throw result.error;
  return result.value;
}

const flags = (report: RightsizingReport) =>
  new Set(
    report.workloads.flatMap((w) => w.containers.flatMap((c) => c.warnings.map((x) => x.code))),
  );

describe('demo recommendation scans', () => {
  it('seeds 30 days of scans on prod-eu-west-1 with every kind of flag', async () => {
    const runs = await settle(
      invoke<RecommendationRun[]>('recommendations_runs', { clusterId: 'c-prod-eu', limit: 500 }),
    );
    expect(runs.length).toBe(48 + 27);
    expect(runs[0]!.started_at).toBeGreaterThan(runs[1]!.started_at);
    expect(runs.some((r) => r.status === 'failed')).toBe(true);
    expect(runs.some((r) => r.status === 'interrupted' && r.error === 'stopped')).toBe(true);
    expect(runs.some((r) => r.trigger === 'manual')).toBe(true);
    expect(runs.filter((r) => r.status === 'success').every((r) => r.summary && r.rows_kept)).toBe(
      true,
    );

    const latest = await settle(
      invoke<RecommendationLatest>('recommendations_latest', {
        clusterId: 'c-prod-eu',
        runId: null,
      }),
    );
    const scan = latest.scan!;
    expect(scan.reevaluated).toBe(false);
    expect(scan.report.workloads.length).toBeGreaterThanOrEqual(20);
    expect(scan.report.strategy).toBe('workload-history');
    expect(scan.report.strategy_auto).toBe(true);
    expect(scan.report.window_end % 300_000).toBe(0);
    expect(scan.report.notes.map((n) => n.kind)).toContain('partial-data');
    expect(scan.run.summary!.workloads).toBe(scan.report.workloads.length);
    const seen = flags(scan.report);
    for (const code of [
      'oom-killed',
      'cpu-throttled',
      'low-coverage',
      'partial-data',
      'hpa-target',
      'identity-unclear',
    ])
      expect(seen, code).toContain(code);
    expect(scan.report.workloads.some((w) => w.kind === 'CronJob')).toBe(true);
    expect(scan.report.workloads.some((w) => w.lenses.length > 0)).toBe(true);
    expect(scan.run.summary!.one_click).toBeGreaterThan(0);
    // A failure after the latest success would be reported; here none.
    expect(latest.last_failure).toBeNull();
  });

  it('shows metrics-server only, a failed last scan and no scan', async () => {
    const staging = await settle(
      invoke<RecommendationLatest>('recommendations_latest', {
        clusterId: 'c-staging',
        runId: null,
      }),
    );
    expect(staging.scan!.report.source).toBe('metrics-server');
    expect(staging.scan!.report.strategy).toBe('percentile-headroom');
    const dev = await settle(
      invoke<RecommendationLatest>('recommendations_latest', { clusterId: 'c-dev', runId: null }),
    );
    expect(dev.scan).not.toBeNull();
    expect(dev.last_failure!.status).toBe('failed');
    expect(dev.last_failure!.error).toContain('too many samples');
    expect(dev.scan!.report.notes.map((n) => n.kind)).toContain('namespace-failed');
    const us = await settle(
      invoke<RecommendationLatest>('recommendations_latest', {
        clusterId: 'c-prod-us',
        runId: null,
      }),
    );
    expect(us.scan!.report.notes.map((n) => n.kind)).toEqual([
      'hpa-unavailable',
      'query-budget-exceeded',
      'ownership-unavailable',
    ]);
    expect(flags(us.scan!.report)).toContain('identity-by-name');
    const kind = await settle(
      invoke<RecommendationLatest>('recommendations_latest', { clusterId: 'c-kind', runId: null }),
    );
    expect(kind.scan).toBeNull();
  });

  it('reports every cluster in the fleet with its last failure', async () => {
    const fleet = await settle(invoke<ClusterRecommendationSummary[]>('recommendations_fleet'));
    const byId = Object.fromEntries(fleet.map((f) => [f.cluster_id, f]));
    expect(byId['c-dev']!.run!.summary).not.toBeNull();
    expect(byId['c-dev']!.last_failure!.status).toBe('failed');
    expect(byId['c-dev']!.last_failure!.id).toBeGreaterThan(byId['c-dev']!.run!.id);
    expect(byId['c-prod-eu']!.last_failure).toBeNull();
    expect(byId['c-kind']!.run).toBeNull();
    expect(byId['c-kind']!.last_failure).toBeNull();
  });

  it('re-evaluates the stored scan with the current settings', async () => {
    const settings = await invoke<Settings>('settings_get');
    const before = await settle(
      invoke<RecommendationLatest>('recommendations_latest', {
        clusterId: 'c-prod-eu',
        runId: null,
      }),
    );
    await invoke('settings_set', {
      settings: {
        ...settings,
        recommendations: {
          ...settings.recommendations,
          overrides: {
            'workload-history': {
              ...before.scan!.report.settings,
              cpu_headroom_percent: 60,
              days: 14,
            },
          },
        },
      },
    });
    const after = await settle(
      invoke<RecommendationLatest>('recommendations_latest', {
        clusterId: 'c-prod-eu',
        runId: null,
      }),
    );
    expect(after.scan!.reevaluated).toBe(true);
    expect(after.scan!.days_changed).toBe(true);
    expect(after.scan!.report.window_secs).toBe(before.scan!.report.window_secs);
    expect(after.scan!.report.settings.cpu_headroom_percent).toBe(60);
    await invoke('settings_set', { settings });
  });

  it('exports like the backend and never quotes the connection', async () => {
    const yaml = await settle(
      invoke<string>('recommendations_export', {
        clusterId: 'c-prod-eu',
        runId: null,
        workloads: [],
        format: 'yaml',
      }),
    );
    expect(yaml).toMatch(/^# \w+ [\w-]+\/[\w-]+ · container [\w-]+\n/);
    expect(yaml).toContain(
      '# Resource fragment, not a complete manifest. Values are rounded up.\n',
    );
    expect(yaml).toContain('\n---\n');
    const json = await settle(
      invoke<string>('recommendations_export', {
        clusterId: 'c-prod-eu',
        runId: null,
        workloads: [],
        format: 'json',
      }),
    );
    const doc = JSON.parse(json) as { format: string; cluster: string; scanned_at: string };
    expect(doc.format).toBe('kubepit.recommendations/v1');
    expect(doc.cluster).toBe('prod-eu-west-1');
    expect(doc.scanned_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(json).not.toContain('source_config');
  });

  it('scans with a growing progress total and honours the rules', async () => {
    await expect(invoke('recommendations_scan', { clusterId: 'c-prod-eu' })).rejects.toThrow(
      'connect to the cluster first',
    );
    await settle(invoke('cluster_connect', { id: 'c-prod-eu' }));
    const seen: RecommendationScanStatus[] = [];
    const stop = await listen<RecommendationScanStatus>('recommendations://scan', (s) => {
      if (s.cluster_id === 'c-prod-eu') seen.push(s);
    });
    const queued = await invoke<RecommendationScanStatus>('recommendations_scan', {
      clusterId: 'c-prod-eu',
    });
    expect(queued.state).toBe('queued');
    // While it runs: the running status, not a second scan.
    const again = await settle(
      invoke<RecommendationScanStatus>('recommendations_scan', { clusterId: 'c-prod-eu' }),
      600,
    );
    expect(['queued', 'running']).toContain(again.state);
    await vi.advanceTimersByTimeAsync(10_000);
    stop();
    const totals = seen.flatMap((s) => (s.progress ? [s.progress.total] : []));
    expect(Math.max(...totals)).toBeGreaterThan(16);
    expect(totals).toEqual([...totals].sort((a, b) => a - b));
    const last = seen[seen.length - 1]!;
    expect(last.state).toBe('success');
    expect(last.progress).toBeNull();
    await expect(invoke('recommendations_scan', { clusterId: 'c-prod-eu' })).rejects.toThrow(
      /wait \d+ s/,
    );
    const latest = await settle(
      invoke<RecommendationLatest>('recommendations_latest', {
        clusterId: 'c-prod-eu',
        runId: null,
      }),
    );
    expect(latest.scan!.run.id).toBe(last.run_id);
    expect(latest.scan!.run.trigger).toBe('manual');
    expect(latest.scan!.report.window_end % 300_000).toBe(0);
  });

  it('alerts new high-confidence savings once, only when turned on', async () => {
    const settings = await invoke<Settings>('settings_get');
    const saving: AlertNotice[] = [];
    const stop = await listen<AlertNotice>('alerts://new', (n) => {
      if (n.alert.reason === 'RightsizingSaving') saving.push(n);
    });
    const scan = async () => {
      await invoke('recommendations_scan', { clusterId: 'c-dev' });
      await vi.advanceTimersByTimeAsync(10_000);
      // Past the manual cooldown for the next one.
      await vi.advanceTimersByTimeAsync(60_000);
    };
    await settle(invoke('cluster_connect', { id: 'c-dev' }));

    // Off by default.
    await scan();
    expect(saving).toEqual([]);

    await invoke('settings_set', {
      settings: { ...settings, recommendations: { ...settings.recommendations, alerts: true } },
    });
    // The previous run has every saving this one finds: nothing new.
    await scan();
    expect(saving).toEqual([]);

    // After a clear there is no previous run: one summary for the cluster.
    await invoke('history_clear', { kind: 'recommendations', clusterId: 'c-dev' });
    await scan();
    const latest = await settle(
      invoke<RecommendationLatest>('recommendations_latest', { clusterId: 'c-dev', runId: null }),
    );
    const expected = newSavings(null, latest.scan!.report).map((w) => `${w.namespace}/${w.name}`);
    expect(expected.length).toBeGreaterThan(0);
    expect(saving.length).toBe(1);
    const summary = saving[0]!.alert;
    expect(summary.object).toMatchObject({ kind: 'Workload', namespace: null, name: '' });
    expect(summary.condition).toBeNull();
    expect(summary.count).toBe(1);
    expect(summary.group!.total).toBe(expected.length);
    expect([...summary.group!.names].sort()).toEqual([...expected].sort());
    expect(summary.message).toBe(
      `${expected.length} workloads could shrink their requests by half or more`,
    );
    await scan();
    expect(saving.length).toBe(1);
    stop();
    await invoke('settings_set', { settings });
    await settle(invoke('cluster_disconnect', { id: 'c-dev' }));
  });

  it('caps the saving alerts of a scan at five plus one group', async () => {
    const latest = await settle(
      invoke<RecommendationLatest>('recommendations_latest', {
        clusterId: 'c-prod-eu',
        runId: null,
      }),
    );
    const report = latest.scan!.report;
    const base = report.workloads.find((w) => w.monthly_current > 0)!;
    const big = (name: string, delta: number): WorkloadRecommendation => ({
      ...base,
      name,
      verdict: 'over',
      confidence: 'high',
      changed: true,
      monthly_current: 1000,
      monthly_delta: -delta,
      containers: base.containers.map((c) => ({
        ...c,
        current: { ...c.current, cpu_request: 2000 },
        recommended: { ...c.recommended, cpu_request: 200 },
      })),
    });
    const previous = { ...report, workloads: [big('old', 900)] };
    const deltas = [510, 800, 600, 990, 700, 520, 950, 500];
    const next = {
      ...report,
      workloads: [big('old', 900), ...deltas.map((d, i) => big(`w${i}`, d))],
    };
    const plan = planSavingAlerts(previous, next);
    expect(plan.length).toBe(SAVING_ALERTS_PER_SCAN + 1);
    expect(plan.slice(0, 5).map((p) => (p.kind === 'one' ? p.workload.name : ''))).toEqual([
      'w3',
      'w6',
      'w1',
      'w4',
      'w2',
    ]);
    const rest = plan[5]!;
    expect(rest.kind === 'group' && rest.more && rest.workloads.map((w) => w.name)).toEqual([
      'w5',
      'w0',
      'w7',
    ]);
    const first = planSavingAlerts(null, next);
    expect(first.length).toBe(1);
    expect(first[0]!.kind === 'group' && !first[0]!.more && first[0]!.workloads.length).toBe(9);
  });

  it('charts usage with gaps and refuses odd pod names', async () => {
    const workload = { kind: 'Deployment', namespace: 'monitoring', name: 'prometheus-server' };
    const clusters = await invoke<ClusterDef[]>('cluster_list');
    expect(clusters.some((c) => c.id === 'c-prod-eu')).toBe(true);
    const latest = await settle(
      invoke<RecommendationLatest>('recommendations_latest', {
        clusterId: 'c-prod-eu',
        runId: null,
      }),
    );
    const rec = latest.scan!.report.workloads.find((w) => w.containers[0]!.usage)!;
    const h = await settle(
      invoke<WorkloadUsageHistory>('recommendations_usage_history', {
        clusterId: 'c-prod-eu',
        workload: { kind: rec.kind, namespace: rec.namespace, name: rec.name },
        container: rec.containers[0]!.name,
        pods: [],
        days: null,
      }),
    );
    expect(h.step_secs).toBe(3600);
    expect(h.pod_filter).toBe('pattern');
    expect(h.end % 300_000).toBe(0);
    expect(h.cpu_avg.length).toBeGreaterThan(100);
    expect(h.cpu_avg.some(([t], i) => i > 0 && t - h.cpu_avg[i - 1]![0] > 3_600_000)).toBe(true);
    await expect(
      invoke('recommendations_usage_history', {
        clusterId: 'c-prod-eu',
        workload,
        container: 'prometheus-server',
        pods: ['a|b'],
        days: null,
      }),
    ).rejects.toThrow('invalid pod name');
  });

  it('answers the status of any cluster id like the backend', async () => {
    const status = await invoke<RecommendationScanStatus>('recommendations_status', {
      clusterId: 'c-unknown',
    });
    expect(status).toMatchObject({
      cluster_id: 'c-unknown',
      state: 'idle',
      scheduled: false,
      run_id: null,
      last_success_at: null,
    });
  });

  it('clears a cluster through the history', async () => {
    await invoke('history_clear', { kind: 'recommendations', clusterId: 'c-dev' });
    const dev = await settle(
      invoke<RecommendationLatest>('recommendations_latest', { clusterId: 'c-dev', runId: null }),
    );
    expect(dev.scan).toBeNull();
    expect(
      await settle(
        invoke<RecommendationRun[]>('recommendations_runs', { clusterId: 'c-dev', limit: 5 }),
      ),
    ).toEqual([]);
  });
});
