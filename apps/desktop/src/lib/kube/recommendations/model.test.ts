import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ContainerRecommendation,
  RecommendationScanStatus,
  ResourceChange,
  RightsizingReport,
  WorkloadRecommendation,
} from '@/types';
import {
  RECOMMENDATION_LENSES,
  applyMode,
  rightsizingOrigin,
  type StoredRightsizing,
  capacityByNamespace,
  countLenses,
  intervalLabel,
  manualScanWait,
  optimizationTotals,
  rankUsage,
  riskScore,
  runErrorText,
  scanSourceLabel,
  scanStale,
  scanStateText,
  sortRecommendations,
  spotlight,
  runTime,
  strategyText,
  workloadKey,
} from './model';

const MiB = 1024 ** 2;

type Pair = [number | null, number | null];

const changeOf = (current: number | null, next: number | null): ResourceChange =>
  current === next
    ? 'unchanged'
    : current == null
      ? 'set'
      : next! > current
        ? 'increase'
        : 'decrease';

/**
 * A container: current (cpu, memory) requests, recommended ones (null =
 * unchanged) and usage, like the helper of `summary.rs`'s tests.
 */
function container(
  cur: Pair,
  rec: Pair = [null, null],
  usage: Partial<NonNullable<ContainerRecommendation['usage']>> | null = null,
  extra: Partial<ContainerRecommendation> = {},
): ContainerRecommendation {
  const recommended = { cpu: rec[0] ?? cur[0], memory: rec[1] ?? cur[1] };
  return {
    name: 'app',
    current: { cpu_request: cur[0], memory_request: cur[1], cpu_limit: null, memory_limit: null },
    recommended: {
      cpu_request: recommended.cpu,
      memory_request: recommended.memory,
      cpu_limit: null,
      memory_limit: null,
    },
    usage: usage
      ? {
          cpu_p95: 0,
          cpu_max: 0,
          memory_max: 0,
          hours: 168,
          cpu_avg: null,
          memory_avg: null,
          ...usage,
        }
      : null,
    cpu: changeOf(cur[0], recommended.cpu),
    memory: changeOf(cur[1], recommended.memory),
    memory_limit: 'unchanged',
    cpu_limit: 'unchanged',
    confidence: 'high',
    warnings: [],
    cpu_limit_raised: false,
    memory_limit_raised: false,
    evidence: null,
    ...extra,
  };
}

function workload(
  name: string,
  over: Partial<WorkloadRecommendation> = {},
  containers: ContainerRecommendation[] = [container([100, 128 * MiB], [null, null], {})],
): WorkloadRecommendation {
  return {
    kind: 'Deployment',
    namespace: 'shop',
    name,
    uid: name,
    replicas: 1,
    confidence: 'high',
    verdict: 'balanced',
    coverage_hours: 168,
    containers,
    monthly_delta: 0,
    monthly_current: 10,
    changed: false,
    pods: [],
    pods_truncated: false,
    hpa: null,
    lenses: [],
    cost_replicas: 1,
    ...over,
  };
}

const names = (list: WorkloadRecommendation[]) => list.map((w) => w.name);

describe('workload keys', () => {
  it('are kind/namespace/name like rec_rows.key', () => {
    expect(workloadKey({ kind: 'CronJob', namespace: 'batch', name: 'report' })).toBe(
      'CronJob/batch/report',
    );
  });
});

describe('risk score (mirrors summary.rs::risk_score)', () => {
  it('is +∞ after an OOM kill, else the largest usage ÷ request', () => {
    const oom = workload('oom', {}, [
      container(
        [100, 128 * MiB],
        [null, null],
        { cpu_p95: 1, memory_max: MiB },
        {
          warnings: [{ code: 'oom-killed', detail: null }],
        },
      ),
    ]);
    expect(riskScore(oom)).toBe(Infinity);
    const hot = workload('hot', {}, [
      container([100, 100 * MiB], [null, null], { cpu_p95: 250, memory_max: 150 * MiB }),
      container([100, 100 * MiB], [null, null], { cpu_p95: 50, memory_max: 300 * MiB }),
    ]);
    expect(riskScore(hot)).toBe(3);
  });

  it('counts a missing or zero request as 2 and ignores containers without usage', () => {
    expect(
      riskScore(
        workload('unset', {}, [container([null, 64 * MiB], [null, null], { memory_max: MiB })]),
      ),
    ).toBe(2);
    expect(riskScore(workload('zero', {}, [container([0, 64 * MiB], [null, null], {})]))).toBe(2);
    expect(riskScore(workload('none', {}, [container([100, 64 * MiB])]))).toBe(0);
  });
});

describe('sorting', () => {
  const list = [
    workload('saves-a-little', { verdict: 'over', changed: true, monthly_delta: -5 }),
    workload('saves-a-lot', {
      verdict: 'over',
      changed: true,
      monthly_delta: -50,
      confidence: 'medium',
    }),
    workload('b-under', { verdict: 'under', changed: true, monthly_delta: 3 }, [
      container([100, 100 * MiB], [200, null], { cpu_p95: 180, memory_max: 10 * MiB }),
    ]),
    workload(
      'a-under-oom',
      { verdict: 'under', changed: true, monthly_delta: 9, confidence: 'low' },
      [
        container(
          [100, 100 * MiB],
          [null, 200 * MiB],
          {},
          {
            warnings: [{ code: 'oom-killed', detail: null }],
          },
        ),
      ],
    ),
    workload('fine'),
  ];

  it('puts under-provisioned first by risk, then savings, and never mutates', () => {
    const before = names(list);
    expect(names(sortRecommendations(list, 'priority'))).toEqual([
      'a-under-oom',
      'b-under',
      'saves-a-lot',
      'saves-a-little',
      'fine',
    ]);
    expect(names(list)).toEqual(before);
  });

  it('sorts by monthly change, confidence and name with key ties', () => {
    expect(names(sortRecommendations(list, 'delta'))).toEqual([
      'saves-a-lot',
      'saves-a-little',
      'fine',
      'b-under',
      'a-under-oom',
    ]);
    expect(names(sortRecommendations(list, 'confidence'))).toEqual([
      'b-under',
      'fine',
      'saves-a-little',
      'saves-a-lot',
      'a-under-oom',
    ]);
    expect(names(sortRecommendations(list, 'name'))).toEqual([
      'a-under-oom',
      'b-under',
      'fine',
      'saves-a-little',
      'saves-a-lot',
    ]);
  });

  it('sorts by the request reduction × cost replicas', () => {
    const cpu = [
      workload('small', { cost_replicas: 1 }, [container([1000, MiB], [800, null], {})]),
      workload('wide', { cost_replicas: 3 }, [container([500, MiB], [400, null], {})]),
      workload('grows', {}, [container([100, MiB], [300, null], {})]),
      workload('unset', {}, [container([null, MiB], [100, null], {})]),
    ];
    expect(names(sortRecommendations(cpu, 'cpu'))).toEqual(['wide', 'small', 'unset', 'grows']);
    const memory = [
      workload('m1', {}, [container([100, 512 * MiB], [null, 256 * MiB], {})]),
      workload('m2', { cost_replicas: 4 }, [container([100, 256 * MiB], [null, 128 * MiB], {})]),
    ];
    expect(names(sortRecommendations(memory, 'memory'))).toEqual(['m2', 'm1']);
  });
});

describe('spotlight', () => {
  it('lists the riskiest under-provisioned and the largest high-confidence savings, 3 each', () => {
    const under = (
      name: string,
      cpuP95: number,
      confidence: 'high' | 'medium' | 'low' = 'medium',
    ) =>
      workload(name, { verdict: 'under', changed: true, confidence }, [
        container([100, 100 * MiB], [cpuP95, null], { cpu_p95: cpuP95 }),
      ]);
    const over = (name: string, delta: number, confidence: 'high' | 'medium' = 'high') =>
      workload(name, { verdict: 'over', changed: true, monthly_delta: delta, confidence });
    const list = [
      under('u1', 150),
      under('u2', 400),
      under('u-low', 900, 'low'),
      under('u3', 300),
      under('u4', 200),
      over('o1', -10),
      over('o2', -40),
      over('o-medium', -99, 'medium'),
      over('o3', -40),
      over('o4', -1),
    ];
    const s = spotlight(list);
    expect(names(s.under)).toEqual(['u2', 'u3', 'u4']);
    // Equal savings fall back to namespace, then name.
    expect(names(s.over)).toEqual(['o2', 'o3', 'o1']);
  });
});

describe('usage ranking', () => {
  const list = [
    workload('api', {}, [
      {
        ...container([100, MiB], [null, null], { cpu_avg: 40, cpu_max: 90, memory_avg: 5 * MiB }),
        name: 'app',
      },
      {
        ...container([100, MiB], [null, null], { cpu_avg: 0, cpu_max: 10, memory_avg: null }),
        name: 'proxy',
      },
    ]),
    workload('web', {}, [
      container([100, MiB], [null, null], { cpu_avg: 40, cpu_max: 400, memory_avg: 9 * MiB }),
    ]),
    workload('idle', {}, [container([100, MiB])]),
  ];

  it('ranks containers highest first, keeps zeros, drops missing values', () => {
    const before = JSON.stringify(list);
    const avg = rankUsage(list, 'cpu', 'avg');
    expect(avg.rows.map((r) => r.key)).toEqual([
      'Deployment/shop/api/app',
      'Deployment/shop/web/app',
      'Deployment/shop/api/proxy',
    ]);
    expect(avg.rows[2]!.value).toBe(0);
    expect(avg.available).toBe(3);
    expect(avg.total).toBe(4);
    expect(rankUsage(list, 'cpu', 'peak').rows.map((r) => r.value)).toEqual([400, 90, 10]);
    const memory = rankUsage(list, 'memory', 'avg');
    expect(memory.rows.map((r) => r.container)).toEqual(['app', 'app']);
    expect(memory.rows[0]!.rec.name).toBe('web');
    expect(memory.available).toBe(2);
    expect(JSON.stringify(list)).toBe(before);
  });
});

describe('capacity by namespace', () => {
  it('sums comparable requests × cost replicas and keeps the largest', () => {
    const list = ['a', 'b', 'c', 'd', 'e', 'f'].map((ns, i) =>
      workload(`w-${ns}`, { namespace: ns, cost_replicas: 2 }, [
        container([100 * (i + 1), MiB], [50 * (i + 1), null], {}),
        container([null, MiB], [100, null], {}),
        container([999, MiB]),
      ]),
    );
    const top = capacityByNamespace(list, 'cpu');
    expect(top.map((n) => n.namespace)).toEqual(['f', 'e', 'd', 'c', 'b']);
    expect(top[0]).toEqual({
      namespace: 'f',
      current: 1200,
      recommended: 600,
      comparable: 1,
      containers: 3,
    });
    expect(capacityByNamespace(list, 'memory', 2).map((n) => n.namespace)).toEqual(['a', 'b']);
    expect(capacityByNamespace([workload('x', {}, [container([100, MiB])])], 'cpu')).toEqual([]);
  });
});

describe('optimization totals (mirror summary.rs::summarize)', () => {
  it('counts verdicts, confidence, one-click and comparable requests', () => {
    const list = [
      workload('over', { verdict: 'over', changed: true, monthly_delta: -30, cost_replicas: 2 }, [
        container([500, 512 * MiB], [200, 256 * MiB], { cpu_p95: 100 }),
        container([null, 64 * MiB], [50, null], { cpu_p95: 20 }),
      ]),
      workload(
        'under',
        {
          verdict: 'under',
          changed: true,
          monthly_delta: 12,
          confidence: 'medium',
          namespace: 'api',
        },
        [container([100, 100 * MiB], [300, null], { cpu_p95: 250 })],
      ),
      workload('raised', { verdict: 'over', changed: true, monthly_delta: -4 }, [
        container([200, MiB], [100, null], {}, { cpu_limit_raised: true }),
      ]),
      workload('nodata', { verdict: 'no-data', confidence: 'low' }, [container([100, 32 * MiB])]),
    ];
    const t = optimizationTotals(list);
    expect(t).toMatchObject({
      workloads: 4,
      containers: 5,
      namespaces: 2,
      over: 2,
      under: 1,
      balanced: 0,
      no_data: 1,
      high: 2,
      medium: 1,
      low: 1,
      changed: 3,
      one_click: 1,
      monthly_current: 40,
      monthly_savings: 34,
      monthly_increases: 12,
    });
    // CPU: over 500→200 ×2, under 100→300, raised 200→100; the unset one and the no-data one are not comparable.
    expect(t.cpu).toEqual({ current: 1300, recommended: 800, comparable: 3, unset: 1 });
    expect(t.memory.unset).toBe(0);
    expect(t.memory.comparable).toBe(4);
    expect(t.memory.current).toBe(2 * 512 * MiB + 2 * 64 * MiB + 100 * MiB + MiB);
  });
});

describe('lenses', () => {
  it('count every lens, including the empty ones', () => {
    const counts = countLenses([
      workload('a', { lenses: ['cpu-reduction', 'needs-review'] }),
      workload('b', { lenses: ['cpu-reduction'] }),
    ]);
    expect(Object.keys(counts)).toEqual([...RECOMMENDATION_LENSES]);
    expect(counts['cpu-reduction']).toBe(2);
    expect(counts['needs-review']).toBe(1);
    expect(counts['limit-raised']).toBe(0);
  });
});

describe('apply mode (spec §8)', () => {
  const dev = { read_only: false, environment: 'development' as const };
  const eligible = workload('ok', { changed: true, verdict: 'over' });

  it('offers one click only for eligible rows on writable non-production clusters', () => {
    expect(applyMode(eligible, dev)).toBe('one-click');
    expect(applyMode(eligible, { read_only: false, environment: null })).toBe('one-click');
    expect(applyMode(eligible, { read_only: false, environment: 'production' })).toBe('review');
    expect(applyMode({ ...eligible, confidence: 'medium' }, dev)).toBe('review');
    const raised = workload('raised', { changed: true }, [
      container([100, MiB], [200, null], {}, { memory_limit_raised: true }),
    ]);
    expect(applyMode(raised, dev)).toBe('review');
  });

  it('keeps the review on read-only clusters, where applying is refused', () => {
    expect(applyMode(eligible, { read_only: true, environment: 'development' })).toBe('read-only');
    expect(applyMode(eligible, { read_only: true, environment: 'production' })).toBe('read-only');
  });

  it('has nothing to apply for rows without changes, on any cluster', () => {
    expect(applyMode(workload('same'), dev)).toBe('none');
    expect(applyMode(workload('same'), { read_only: true, environment: null })).toBe('none');
  });
});

describe('scan texts', () => {
  const status = (over: Partial<RecommendationScanStatus>): RecommendationScanStatus => ({
    cluster_id: 'c1',
    scheduled: true,
    interval_minutes: 60,
    state: 'idle',
    run_id: null,
    trigger: null,
    progress: null,
    started_at: null,
    finished_at: null,
    error: null,
    last_success_at: null,
    next_at: null,
    manual_available_at: null,
    ...over,
  });

  it('translate every backend error code and pass messages through', () => {
    const codes = [
      'app-restarted',
      'stopped',
      'no-usage-source',
      'timed-out',
      'cluster-label-mismatch',
      'cluster-label-unverified',
    ];
    for (const code of codes) {
      const text = runErrorText(code);
      expect(text, code).not.toBe(code);
      expect(text.length, code).toBeGreaterThan(20);
    }
    expect(runErrorText('query timed out after 60s')).toBe('query timed out after 60s');
    expect(runErrorText(null)).toBe('');
  });

  it('describe each state, with progress while running', () => {
    expect(
      scanStateText(
        status({ state: 'running', progress: { completed: 8, total: 48, workloads: 3 } }),
      ),
    ).toContain('8/48');
    expect(scanStateText(status({ state: 'failed', error: 'no-usage-source' }))).toContain(
      runErrorText('no-usage-source'),
    );
    expect(scanStateText(status({ state: 'interrupted' }))).toContain(runErrorText('stopped'));
    const states = ['idle', 'queued', 'running', 'success', 'failed', 'interrupted'] as const;
    expect(new Set(states.map((state) => scanStateText(status({ state })))).size).toBe(6);
  });

  it('label sources, intervals and staleness', () => {
    expect(scanSourceLabel('prometheus', 7)).toBe('Prometheus · 7 days');
    expect(scanSourceLabel('prometheus', 1)).toBe('Prometheus · 1 day');
    expect(scanSourceLabel('metrics-server', 7)).toBe('metrics-server · last hour');
    expect(intervalLabel(60)).toBe('Every hour');
    expect(intervalLabel(360)).toBe('Every 6 hours');
    expect(intervalLabel(15)).toBe('Every 15 minutes');
    const now = 10 * 3_600_000;
    expect(scanStale(now - 3_600_000, true, 60, now)).toBe(false);
    expect(scanStale(now - 2.5 * 3_600_000, true, 60, now)).toBe(true);
    expect(scanStale(now, false, 60, now)).toBe(true);
  });
});

describe('manual scan cooldown', () => {
  afterEach(() => vi.useRealTimers());

  it('counts down from the wall clock, so a stale tick never keeps the button disabled', () => {
    vi.useFakeTimers({ now: 10_000 });
    const tick = Date.now();
    expect(manualScanWait(15_500, tick)).toBe(6);
    vi.advanceTimersByTime(5_000);
    // The component re-rendered at 15 000 without a new tick: still 1 s.
    expect(manualScanWait(15_500, tick)).toBe(1);
    vi.advanceTimersByTime(600);
    // Past `manual_available_at` with the tick of 10 000 (the bug read 6 s).
    expect(manualScanWait(15_500, tick)).toBe(0);
    expect(manualScanWait(15_500, Date.now())).toBe(0);
  });

  it('is 0 without a rate limit', () => {
    expect(manualScanWait(null, 0)).toBe(0);
    expect(manualScanWait(undefined, 0)).toBe(0);
    expect(manualScanWait(0, 0, 5)).toBe(0);
  });
});

describe('run helpers', () => {
  it('date a run by its end, else its start', () => {
    const run = { started_at: 100, finished_at: 250 } as Parameters<typeof runTime>[0];
    expect(runTime(run)).toBe(250);
    expect(runTime({ ...run, finished_at: null })).toBe(100);
  });

  it('label the strategy, marking automatic choices', () => {
    const report = {
      strategy: 'workload-history',
      strategy_auto: true,
      strategies: [{ id: 'workload-history', name: 'Workload history' }],
    } as unknown as Parameters<typeof strategyText>[0];
    expect(strategyText(report)).toBe('Workload history (automatic)');
    expect(strategyText({ ...report, strategy_auto: false })).toBe('Workload history');
    expect(
      strategyText({ ...report, strategy: 'future', strategies: [], strategy_auto: false }),
    ).toBe('future');
  });
});

describe('stored or live right-sizing (spec §9.2)', () => {
  const report = (...names: string[]) =>
    ({ workloads: names.map((n) => workload(n)) }) as unknown as RightsizingReport;
  const latest = { scan: {}, source_changed: false, last_failure: null };
  const stored = (over: Partial<StoredRightsizing> = {}): StoredRightsizing => ({
    report: report('web', 'api'),
    latest,
    loading: false,
    error: null,
    ...over,
  });

  it('reads the latest stored scan when there is one', () => {
    expect(rightsizingOrigin(stored())).toEqual({ origin: 'stored', rec: null });
    // A reload (settings changed) keeps the previous scan shown meanwhile.
    expect(rightsizingOrigin(stored({ loading: true })).origin).toBe('stored');
  });

  it('picks the workload row by its key, else falls back to the live report', () => {
    const pick = rightsizingOrigin(stored(), 'Deployment/shop/api');
    expect(pick.origin).toBe('stored');
    expect(pick.rec?.name).toBe('api');
    // A workload the scan does not have (created since, or unreadable namespace).
    expect(rightsizingOrigin(stored(), 'Deployment/shop/new')).toEqual({
      origin: 'live',
      rec: null,
    });
    // Same name, other kind or namespace: not its row.
    expect(rightsizingOrigin(stored(), 'StatefulSet/shop/api').origin).toBe('live');
    expect(rightsizingOrigin(stored(), 'Deployment/other/api').origin).toBe('live');
    expect(
      rightsizingOrigin(stored({ report: report('batch') }), workloadKey(workload('batch'))).rec
        ?.name,
    ).toBe('batch');
  });

  it('falls back to the live report without a scan, after a source change or a failed read', () => {
    const noScan = { scan: null, source_changed: false, last_failure: null };
    expect(rightsizingOrigin(stored({ report: null, latest: noScan })).origin).toBe('live');
    expect(
      rightsizingOrigin(
        stored({ report: null, latest: { ...noScan, source_changed: true } }),
        'Deployment/shop/web',
      ).origin,
    ).toBe('live');
    expect(
      rightsizingOrigin(stored({ report: null, latest: null, error: 'history.db is locked' }))
        .origin,
    ).toBe('live');
    // Not loading (the view is hidden): nothing is pending.
    expect(rightsizingOrigin(stored({ report: null, latest: null })).origin).toBe('live');
  });

  it('waits for the first read of the stored scans before computing a live report', () => {
    expect(
      rightsizingOrigin(
        stored({ report: null, latest: null, loading: true }),
        'Deployment/shop/web',
      ),
    ).toEqual({ origin: 'pending', rec: null });
    // Answered "no scan" and reloading: the live report stays.
    expect(
      rightsizingOrigin(
        stored({
          report: null,
          latest: { scan: null, source_changed: false, last_failure: null },
          loading: true,
        }),
      ).origin,
    ).toBe('live');
  });
});
