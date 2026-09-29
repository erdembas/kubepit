import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workloadKey } from '@/lib/kube/recommendations/model';
import type { ClusterDef, ContainerResourceChange, WorkloadRef } from '@/types';
import { clusterDef, dryRunOf, liveOf, oneClickRow } from './applyTestKit';

const rightsizingApply = vi.hoisted(() => vi.fn());
const refreshRightsizing = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ipc', () => ({
  ipc: { rightsizingApply },
  events: { onRecommendationScan: vi.fn() },
}));
vi.mock('../cost/useCost', () => ({ refreshRightsizing }));

const { useAppStore } = await import('@/store/useAppStore');
const { useRecommendationsStore } = await import('@/store/useRecommendationsStore');
const { batchCounts, batchTargets, createBatchSession } = await import('./batchApply');
const { exclusiveApply } = await import('./quickApply');

const pushToast = vi.fn();

function setCluster(over: Partial<ClusterDef> = {}, state = 'connected') {
  useAppStore.setState({
    clusters: [clusterDef(over)],
    statuses: { c1: { state } } as never,
    pushToast,
  });
}

const web = oneClickRow('web');
const api = oneClickRow('api');
const db = oneClickRow('db');

interface Call {
  name: string;
  changes: ContainerResourceChange[];
  dryRun: boolean;
}
let log: Call[] = [];
let inFlight = 0;
let maxInFlight = 0;

/**
 * The backend: records every call, answers dry runs with the live object
 * the scan saw; `fail` names workloads whose dry run (or `patchFail` patch)
 * is refused; `onCall` runs before answering.
 */
function backend({
  fail = [] as string[],
  patchFail = [] as string[],
  onCall = (_: Call) => {},
} = {}) {
  rightsizingApply.mockImplementation(
    async (
      _c: string,
      target: WorkloadRef,
      changes: ContainerResourceChange[],
      dryRun: boolean,
    ) => {
      const call = { name: target.name, changes, dryRun };
      log.push(call);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      onCall(call);
      if (dryRun && fail.includes(target.name)) throw new Error(`${target.name} is invalid`);
      if (!dryRun && patchFail.includes(target.name)) throw new Error('conflict');
      const rec = [web, api, db].find((r) => r.name === target.name)!;
      return dryRunOf(liveOf(rec));
    },
  );
}

const states = (s: {
  getState: () => { rows: readonly { rec: { name: string }; state: string }[] };
}) => Object.fromEntries(s.getState().rows.map((r) => [r.rec.name, r.state]));

beforeEach(() => {
  rightsizingApply.mockReset();
  refreshRightsizing.mockReset();
  pushToast.mockReset();
  useRecommendationsStore.setState({ byCluster: {} });
  setCluster();
  log = [];
  inFlight = 0;
  maxInFlight = 0;
});

describe('batchTargets', () => {
  const keys = (list: { name: string }[]) => list.map((r) => r.name);
  const all = new Set([web, api, db].map(workloadKey));

  it('keeps only checked rows still shown that are one-click and not applied', () => {
    const medium = oneClickRow('medium', { confidence: 'medium' });
    const shown = [web, api, medium];
    const selected = new Set([...all, workloadKey(medium)]);
    // `db` is checked but hidden by the filters; `medium` needs the review.
    expect(keys(batchTargets(shown, selected, clusterDef(), {}))).toEqual(['web', 'api']);
    expect(keys(batchTargets(shown, new Set([workloadKey(web)]), clusterDef(), {}))).toEqual([
      'web',
    ]);
    expect(
      keys(batchTargets(shown, selected, clusterDef(), { [workloadKey(web)]: Date.now() })),
    ).toEqual(['api']);
  });

  it('leaves out rows the list already knows are denied by RBAC', () => {
    const denied = (rec: { name: string }) =>
      rec.name === 'api' ? "You don't have permission to patch deployments.apps in shop" : null;
    expect(keys(batchTargets([web, api, db], all, clusterDef(), {}, denied))).toEqual([
      'web',
      'db',
    ]);
  });

  it('offers nothing on read-only, production or unknown clusters', () => {
    expect(batchTargets([web], all, clusterDef({ read_only: true }), {})).toEqual([]);
    expect(batchTargets([web], all, clusterDef({ environment: 'production' }), {})).toEqual([]);
    expect(batchTargets([web], all, undefined, {})).toEqual([]);
  });
});

describe('createBatchSession', () => {
  it('dry-runs one row at a time, then applies only the rows that passed', async () => {
    backend({ fail: ['api'] });
    const session = createBatchSession('c1', [web, api, db]);
    expect(states(session)).toEqual({ web: 'waiting', api: 'waiting', db: 'waiting' });
    await session.check();
    expect(maxInFlight).toBe(1);
    expect(states(session)).toEqual({ web: 'ready', api: 'rejected', db: 'ready' });
    expect(session.getState().rows[1]!.message).toBe('api is invalid');
    expect(log.every((c) => c.dryRun)).toBe(true);

    await session.apply();
    expect(maxInFlight).toBe(1);
    const patches = log.filter((c) => !c.dryRun);
    expect(patches.map((c) => c.name)).toEqual(['web', 'db']);
    // Each patch writes exactly what its dry run checked.
    for (const p of patches)
      expect(log.find((c) => c.dryRun && c.name === p.name)!.changes).toEqual(p.changes);
    expect(states(session)).toEqual({ web: 'applied', api: 'rejected', db: 'applied' });
    expect(session.getState().phase).toBe('done');
    const applied = useRecommendationsStore.getState().byCluster.c1!.applied;
    expect(Object.keys(applied).sort()).toEqual([workloadKey(db), workloadKey(web)].sort());
    expect(pushToast).toHaveBeenCalledWith('success', 'Right-sized 2 workloads');
    expect(refreshRightsizing).toHaveBeenCalledWith('c1');
  });

  it('applies nothing before its dry runs finished, and each row once on a double click', async () => {
    backend();
    const session = createBatchSession('c1', [web, api]);
    await session.apply();
    expect(log).toEqual([]);
    await session.check();
    await Promise.all([session.apply(), session.apply()]);
    await session.apply();
    expect(log.filter((c) => !c.dryRun).map((c) => c.name)).toEqual(['web', 'api']);
  });

  it.each<[string, Partial<ClusterDef>]>([
    ['read-only', { read_only: true }],
    ['production', { environment: 'production' }],
  ])('refuses a %s cluster without a dry run', async (_, over) => {
    setCluster(over);
    backend();
    const session = createBatchSession('c1', [web, api]);
    expect(session.getState().phase).toBe('refused');
    expect(session.getState().refusal).toBeTruthy();
    await session.check();
    await session.apply();
    expect(rightsizingApply).not.toHaveBeenCalled();
  });

  it('rejects rows that are not one-click, already applied or denied by RBAC', async () => {
    backend();
    useRecommendationsStore.getState().markApplied('c1', workloadKey(api));
    const medium = oneClickRow('medium', { confidence: 'medium' });
    const session = createBatchSession('c1', [web, api, medium, db, web], {
      blocked: (rec) =>
        rec.name === 'db' ? "You don't have permission to patch deployments" : null,
    });
    await session.check();
    expect(states(session)).toEqual({
      web: 'ready',
      api: 'rejected',
      medium: 'rejected',
      db: 'rejected',
    });
    expect(session.getState().rows.find((r) => r.rec.name === 'db')!.message).toContain(
      'permission',
    );
    expect(log.map((c) => c.name)).toEqual(['web']);
  });

  it('stops before the next row when the cluster disconnects', async () => {
    backend({
      onCall: (c) => {
        if (!c.dryRun && c.name === 'web') setCluster({}, 'disconnected');
      },
    });
    const session = createBatchSession('c1', [web, api, db]);
    await session.check();
    await session.apply();
    expect(log.filter((c) => !c.dryRun).map((c) => c.name)).toEqual(['web']);
    expect(states(session)).toEqual({ web: 'applied', api: 'skipped', db: 'skipped' });
    expect(session.getState().stopped).toBe('Connect to the cluster to apply.');
  });

  it('stops dry-running when the cluster disconnects', async () => {
    backend({ onCall: () => setCluster({}, 'disconnected') });
    const session = createBatchSession('c1', [web, api]);
    await session.check();
    expect(states(session)).toEqual({ web: 'ready', api: 'rejected' });
    await session.apply();
    expect(log.filter((c) => !c.dryRun)).toEqual([]);
  });

  it('stops on request and when the dialog closes', async () => {
    backend({
      onCall: (c) => {
        if (!c.dryRun) session.stop();
      },
    });
    const session = createBatchSession('c1', [web, api, db]);
    await session.check();
    await session.apply();
    expect(states(session)).toEqual({ web: 'applied', api: 'skipped', db: 'skipped' });
    expect(session.getState().stopped).toBe('Not applied: stopped.');

    log = [];
    useRecommendationsStore.setState({ byCluster: {} });
    backend({
      onCall: (c) => {
        if (!c.dryRun) closed.dispose();
      },
    });
    const closed = createBatchSession('c1', [web, api]);
    await closed.check();
    await closed.apply();
    expect(log.filter((c) => !c.dryRun).map((c) => c.name)).toEqual(['web']);
  });

  it('reports failed patches and skips rows another apply is patching', async () => {
    backend({ patchFail: ['web'] });
    const session = createBatchSession('c1', [web, api]);
    await session.check();
    let release: () => void = () => {};
    const other = exclusiveApply(
      'c1',
      workloadKey(api),
      () => new Promise((r) => (release = () => r('applied'))),
    );
    await session.apply();
    release();
    await other;
    expect(states(session)).toEqual({ web: 'failed', api: 'skipped' });
    expect(session.getState().rows[0]!.message).toBe('conflict');
    expect(log.filter((c) => !c.dryRun).map((c) => c.name)).toEqual(['web']);
    expect(batchCounts(session.getState().rows)).toMatchObject({ failed: 1, skipped: 1 });
    expect(pushToast).not.toHaveBeenCalled();
  });
});
