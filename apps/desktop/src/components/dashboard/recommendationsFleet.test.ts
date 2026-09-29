import { describe, expect, it } from 'vitest';
import type {
  ClusterDef,
  ClusterRecommendationSummary,
  ClusterStatus,
  RecommendationRun,
  RecommendationSummary,
  SummaryEntry,
} from '@/types';
import { fleetRecommendationRows, fleetSavings, fleetTop } from './recommendationsFleet';

const NOW = Date.UTC(2026, 8, 29, 12);
const HOUR = 3_600_000;

const cluster = (id: string, extra: Partial<ClusterDef> = {}): ClusterDef =>
  ({
    id,
    name: id,
    context: id,
    tags: [],
    read_only: false,
    environment: null,
    ...extra,
  }) as ClusterDef;

const entry = (
  name: string,
  monthly_delta: number,
  verdict: SummaryEntry['verdict'] = 'over',
): SummaryEntry => ({
  kind: 'Deployment',
  namespace: 'shop',
  name,
  verdict,
  confidence: 'high',
  monthly_delta,
  cpu_delta: 0,
  memory_delta: 0,
});

const summary = (extra: Partial<RecommendationSummary> = {}): RecommendationSummary =>
  ({
    workloads: 10,
    over: 4,
    under: 1,
    one_click: 3,
    monthly_savings: 120,
    currency: 'USD',
    top: [],
    ...extra,
  }) as RecommendationSummary;

const run = (
  cluster_id: string,
  finishedAt: number,
  extra: Partial<RecommendationRun> = {},
): RecommendationRun =>
  ({
    id: 1,
    cluster_id,
    started_at: finishedAt - 60_000,
    finished_at: finishedAt,
    status: 'success',
    trigger: 'schedule',
    error: null,
    summary: summary(),
    ...extra,
  }) as RecommendationRun;

const fleetEntry = (
  cluster_id: string,
  extra: Partial<ClusterRecommendationSummary> = {},
): ClusterRecommendationSummary => ({
  cluster_id,
  scheduled: false,
  source_changed: false,
  run: null,
  last_failure: null,
  ...extra,
});

const connected = { state: 'connected' } as ClusterStatus;

describe('fleet recommendations', () => {
  const clusters = [
    cluster('dev'),
    cluster('prod', { environment: 'production' }),
    cluster('ro', { read_only: true }),
    cluster('kind'),
    cluster('broken'),
    cluster('moved'),
  ];
  const fleet = [
    fleetEntry('dev', {
      run: run('dev', NOW - HOUR),
      last_failure: run('dev', NOW - 10 * 60_000, { status: 'failed', error: 'timed-out' }),
    }),
    fleetEntry('prod', { run: run('prod', NOW - 5 * HOUR) }),
    fleetEntry('ro', { run: run('ro', NOW - HOUR) }),
    fleetEntry('kind'),
    fleetEntry('broken', { last_failure: run('broken', NOW, { status: 'failed' }) }),
    fleetEntry('moved', { run: run('moved', NOW), source_changed: true }),
    fleetEntry('removed', { run: run('removed', NOW) }),
  ];
  const rows = fleetRecommendationRows(
    clusters,
    fleet,
    { dev: connected, prod: connected, ro: connected },
    60,
    NOW,
  );

  it('lists registered clusters with a stored success or failure, in registry order', () => {
    expect(rows.map((r) => r.cluster.id)).toEqual(['dev', 'prod', 'ro', 'broken', 'moved']);
    const dev = rows[0]!;
    expect(dev.failure?.error).toBe('timed-out');
    expect(dev.summary?.monthly_savings).toBe(120);
    expect(rows[3]!.run).toBeNull();
  });

  it('marks results stale when disconnected or older than twice the interval', () => {
    const stale = Object.fromEntries(rows.map((r) => [r.cluster.id, r.stale]));
    expect(stale).toEqual({ dev: false, prod: true, ro: false, broken: false, moved: true });
  });

  it('hides a summary whose source changed and counts one-click applies where they work', () => {
    const byId = Object.fromEntries(rows.map((r) => [r.cluster.id, r]));
    expect(byId.moved!.summary).toBeNull();
    expect(byId.moved!.sourceChanged).toBe(true);
    expect(byId.dev!.oneClick).toBe(3);
    expect(byId.prod!.oneClick).toBe(0);
    expect(byId.ro!.oneClick).toBe(0);
  });

  it('adds the savings per currency', () => {
    const mixed = fleetRecommendationRows(
      [cluster('a'), cluster('b'), cluster('c'), cluster('d')],
      [
        fleetEntry('a', { run: run('a', NOW, { summary: summary({ monthly_savings: 10 }) }) }),
        fleetEntry('b', { run: run('b', NOW, { summary: summary({ monthly_savings: 5.5 }) }) }),
        fleetEntry('c', {
          run: run('c', NOW, { summary: summary({ monthly_savings: 40, currency: 'EUR' }) }),
        }),
        fleetEntry('d', { run: run('d', NOW, { summary: summary({ monthly_savings: 0 }) }) }),
      ],
      {},
      60,
      NOW,
    );
    expect(fleetSavings(mixed)).toEqual([
      { currency: 'EUR', amount: 40 },
      { currency: 'USD', amount: 15.5 },
    ]);
    expect(fleetSavings([])).toEqual([]);
  });

  it('merges the spotlights by monthly delta, at most five, with stable ties', () => {
    const top = fleetTop(
      fleetRecommendationRows(
        [cluster('b'), cluster('a'), cluster('gone')],
        [
          fleetEntry('a', {
            run: run('a', NOW, {
              summary: summary({
                top: [entry('api', -30), entry('db', 12, 'under'), entry('web', -5)],
              }),
            }),
          }),
          fleetEntry('b', {
            run: run('b', NOW, {
              summary: summary({ top: [entry('api', -30), entry('cache', -80), entry('q', -1)] }),
            }),
          }),
          fleetEntry('gone', {
            source_changed: true,
            run: run('gone', NOW, { summary: summary({ top: [entry('huge', -999)] }) }),
          }),
        ],
        {},
        60,
        NOW,
      ),
    );
    expect(top.map((t) => `${t.clusterId}:${t.name}:${t.monthly_delta}`)).toEqual([
      'b:cache:-80',
      'a:api:-30',
      'b:api:-30',
      'a:web:-5',
      'b:q:-1',
    ]);
    expect(top[0]!.key).toBe('Deployment/shop/cache');
    expect(top[0]!.currency).toBe('USD');
  });
});
