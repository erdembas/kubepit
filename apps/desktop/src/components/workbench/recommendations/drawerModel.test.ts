import { describe, expect, it } from 'vitest';
import type {
  ContainerRecommendation,
  RecommendationTrendPoint,
  RightsizingReport,
  UsageEvidence,
  WorkloadRecommendation,
} from '@/types';
import {
  cpuValueText,
  trapTarget,
  drawerAction,
  evidenceRows,
  exportFileName,
  findRecommendation,
  historyDays,
  hpaTargets,
  hpaText,
  maxOf,
  meanOf,
  pickContainer,
  reportVersion,
  stepText,
  trendInterval,
  trendKey,
  trendRange,
  trendSeries,
  usageChartsState,
  usageHistoryKey,
  usageRefs,
  yamlKey,
} from './drawerModel';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function container(over: Partial<ContainerRecommendation> = {}): ContainerRecommendation {
  return {
    name: 'app',
    current: {
      cpu_request: 500,
      cpu_limit: 1000,
      memory_request: 512 * 2 ** 20,
      memory_limit: null,
    },
    recommended: {
      cpu_request: 120,
      cpu_limit: 1000,
      memory_request: 256 * 2 ** 20,
      memory_limit: 384 * 2 ** 20,
    },
    usage: null,
    cpu: 'decrease',
    memory: 'decrease',
    memory_limit: 'set',
    cpu_limit: 'unchanged',
    confidence: 'high',
    warnings: [],
    cpu_limit_raised: false,
    memory_limit_raised: false,
    evidence: null,
    ...over,
  };
}

function workload(over: Partial<WorkloadRecommendation> = {}): WorkloadRecommendation {
  return {
    kind: 'Deployment',
    namespace: 'shop',
    name: 'checkout',
    uid: 'u1',
    replicas: 3,
    confidence: 'high',
    verdict: 'over',
    coverage_hours: 168,
    containers: [container()],
    monthly_delta: -40,
    monthly_current: 90,
    changed: true,
    pods: ['checkout-1'],
    pods_truncated: false,
    hpa: null,
    lenses: [],
    cost_replicas: 3,
    ...over,
  };
}

const report = (workloads: WorkloadRecommendation[]) =>
  ({
    source: 'prometheus',
    window_secs: 7 * 86_400,
    computed_at: 1_000,
    workloads,
  }) as unknown as RightsizingReport;

describe('findRecommendation', () => {
  const a = workload();
  const b = workload({ kind: 'CronJob', namespace: 'jobs', name: 'nightly' });
  it('finds the open row in the whole report by its key', () => {
    expect(findRecommendation(report([a, b]), 'CronJob/jobs/nightly')).toBe(b);
    expect(findRecommendation(report([a, b]), 'Deployment/shop/checkout')).toBe(a);
  });
  it('is null when nothing is open or the scan lacks the row', () => {
    expect(findRecommendation(report([a]), null)).toBeNull();
    expect(findRecommendation(report([a]), 'Deployment/shop/gone')).toBeNull();
  });
});

describe('pickContainer', () => {
  const rec = workload({
    containers: [
      container({
        name: 'sidecar',
        cpu: 'unchanged',
        memory: 'unchanged',
        memory_limit: 'unchanged',
      }),
      container({ name: 'app' }),
    ],
  });
  it('keeps a pick the row has, else the first container that changes', () => {
    expect(pickContainer(rec, 'sidecar')).toBe('sidecar');
    expect(pickContainer(rec, 'gone')).toBe('app');
    expect(pickContainer(rec, null)).toBe('app');
  });
  it('falls back to the first container, or null without any', () => {
    const still = workload({
      containers: [
        container({ name: 'x', cpu: 'unchanged', memory: 'unchanged', memory_limit: 'unchanged' }),
      ],
    });
    expect(pickContainer(still, null)).toBe('x');
    expect(pickContainer(workload({ containers: [] }), null)).toBeNull();
  });
});

describe('poll keys', () => {
  const rec = workload();
  it('start with the cluster, like every poll the header refreshes and a disconnect drops', () => {
    const r1 = report([rec]);
    for (const key of [
      usageHistoryKey('c1', rec, 'app', 7, null, r1),
      trendKey('c1', rec, null, 1),
      yamlKey('c1', rec, null, r1),
    ])
      expect(key.startsWith('c1|recs-')).toBe(true);
  });
  it('separate runs and scans, and keep re-evaluations for live usage', () => {
    const r1 = report([rec]);
    const key = usageHistoryKey('c1', rec, 'app', 7, null, r1);
    expect(key).toContain('Deployment/shop/checkout');
    expect(usageHistoryKey('c1', rec, 'app', 7, 12, r1)).not.toBe(key);
    expect(usageHistoryKey('c1', rec, 'app', 7, null, { computed_at: 2_000 })).not.toBe(key);
    // A re-evaluated report of the same scan keeps the key (same window, same pods).
    expect(usageHistoryKey('c1', rec, 'app', 7, null, { ...r1 })).toBe(key);
  });
  it('refetch the trend when a new latest run lands', () => {
    expect(trendKey('c1', rec, null, 4)).not.toBe(trendKey('c1', rec, null, 5));
    expect(trendKey('c1', rec, 3, 5)).not.toBe(trendKey('c1', rec, null, 5));
  });
  it('refetch the YAML for every report object (re-evaluation)', () => {
    const r1 = report([rec]);
    const r2 = { ...r1 };
    expect(reportVersion(r1)).toBe(reportVersion(r1));
    expect(reportVersion(r2)).not.toBe(reportVersion(r1));
    expect(yamlKey('c1', rec, null, r1)).toBe(yamlKey('c1', rec, null, r1));
    expect(yamlKey('c1', rec, null, r2)).not.toBe(yamlKey('c1', rec, null, r1));
  });
  it('names the saved fragment after the workload', () => {
    expect(exportFileName(rec)).toBe('deployment-shop-checkout.yaml');
  });
});

describe('usage charts', () => {
  it('need Prometheus and a connection', () => {
    expect(usageChartsState({ source: 'prometheus' }, true)).toBe('ready');
    expect(usageChartsState({ source: 'prometheus' }, false)).toBe('disconnected');
    expect(usageChartsState({ source: 'metrics-server' }, true)).toBe('metrics-server');
    expect(usageChartsState({ source: 'none' }, true)).toBe('no-source');
  });
  it('cover the scan window in days (1–30)', () => {
    expect(historyDays({ window_secs: 7 * 86_400 })).toBe(7);
    expect(historyDays({ window_secs: 3600 })).toBe(1);
    expect(historyDays({ window_secs: 90 * 86_400 })).toBe(30);
  });
  it('draw the current request, the recommendation and the current limit', () => {
    const c = container();
    expect(usageRefs(c, 'cpu')).toEqual([
      { key: 'request', value: 500 },
      { key: 'recommended', value: 120 },
      { key: 'limit', value: 1000 },
    ]);
    // No memory limit today: no limit line.
    expect(usageRefs(c, 'memory').map((r) => r.key)).toEqual(['request', 'recommended']);
    const unset = container({
      current: { cpu_request: null, cpu_limit: null, memory_request: null, memory_limit: null },
      recommended: { cpu_request: 0, cpu_limit: null, memory_request: null, memory_limit: null },
    });
    expect(usageRefs(unset, 'cpu')).toEqual([]);
  });
  it('summarize the samples', () => {
    const pts = [
      { t: 0, v: 1 },
      { t: 1, v: 5 },
      { t: 2, v: 3 },
    ];
    expect(meanOf(pts)).toBe(3);
    expect(maxOf(pts)).toBe(5);
    expect(meanOf([])).toBeNull();
    expect(maxOf([])).toBeNull();
  });
  it('write CPU with its unit', () => {
    expect(cpuValueText(250)).toBe('250m');
    expect(cpuValueText(1000)).toBe('1 core');
    expect(cpuValueText(1500)).toBe('1.5 cores');
  });
  it('name the step', () => {
    expect(stepText(3600)).toBe('One point per hour');
    expect(stepText(7200)).toBe('One point every 2 hours');
    expect(stepText(300)).toBe('One point every 5 minutes');
    expect(stepText(86_400)).toBe('One point per day');
  });
});

describe('trend', () => {
  const point = (at: number, cpu: number | null, extra = true): RecommendationTrendPoint => ({
    run_id: at,
    at,
    verdict: 'over',
    confidence: 'high',
    monthly_delta: -1,
    containers: extra
      ? [
          {
            name: 'app',
            cpu_request: 500,
            cpu_recommended: cpu,
            memory_request: 100,
            memory_recommended: 80,
            cpu_p95: 90,
            memory_max: 70,
          },
        ]
      : [],
  });
  it('picks one container and resource, leaving gaps for missing values', () => {
    const points = [
      point(0, 120),
      point(HOUR, null),
      point(2 * HOUR, 110, false),
      point(3 * HOUR, 100),
    ];
    const cpu = trendSeries(points, 'app', 'cpu');
    expect(cpu.request.map((p) => p.t)).toEqual([0, HOUR, 3 * HOUR]);
    expect(cpu.recommended).toEqual([
      { t: 0, v: 120 },
      { t: 3 * HOUR, v: 100 },
    ]);
    expect(cpu.usage.every((p) => p.v === 90)).toBe(true);
    const memory = trendSeries(points, 'app', 'memory');
    expect(memory.recommended[0]).toEqual({ t: 0, v: 80 });
    expect(memory.usage[0]).toEqual({ t: 0, v: 70 });
    expect(trendSeries(points, 'other', 'cpu').request).toEqual([]);
  });
  it('uses the widest spacing between an hour and a day as the interval', () => {
    expect(trendInterval([])).toBe(HOUR);
    expect(trendInterval([{ at: 0 }, { at: 15 * 60_000 }])).toBe(HOUR);
    expect(trendInterval([{ at: 0 }, { at: HOUR }, { at: DAY + HOUR }])).toBe(DAY);
    expect(trendInterval([{ at: 0 }, { at: 5 * DAY }])).toBe(DAY);
  });
  it('pads a single scan', () => {
    expect(trendRange([{ at: 10 * HOUR }])).toEqual({ from: 9 * HOUR, to: 11 * HOUR });
    expect(trendRange([{ at: 0 }, { at: DAY }])).toEqual({ from: 0, to: DAY });
  });
});

describe('evidence', () => {
  const evidence: UsageEvidence = {
    observed_hours: 72,
    cpu_coverage: 0.98,
    memory_coverage: 0.5,
    cpu_samples: 2016,
    memory_samples: 1008,
    pods: 3,
    duty: null,
    throttle_ratio: 0.12,
    oom_killed: true,
    partial: false,
    identity: 'owner-metrics',
  };
  it('lists what the numbers rest on', () => {
    const rows = evidenceRows(evidence);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.observed?.value).toBe('3 days');
    expect(byKey.coverage?.value).toBe('CPU 98% · memory 50%');
    expect(byKey.samples?.value).toBe('CPU 2,016 · memory 1,008');
    expect(byKey.pods?.value).toBe('3');
    expect(byKey.throttle).toMatchObject({ value: '12% of CFS periods', warn: true });
    // Below the throttling threshold it is only a number.
    const mild = evidenceRows({ ...evidence, throttle_ratio: 0.012 }, 5);
    expect(mild.find((r) => r.key === 'throttle')).toMatchObject({ warn: false });
    expect(evidenceRows(evidence, 20).find((r) => r.key === 'throttle')?.warn).toBe(false);
    expect(byKey.oom).toMatchObject({ value: 'Within the window', warn: true });
    expect(byKey.identity?.value).toBe('kube-state-metrics owners');
    expect(byKey.duty).toBeUndefined();
    expect(byKey.partial).toBeUndefined();
  });
  it('adds the duty cycle and partial data, and says when throttling was not measured', () => {
    const rows = evidenceRows({
      ...evidence,
      duty: 0.25,
      partial: true,
      throttle_ratio: null,
      oom_killed: false,
      cpu_coverage: null,
      observed_hours: 0,
      identity: 'name-match',
    });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.duty?.value).toBe('0.25');
    expect(byKey.partial?.warn).toBe(true);
    expect(byKey.throttle).toMatchObject({ value: 'Not measured', warn: false });
    expect(byKey.oom).toMatchObject({ value: 'None', warn: false });
    expect(byKey.coverage?.value).toBe('CPU — · memory 50%');
    expect(byKey.observed?.value).toBe('—');
    expect(byKey.identity?.value).toBe('Matched by pod name');
  });
  it('describes the autoscaler and its utilization targets', () => {
    const hpa = {
      name: 'web',
      min_replicas: 2,
      max_replicas: 10,
      metrics: [
        { resource: 'cpu' as const, target_utilization: 70 },
        { resource: 'memory' as const, target_utilization: null },
        { resource: 'other' as const, target_utilization: 50 },
      ],
    };
    expect(hpaText(hpa)).toBe(
      'Scaled by the HorizontalPodAutoscaler web between 2 and 10 replicas.',
    );
    expect(hpaText({ ...hpa, min_replicas: null })).toBe(
      'Scaled by the HorizontalPodAutoscaler web up to 10 replicas.',
    );
    expect(hpaTargets(hpa)).toEqual(['CPU target 70% of the request']);
  });
});

describe('trapTarget', () => {
  const items = ['a', 'b', 'c'];
  it('wraps Tab at both ends and lets the browser move in between', () => {
    expect(trapTarget(items, 'c', false)).toBe('a');
    expect(trapTarget(items, 'a', true)).toBe('c');
    expect(trapTarget(items, 'b', false)).toBeNull();
    expect(trapTarget(items, 'b', true)).toBeNull();
  });
  it('brings focus back in from outside the items', () => {
    expect(trapTarget(items, null, false)).toBe('a');
    expect(trapTarget(items, 'panel', true)).toBe('c');
    expect(trapTarget([], 'a', false)).toBeNull();
  });
});

describe('drawerAction', () => {
  const live = { past: false, connected: true };
  it('applies one-click rows, reviews the rest', () => {
    expect(drawerAction('one-click', live)).toEqual({
      kind: 'apply',
      label: 'Apply',
      disabled: null,
    });
    expect(drawerAction('review', live)).toEqual({
      kind: 'review',
      label: 'Review & apply',
      disabled: null,
    });
    expect(drawerAction('read-only', live)).toMatchObject({ kind: 'review', label: 'Review' });
    expect(drawerAction('none', live).kind).toBe('none');
  });
  it('applies nothing from a past run or while disconnected', () => {
    expect(drawerAction('one-click', { past: true, connected: true }).disabled).toMatch(
      /past scan/,
    );
    expect(drawerAction('review', { past: false, connected: false }).disabled).toMatch(/Connect/);
  });
  it('explains an RBAC denial, except for the read-only review', () => {
    const blocked = { ...live, blocked: "You don't have permission to patch deployments" };
    expect(drawerAction('one-click', blocked).disabled).toBe(blocked.blocked);
    expect(drawerAction('review', blocked).disabled).toBe(blocked.blocked);
    expect(drawerAction('read-only', blocked).disabled).toBeNull();
  });
});
