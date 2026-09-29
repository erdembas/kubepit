import { describe, expect, it } from 'vitest';
import {
  MiB,
  container,
  recommend,
  workload,
} from '@/components/workbench/recommendations/testFixtures';
import { ruleDef, ruleTitle, scanHealth } from '@/lib/kube/health';
import type {
  ContainerRecommendation,
  KubeObject,
  RightsizingReport,
  UsageEvidence,
  WorkloadRecommendation,
} from '@/types';
import { throttledContainer } from './rightsizing';
import { emptyHealthInput } from './testing';

const object = (kind: string, name: string, ns = 'shop'): KubeObject => ({
  apiVersion: kind === 'CronJob' ? 'batch/v1' : 'apps/v1',
  kind,
  metadata: { name, namespace: ns, uid: `${kind}-${ns}-${name}` },
  spec: {},
});

const evidence = (throttle: number | null): UsageEvidence => ({
  observed_hours: 168,
  cpu_coverage: 1,
  memory_coverage: 1,
  cpu_samples: 2000,
  memory_samples: 2000,
  pods: 2,
  duty: null,
  throttle_ratio: throttle,
  oom_killed: false,
  partial: false,
  identity: 'owner-metrics',
});

/** A container throttled in `ratio` of its CFS periods (the flag caps it at medium). */
const throttled = (
  name: string,
  ratio: number | null,
  extra: Partial<ContainerRecommendation> = {},
): ContainerRecommendation =>
  container(
    name,
    [500, 256 * MiB],
    { cpu_p95: 400, memory_max: 200 * MiB },
    {
      confidence: 'medium',
      warnings: [
        {
          code: 'cpu-throttled',
          detail: ratio == null ? '7.5%' : `${(ratio * 100).toFixed(1)}%`,
        },
      ],
      evidence: evidence(ratio),
      ...extra,
    },
  );

const balanced = (name: string, containers: ContainerRecommendation[], kind = 'Deployment') =>
  workload(name, containers, {
    kind,
    verdict: 'balanced',
    confidence: 'medium',
    changed: false,
  });

/** Over-provisioned enough for `workload-overprovisioned` (see `healthVerdict`). */
const oversized = (name: string, containers: ContainerRecommendation[] = []) =>
  workload(
    name,
    [
      recommend(container('app', [2000, 4096 * MiB], { cpu_p95: 100, memory_max: 300 * MiB }), [
        200,
        512 * MiB,
      ]),
      ...containers,
    ],
    { verdict: 'over', confidence: 'high', monthly_current: 100, monthly_delta: -80 },
  );

const report = (workloads: WorkloadRecommendation[]) =>
  ({
    source: 'prometheus',
    window_secs: 7 * 86_400,
    currency: 'USD',
    workloads,
    computed_at: 0,
  }) as unknown as RightsizingReport;

function findings(workloads: WorkloadRecommendation[], objects: KubeObject[], rule: string) {
  const scan = scanHealth(
    emptyHealthInput({
      deployments: objects.filter((o) => o.kind === 'Deployment'),
      statefulSets: objects.filter((o) => o.kind === 'StatefulSet'),
      cronJobs: objects.filter((o) => o.kind === 'CronJob'),
      rightsizing: report(workloads),
    }),
  );
  return scan.findings
    .filter((f) => f.ruleId === rule)
    .map((f) => ({ ref: `${f.ref.kind}/${f.ref.namespace}/${f.ref.name}`, message: f.message }));
}

describe('workload-cpu-throttled', () => {
  it('is a warning in the efficiency category that needs no list', () => {
    const def = ruleDef('workload-cpu-throttled');
    expect(def).toMatchObject({ category: 'efficiency', severity: 'warning', needs: [] });
    expect(ruleTitle('workload-cpu-throttled')).toBe('Workloads throttled by their CPU limit');
    expect(def?.hint()).toBe('Raise or remove the CPU limit; the request stays as recommended.');
  });

  it('fires once per throttled workload, naming its most throttled container', () => {
    const web = balanced('web', [throttled('app', 0.083), throttled('proxy', 0.12)]);
    const api = balanced('api', [throttled('api', 0.064)]);
    expect(
      findings(
        [web, api],
        [object('Deployment', 'web'), object('Deployment', 'api')],
        'workload-cpu-throttled',
      ),
    ).toEqual([
      {
        ref: 'Deployment/shop/web',
        message: 'Container proxy is throttled in 12% of CPU periods.',
      },
      {
        ref: 'Deployment/shop/api',
        message: 'Container api is throttled in 6.4% of CPU periods.',
      },
    ]);
  });

  it('skips low-confidence containers and workloads without the flag', () => {
    const low = balanced('low', [throttled('app', 0.2, { confidence: 'low' })]);
    const clean = balanced('clean', [container('app', [100, 64 * MiB], { cpu_p95: 50 })]);
    // A low-confidence sidecar does not hide the throttled container beside it.
    const mixed = balanced('mixed', [
      container('sidecar', [10, 32 * MiB], null, { confidence: 'low' }),
      throttled('app', 0.09),
    ]);
    const objects = ['low', 'clean', 'mixed'].map((n) => object('Deployment', n));
    expect(findings([low, clean, mixed], objects, 'workload-cpu-throttled')).toEqual([
      {
        ref: 'Deployment/shop/mixed',
        message: 'Container app is throttled in 9.0% of CPU periods.',
      },
    ]);
    expect(throttledContainer(low)).toBeNull();
    expect(throttledContainer(mixed)?.name).toBe('app');
  });

  it('uses the flag detail without a measured ratio', () => {
    const web = balanced('web', [throttled('app', null)]);
    expect(findings([web], [object('Deployment', 'web')], 'workload-cpu-throttled')).toEqual([
      { ref: 'Deployment/shop/web', message: 'Container app is throttled in 7.5% of CPU periods.' },
    ]);
  });

  it('covers CronJobs and only workloads the scope lists', () => {
    const job = balanced('nightly', [throttled('job', 0.3)], 'CronJob');
    const gone = balanced('gone', [throttled('app', 0.3)]);
    expect(findings([job, gone], [object('CronJob', 'nightly')], 'workload-cpu-throttled')).toEqual(
      [
        {
          ref: 'CronJob/shop/nightly',
          message: 'Container job is throttled in 30% of CPU periods.',
        },
      ],
    );
  });

  it('keeps the over-provisioned finding of a throttled workload', () => {
    const web = oversized('web', [throttled('proxy', 0.1)]);
    const objects = [object('Deployment', 'web')];
    expect(findings([web], objects, 'workload-cpu-throttled')).toHaveLength(1);
    expect(findings([web], objects, 'workload-overprovisioned')).toEqual([
      {
        ref: 'Deployment/shop/web',
        message:
          'Requests could shrink by 80% based on 7 days of usage, saving about $80.00 a month.',
      },
    ]);
  });
});
