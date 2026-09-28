import { beforeAll, describe, expect, it } from 'vitest';
import type { KubeObject } from '@/types';
import type * as Cost from './cost';
import type * as Db from './fixtures/db';
import type * as Fixtures from './fixtures/cost';

// The demo backend right-sizes CronJobs like the backend: their pod spec is
// the job template's, one replica each, and with Prometheus usage their cost
// follows the duty cycle carried by the usage evidence.

const MiB = 1024 ** 2;
const CLUSTER = 'c-prod-eu';
const TARGET = { kind: 'CronJob', namespace: 'data', name: 'report-generator' };

let cost: typeof Cost;
let db: typeof Db;
let fixtures: typeof Fixtures;

beforeAll(async () => {
  await import('./fixtures/build');
  db = await import('./fixtures/db');
  fixtures = await import('./fixtures/cost');
  cost = await import('./cost');
});

function recommendation(source: 'prometheus' | 'metrics-server') {
  const list = fixtures.workloadRecommendations(
    db.getDb(CLUSTER),
    source,
    fixtures.DEFAULT_SETTINGS,
    fixtures.defaultPricing('generic'),
    { namespaces: [], workload: TARGET },
  );
  expect(list).toHaveLength(1);
  return list[0]!;
}

describe('demo right-sizing of CronJobs', () => {
  it('recommends the job template at the duty cycle', () => {
    const rec = recommendation('prometheus');
    expect(rec).toMatchObject({ kind: 'CronJob', name: 'report-generator', replicas: 1 });
    expect(rec.containers.map((c) => c.name)).toEqual(['report']);
    expect(rec.containers[0]!.current.cpu_request).toBe(500);
    expect(rec.cost_replicas).toBeGreaterThan(0);
    expect(rec.cost_replicas).toBeLessThan(1);
    expect(rec.containers[0]!.evidence?.duty).toBe(rec.cost_replicas);
    // Without evidence (metrics-server) a CronJob costs one replica.
    const snapshot = recommendation('metrics-server');
    expect(snapshot.cost_replicas).toBe(1);
    expect(snapshot.containers[0]!.evidence).toBeNull();
  });

  it('lists CronJobs among the workloads in scope', () => {
    const kinds = fixtures
      .workloadRecommendations(
        db.getDb(CLUSTER),
        'prometheus',
        fixtures.DEFAULT_SETTINGS,
        fixtures.defaultPricing('generic'),
        { namespaces: ['data'], workload: null },
      )
      .map((r) => `${r.kind}/${r.name}`);
    expect(kinds).toContain('CronJob/nightly-backup');
    expect(kinds).toContain('Deployment/etl-worker');
  });

  it('patches CronJobs at spec.jobTemplate.spec.template', () => {
    const live = db.find(db.getDb(CLUSTER), 'cronjobs.batch', TARGET.namespace, TARGET.name)!;
    const before = structuredClone(live);
    const next = cost.patched(live, [
      {
        container: 'report',
        cpu_request: 120,
        cpu_limit: null,
        memory_request: 256 * MiB,
        memory_limit: null,
      },
    ]);
    const containers = (
      next.spec as { jobTemplate: { spec: { template: { spec: { containers: KubeObject[] } } } } }
    ).jobTemplate.spec.template.spec.containers;
    expect(containers[0]).toMatchObject({
      name: 'report',
      resources: { requests: { cpu: '120m', memory: '256Mi' } },
    });
    expect(next.metadata.annotations?.['kubernetes.io/change-cause']).toBe(
      'kubepit right-size cronjob/report-generator',
    );
    expect(live).toEqual(before);
    expect(() =>
      cost.patched(live, [
        {
          container: 'nope',
          cpu_request: 120,
          cpu_limit: null,
          memory_request: null,
          memory_limit: null,
        },
      ]),
    ).toThrow('has no container "nope"');
  });
});
