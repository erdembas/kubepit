import { describe, expect, it } from 'vitest';
import { rankUsage } from '@/lib/kube/recommendations/model';
import { pageOf, searchRanking } from './rankingModel';
import { MiB, container, workload } from './testFixtures';

describe('searchRanking and pageOf', () => {
  const list = [
    workload('checkout', [
      container('app', [100, 100 * MiB], { memory_avg: 300 * MiB }),
      container('envoy', [100, 100 * MiB], { memory_avg: 50 * MiB }),
    ]),
    workload('ledger', [container('app', [100, 100 * MiB], { memory_avg: 0 })], {
      namespace: 'billing',
      kind: 'StatefulSet',
    }),
    workload('search', [container('app', [100, 100 * MiB], { memory_avg: 120 * MiB })]),
  ];
  const { rows } = rankUsage(list, 'memory', 'avg');

  it('matches every word in namespace, workload or container and keeps the rank', () => {
    expect(searchRanking(rows, '').map((r) => [r.rank, r.key])).toEqual([
      [1, 'Deployment/shop/checkout/app'],
      [2, 'Deployment/shop/search/app'],
      [3, 'Deployment/shop/checkout/envoy'],
      [4, 'StatefulSet/billing/ledger/app'],
    ]);
    expect(searchRanking(rows, 'ENVOY').map((r) => r.rank)).toEqual([3]);
    expect(searchRanking(rows, 'billing').map((r) => r.rank)).toEqual([4]);
    expect(searchRanking(rows, ' shop  app ').map((r) => r.rank)).toEqual([1, 2]);
    expect(searchRanking(rows, 'statefulset').map((r) => r.rank)).toEqual([4]);
    expect(searchRanking(rows, 'nothing')).toEqual([]);
  });

  it('never mutates the ranking', () => {
    const before = rows.map((r) => r.key);
    searchRanking(rows, 'app');
    expect(rows.map((r) => r.key)).toEqual(before);
  });

  it('pages rows and clamps the page', () => {
    const items = Array.from({ length: 19 }, (_, i) => i);
    expect(pageOf(items, 0)).toEqual({
      rows: [0, 1, 2, 3, 4, 5, 6, 7],
      page: 0,
      pages: 3,
      from: 1,
      to: 8,
    });
    expect(pageOf(items, 2)).toMatchObject({ rows: [16, 17, 18], page: 2, from: 17, to: 19 });
    expect(pageOf(items, 9)).toMatchObject({ page: 2, from: 17 });
    expect(pageOf(items, -1)).toMatchObject({ page: 0, from: 1 });
    expect(pageOf([], 3)).toEqual({ rows: [], page: 0, pages: 1, from: 0, to: 0 });
  });
});
