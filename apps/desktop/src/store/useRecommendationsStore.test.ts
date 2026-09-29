import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecommendationLatest, RecommendationRun, RecommendationScanStatus } from '@/types';

const ipc = vi.hoisted(() => ({
  recommendationsLatest: vi.fn(),
  recommendationsRuns: vi.fn(),
  recommendationsStatus: vi.fn(),
  recommendationsScan: vi.fn(),
}));

vi.mock('@/lib/ipc', () => ({ ipc, events: { onRecommendationScan: vi.fn() } }));

const { onScanEnded, useRecommendationsStore } = await import('./useRecommendationsStore');
const { rightsizingOrigin } = await import('@/lib/kube/recommendations/model');

const store = () => useRecommendationsStore.getState();
const entry = (id = 'c1') => store().byCluster[id]!;

function status(over: Partial<RecommendationScanStatus> = {}): RecommendationScanStatus {
  return {
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
  };
}

function run(id: number, startedAt = id * 1000): RecommendationRun {
  return {
    id,
    cluster_id: 'c1',
    started_at: startedAt,
    finished_at: startedAt + 10,
    status: 'success',
    trigger: 'schedule',
    error: null,
    source: 'prometheus',
    strategy: 'workload-history',
    window_secs: 604_800,
    workloads: 1,
    rows_kept: true,
    summary: null,
  };
}

function latest(runId: number | null, startedAt?: number): RecommendationLatest {
  return {
    scan:
      runId == null
        ? null
        : {
            run: run(runId, startedAt),
            report: { workloads: [] } as never,
            reevaluated: false,
            days_changed: false,
          },
    source_changed: false,
    last_failure: null,
  };
}

/** Let pending promise callbacks run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  useRecommendationsStore.setState({ byCluster: {}, generation: {} });
  for (const fn of Object.values(ipc)) fn.mockReset();
  ipc.recommendationsLatest.mockResolvedValue(latest(1));
  ipc.recommendationsRuns.mockResolvedValue([run(1)]);
});

describe('scan events', () => {
  it('reload the scan and the runs once when a scan ends', async () => {
    await store().load('c1');
    store().onScanEvent(status({ state: 'success', run_id: 1 }));
    await flush();
    ipc.recommendationsLatest.mockClear();
    ipc.recommendationsRuns.mockClear();

    store().onScanEvent(status({ state: 'queued', trigger: 'manual' }));
    store().onScanEvent(status({ state: 'running', run_id: 2 }));
    store().onScanEvent(
      status({ state: 'running', run_id: 2, progress: { completed: 4, total: 16, workloads: 3 } }),
    );
    expect(ipc.recommendationsLatest).not.toHaveBeenCalled();

    ipc.recommendationsLatest.mockResolvedValue(latest(2));
    store().onScanEvent(status({ state: 'success', run_id: 2 }));
    // `next_at` and `scheduled` updates repeat the terminal state.
    store().onScanEvent(status({ state: 'success', run_id: 2, next_at: 99 }));
    store().onScanEvent(status({ state: 'success', run_id: 2, scheduled: false }));
    await flush();
    expect(ipc.recommendationsLatest).toHaveBeenCalledTimes(1);
    expect(ipc.recommendationsRuns).toHaveBeenCalledTimes(1);
    expect(entry().latest?.scan?.run.id).toBe(2);
    expect(entry().status?.scheduled).toBe(false);
  });

  it('reload after failures and interruptions, and after another run with the same state', async () => {
    await store().load('c1');
    store().onScanEvent(status({ state: 'failed', run_id: 3, error: 'no-usage-source' }));
    store().onScanEvent(status({ state: 'failed', run_id: 4, error: 'timed-out' }));
    store().onScanEvent(status({ state: 'interrupted', run_id: 5, error: 'stopped' }));
    await flush();
    // The first load plus one per ended scan.
    expect(ipc.recommendationsLatest).toHaveBeenCalledTimes(4);
  });

  it('only keep the status of clusters no view has loaded', async () => {
    store().onScanEvent(status({ cluster_id: 'c2', state: 'success', run_id: 7 }));
    await flush();
    expect(ipc.recommendationsLatest).not.toHaveBeenCalled();
    expect(entry('c2').status?.run_id).toBe(7);
  });

  it('leave right-sizing elsewhere pending until the scans were read, not live', async () => {
    const origin = (id: string) => {
      const e = store().byCluster[id]!;
      return rightsizingOrigin({
        report: e.latest?.scan?.report ?? null,
        latest: e.latest,
        error: e.error,
      }).origin;
    };
    // A status event (as on connect) creates the entry before any read.
    store().onScanEvent(status({ cluster_id: 'c2', state: 'idle' }));
    expect(entry('c2').loading).toBe(false);
    expect(origin('c2')).toBe('pending');
    ipc.recommendationsLatest.mockResolvedValueOnce(latest(null));
    await store().load('c2');
    expect(origin('c2')).toBe('live');
    await store().load('c1');
    expect(origin('c1')).toBe('stored');
  });

  it('treat a first read of the status as the baseline, not as a change', async () => {
    ipc.recommendationsStatus.mockResolvedValue(status({ state: 'success', run_id: 1 }));
    await store().load('c1');
    await store().loadStatus('c1');
    await flush();
    expect(ipc.recommendationsLatest).toHaveBeenCalledTimes(1);
  });
});

describe('scan now', () => {
  it('re-reads the status instead of keeping a refusal message', async () => {
    ipc.recommendationsScan.mockRejectedValue(new Error('wait 42 s before scanning again'));
    ipc.recommendationsStatus.mockResolvedValue(
      status({ state: 'success', run_id: 1, manual_available_at: 5_000 }),
    );
    await store().scanNow('c1');
    expect(entry().status?.manual_available_at).toBe(5_000);
    expect(entry().error).toBeNull();
  });

  it('never lets its answer overwrite a newer event', async () => {
    let answer!: (s: RecommendationScanStatus) => void;
    ipc.recommendationsScan.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const pending = store().scanNow('c1');
    store().onScanEvent(status({ state: 'running', run_id: 9 }));
    answer(status({ state: 'queued', trigger: 'manual' }));
    await pending;
    expect(entry().status?.state).toBe('running');
  });
});

describe('loading', () => {
  it('drops answers older than the newest request', async () => {
    let first!: (l: RecommendationLatest) => void;
    ipc.recommendationsLatest
      .mockReturnValueOnce(new Promise((resolve) => (first = resolve)))
      .mockResolvedValueOnce(latest(2));
    const a = store().load('c1');
    const b = store().load('c1');
    await b;
    first(latest(1));
    await a;
    expect(entry().latest?.scan?.run.id).toBe(2);
  });

  it('keeps the latest while a past run is picked, and falls back when it is gone', async () => {
    await store().load('c1');
    ipc.recommendationsLatest.mockImplementation(async (_id: string, runId: number | null) =>
      latest(runId ?? 1),
    );
    await store().selectRun('c1', 5);
    expect(entry().runId).toBe(5);
    expect(entry().past?.scan?.run.id).toBe(5);
    expect(entry().latest?.scan?.run.id).toBe(1);

    ipc.recommendationsLatest.mockRejectedValue(new Error('scan 6 is no longer stored'));
    await store().selectRun('c1', 6);
    expect(entry().runId).toBeNull();
    expect(entry().past).toBeNull();
    expect(entry().error).toBeNull();
  });

  it('forgets applied rows once a scan that started later is loaded', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    store().markApplied('c1', 'Deployment/shop/web');
    vi.mocked(Date.now).mockReturnValue(20_000);
    store().markApplied('c1', 'Deployment/shop/api');
    vi.mocked(Date.now).mockRestore();

    ipc.recommendationsLatest.mockResolvedValue(latest(3, 10_000));
    await store().load('c1');
    expect(entry().applied).toEqual({ 'Deployment/shop/api': 20_000 });
  });
});

describe('scan-ended hook, ordering and forgetting', () => {
  it('tells listeners about every ended scan, also of clusters no view loaded', async () => {
    const seen: string[] = [];
    const off = onScanEnded((s) => seen.push(`${s.cluster_id}:${s.state}:${s.run_id}`));
    store().onScanEvent(status({ cluster_id: 'c9', state: 'running', run_id: 4 }));
    store().onScanEvent(status({ cluster_id: 'c9', state: 'success', run_id: 4 }));
    store().onScanEvent(status({ cluster_id: 'c9', state: 'success', run_id: 4, next_at: 5 }));
    off();
    store().onScanEvent(status({ cluster_id: 'c9', state: 'failed', run_id: 5 }));
    expect(seen).toEqual(['c9:success:4']);
    expect(ipc.recommendationsLatest).not.toHaveBeenCalled();
  });

  it('reads the runs only after the latest scan, so the new run is never listed as past', async () => {
    await store().load('c1');
    const order: string[] = [];
    let answer!: (l: RecommendationLatest) => void;
    ipc.recommendationsLatest.mockImplementation(
      () => new Promise((resolve) => (answer = (l) => (order.push('latest'), resolve(l)))),
    );
    ipc.recommendationsRuns.mockImplementation(async () => (order.push('runs'), [run(2), run(1)]));
    store().onScanEvent(status({ state: 'success', run_id: 2 }));
    await flush();
    expect(order).toEqual([]);
    answer(latest(2));
    await flush();
    expect(order).toEqual(['latest', 'runs']);
    expect(entry().runs.map((r) => r.id)).toEqual([2, 1]);
  });

  it('drops runs answers older than the newest request', async () => {
    let first!: (runs: RecommendationRun[]) => void;
    ipc.recommendationsRuns
      .mockReturnValueOnce(new Promise((resolve) => (first = resolve)))
      .mockResolvedValueOnce([run(3), run(2)]);
    const a = store().loadRuns('c1');
    await store().loadRuns('c1');
    first([run(1)]);
    await a;
    expect(entry().runs.map((r) => r.id)).toEqual([3, 2]);
  });

  it('forget drops the entry, ignores answers in flight and bumps the generation', async () => {
    await store().load('c1');
    let late!: (l: RecommendationLatest) => void;
    ipc.recommendationsLatest.mockReturnValueOnce(new Promise((resolve) => (late = resolve)));
    const pending = store().load('c1');
    store().forget('c1');
    late(latest(9));
    await pending;
    expect(store().byCluster.c1).toBeUndefined();
    expect(store().generation.c1).toBe(1);
  });
});
