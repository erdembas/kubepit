import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClusterDef, WorkloadRecommendation } from '@/types';
import { clusterDef, dryRunOf, liveOf, oneClickRow } from './applyTestKit';
import { MiB, container, recommend, workload } from './testFixtures';

const rightsizingApply = vi.hoisted(() => vi.fn());
const refreshRightsizing = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ipc', () => ({
  ipc: { rightsizingApply },
  events: { onRecommendationScan: vi.fn() },
}));
vi.mock('../cost/useCost', () => ({ refreshRightsizing }));

const { useAppStore } = await import('@/store/useAppStore');
const { useRecommendationsStore } = await import('@/store/useRecommendationsStore');
const { applyRefusal, exclusiveApply, isApplying, liveDrifted, quickApply, rightsizeAction } =
  await import('./quickApply');

const pushToast = vi.fn();

function setCluster(
  over: Partial<ClusterDef> = {},
  state: 'connected' | 'disconnected' = 'connected',
) {
  useAppStore.setState({
    clusters: [clusterDef(over)],
    statuses: { c1: { state } } as never,
    pushToast,
  });
}

/** The backend: dry runs answer with `live`, patches succeed. */
function backend(rec: WorkloadRecommendation, live = liveOf(rec)) {
  rightsizingApply.mockImplementation(async () => dryRunOf(live));
}

const calls = () =>
  rightsizingApply.mock.calls.map(([cluster, target, changes, dryRun]) => ({
    cluster,
    target,
    changes,
    dryRun,
  }));

beforeEach(() => {
  rightsizingApply.mockReset();
  refreshRightsizing.mockReset();
  pushToast.mockReset();
  useRecommendationsStore.setState({ byCluster: {} });
  setCluster();
});

describe('quickApply', () => {
  it('dry-runs, then applies the same changes with a toast and marks the row applied', async () => {
    const rec = oneClickRow();
    backend(rec);
    await expect(quickApply('c1', rec)).resolves.toBe('applied');
    const [dry, patch] = calls();
    expect(calls()).toHaveLength(2);
    expect(dry).toMatchObject({ cluster: 'c1', dryRun: true });
    expect(dry!.target).toEqual({ kind: 'Deployment', namespace: 'shop', name: 'web' });
    expect(patch).toMatchObject({ cluster: 'c1', dryRun: false, target: dry!.target });
    expect(patch!.changes).toEqual(dry!.changes);
    expect(patch!.changes).toEqual([
      {
        container: 'app',
        cpu_request: 200,
        cpu_limit: null,
        memory_request: 256 * MiB,
        memory_limit: null,
      },
    ]);
    expect(pushToast).toHaveBeenCalledWith('success', 'Right-sized web');
    expect(useRecommendationsStore.getState().byCluster.c1?.applied['Deployment/shop/web']).toEqual(
      expect.any(Number),
    );
    expect(refreshRightsizing).toHaveBeenCalledWith('c1');
  });

  it('opens the review when the dry run fails, and never applies', async () => {
    const rec = oneClickRow();
    rightsizingApply.mockRejectedValue(new Error('admission webhook denied the request'));
    await expect(quickApply('c1', rec)).resolves.toBe('review');
    expect(calls().map((c) => c.dryRun)).toEqual([true]);
    expect(pushToast).not.toHaveBeenCalled();
    expect(useRecommendationsStore.getState().byCluster.c1?.applied ?? {}).toEqual({});
  });

  it('opens the review for an error answer instead of a thrown one', async () => {
    const rec = oneClickRow();
    rightsizingApply.mockResolvedValue({ ...dryRunOf(liveOf(rec)), error: 'forbidden' });
    await expect(quickApply('c1', rec)).resolves.toBe('review');
    expect(calls().map((c) => c.dryRun)).toEqual([true]);
  });

  it.each<[string, Partial<ClusterDef>, 'connected' | 'disconnected']>([
    ['read-only', { read_only: true }, 'connected'],
    ['production', { environment: 'production' }, 'connected'],
    ['disconnected', {}, 'disconnected'],
  ])('never touches a %s cluster', async (_, over, state) => {
    setCluster(over, state);
    const rec = oneClickRow();
    backend(rec);
    await expect(quickApply('c1', rec)).resolves.toBe('review');
    expect(rightsizingApply).not.toHaveBeenCalled();
  });

  it('never touches an unknown cluster or a past run', async () => {
    const rec = oneClickRow();
    backend(rec);
    await expect(quickApply('gone', rec)).resolves.toBe('review');
    useRecommendationsStore.setState({ byCluster: { c1: { runId: 7, applied: {} } as never } });
    await expect(quickApply('c1', rec)).resolves.toBe('review');
    expect(rightsizingApply).not.toHaveBeenCalled();
  });

  it('reviews rows that are not one-click: below high confidence, a raised limit, no change', async () => {
    const base = oneClickRow();
    const raised = workload('api', [{ ...base.containers[0]!, cpu_limit_raised: true }], {
      verdict: 'over',
    });
    for (const rec of [
      oneClickRow('web', { confidence: 'medium' }),
      raised,
      oneClickRow('web', { changed: false }),
    ]) {
      await expect(quickApply('c1', rec)).resolves.toBe('review');
    }
    expect(rightsizingApply).not.toHaveBeenCalled();
  });

  it('reviews a workload edited since the scan or owned by GitOps', async () => {
    const rec = oneClickRow();
    backend(rec, liveOf(rec, { cpu: '800m', memory: '512Mi' }));
    await expect(quickApply('c1', rec)).resolves.toBe('review');
    backend(
      rec,
      liveOf(rec, undefined, {
        labels: {
          'kustomize.toolkit.fluxcd.io/name': 'apps',
          'kustomize.toolkit.fluxcd.io/namespace': 'flux-system',
        },
      }),
    );
    await expect(quickApply('c1', rec)).resolves.toBe('review');
    expect(calls().map((c) => c.dryRun)).toEqual([true, true]);
  });

  it('applies a row once when it is clicked twice', async () => {
    const rec = oneClickRow();
    backend(rec);
    const first = quickApply('c1', rec);
    const second = quickApply('c1', rec);
    expect(isApplying('c1', 'Deployment/shop/web')).toBe(true);
    await expect(Promise.all([first, second])).resolves.toEqual(['applied', 'applied']);
    expect(calls().map((c) => c.dryRun)).toEqual([true, false]);
    expect(isApplying('c1', 'Deployment/shop/web')).toBe(false);
    // Applied in this session: nothing is sent again until the next scan.
    await expect(quickApply('c1', rec)).resolves.toBe('applied');
    expect(calls()).toHaveLength(2);
  });

  it('reviews after a failed patch, with the error toast, and does not mark it applied', async () => {
    const rec = oneClickRow();
    rightsizingApply.mockImplementation(async (_c, _t, _ch, dryRun: boolean) => {
      if (!dryRun) throw new Error('conflict');
      return dryRunOf(liveOf(rec));
    });
    await expect(quickApply('c1', rec)).resolves.toBe('review');
    expect(pushToast).toHaveBeenCalledWith('error', 'conflict');
    expect(useRecommendationsStore.getState().byCluster.c1?.applied ?? {}).toEqual({});
  });

  it('does not apply when the cluster turned read-only during the dry run', async () => {
    const rec = oneClickRow();
    rightsizingApply.mockImplementation(async () => {
      setCluster({ read_only: true });
      return dryRunOf(liveOf(rec));
    });
    await expect(quickApply('c1', rec)).resolves.toBe('review');
    expect(calls().map((c) => c.dryRun)).toEqual([true]);
  });

  it('returns the running apply of a row a batch is applying', async () => {
    const rec = oneClickRow();
    let finish: (v: 'applied') => void = () => {};
    const batch = exclusiveApply(
      'c1',
      'Deployment/shop/web',
      () => new Promise((r) => (finish = r)),
    );
    const click = quickApply('c1', rec);
    finish('applied');
    await expect(click).resolves.toBe('applied');
    await batch;
    expect(rightsizingApply).not.toHaveBeenCalled();
  });
});

describe('applyRefusal', () => {
  it('names why a row needs the review', () => {
    const rec = oneClickRow();
    expect(applyRefusal('c1', rec)).toBeNull();
    setCluster({ read_only: true });
    expect(applyRefusal('c1', rec)).toBe('read-only');
    setCluster({ environment: 'production' });
    expect(applyRefusal('c1', rec)).toBe('production');
    setCluster({}, 'disconnected');
    expect(applyRefusal('c1', rec)).toBe('disconnected');
    setCluster();
    expect(applyRefusal('c1', oneClickRow('web', { confidence: 'low' }))).toBe('not-one-click');
    expect(applyRefusal('other', rec)).toBe('unknown-cluster');
  });
});

describe('liveDrifted', () => {
  const rec = oneClickRow();
  const changes = [
    {
      container: 'app',
      cpu_request: 200,
      cpu_limit: null,
      memory_request: 256 * MiB,
      memory_limit: null,
    },
  ];

  it('accepts the values the scan saw, in any notation', () => {
    expect(liveDrifted(rec, changes, liveOf(rec))).toBe(false);
    expect(liveDrifted(rec, changes, liveOf(rec, { cpu: '0.5', memory: '536870912' }))).toBe(false);
  });

  it('flags edited values, added limits and missing containers', () => {
    expect(liveDrifted(rec, changes, liveOf(rec, { cpu: '600m', memory: '512Mi' }))).toBe(true);
    expect(liveDrifted(rec, changes, liveOf(rec, { cpu: '500m' }))).toBe(true);
    const renamed = liveOf(workload('web', [container('sidecar', [500, 512 * MiB], null)]));
    expect(liveDrifted(rec, changes, renamed)).toBe(true);
  });

  it('reads the job template of a CronJob', () => {
    const cron = { ...rec, kind: 'CronJob' };
    expect(liveDrifted(cron, changes, liveOf(cron))).toBe(false);
    expect(liveDrifted(cron, changes, liveOf(cron, { cpu: '1', memory: '512Mi' }))).toBe(true);
  });
});

describe('rightsizeAction', () => {
  it('checks patch on the workload, or per kind and namespace', () => {
    const rec = recommend(container('app', [500, null], null), [200, null]);
    const w = workload('web', [rec]);
    expect(rightsizeAction(w)).toMatchObject({ id: 'Deployment/shop/web', mutating: true });
    expect(JSON.stringify(rightsizeAction(w).access)).toContain('"verb":"patch"');
    expect(JSON.stringify(rightsizeAction(w).access)).toContain('"name":"web"');
    const nameless = rightsizeAction(w, { named: false });
    expect(nameless.id).toBe('Deployment/shop');
    expect(JSON.stringify(nameless.access)).not.toContain('"name":"web"');
  });
});
