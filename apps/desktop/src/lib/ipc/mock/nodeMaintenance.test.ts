import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClusterDef, KubeObject } from '@/types';
import type { NodeMaintenanceDrainRequest, NodeMaintenancePlan } from '@/types/nodeMaintenance';
import { maintenanceObservedReady } from '@/components/workbench/node-maintenance/model';
import * as access from './access';
import { drop, find, getDb, put, type ClusterDb } from './fixtures/db';
import {
  demoNodeDrain,
  demoNodePreflight,
  demoNodeProgress,
  nodePlanFingerprint,
} from './nodeMaintenance';
import { handlers } from './registry';

// Build only the explicit local objects below; importing this suite cannot connect a cluster.
vi.mock('./fixtures/build', () => ({}));

let sequence = 0;
let clusterId: string;
let db: ClusterDb;
let readOnly = false;
let connected = true;
const originalList = handlers.cluster_list;
const originalStatuses = handlers.cluster_statuses;
const owner = {
  apiVersion: 'apps/v1',
  kind: 'ReplicaSet',
  name: 'api-rs',
  uid: 'rs-uid',
  controller: true,
};

function pod(name: string, node = 'node-a', ready = true): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: 'app',
      uid: name,
      ownerReferences: [owner],
      labels: { app: 'api' },
    },
    spec: { nodeName: node, containers: [{ name: 'api', image: 'fixture:v1' }] },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] },
  };
}
function request(plan: NodeMaintenancePlan): NodeMaintenanceDrainRequest {
  return {
    plan_id: plan.plan_id,
    name: plan.node_name,
    node_uid: plan.node_uid,
    fingerprint: plan.fingerprint,
  };
}
function cordoned() {
  return find(db, 'nodes', null, 'node-a')?.spec?.unschedulable === true;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  clusterId = `node-maintenance-fixture-${++sequence}`;
  readOnly = false;
  connected = true;
  handlers.cluster_list = () => [{ id: clusterId, read_only: readOnly } as ClusterDef];
  handlers.cluster_statuses = () => ({
    [clusterId]: { state: connected ? 'connected' : 'disconnected' },
  });
  db = getDb(clusterId);
  db.building = true;
  for (const name of ['node-a', 'node-b'])
    put(db, {
      apiVersion: 'v1',
      kind: 'Node',
      metadata: { name, uid: name },
      spec: { unschedulable: false },
    });
  put(db, pod('api-old'));
});
afterEach(() => {
  if (originalList) handlers.cluster_list = originalList;
  else delete handlers.cluster_list;
  if (originalStatuses) handlers.cluster_statuses = originalStatuses;
  else delete handlers.cluster_statuses;
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('local demo reviewed node maintenance', () => {
  it('keeps read-only preflight available and refuses disconnected reads or newly read-only mutation', () => {
    readOnly = true;
    const readOnlyPlan = demoNodePreflight(clusterId, 'node-a');
    expect(readOnlyPlan.read_only).toBe(true);
    expect(() => demoNodeDrain(clusterId, request(readOnlyPlan))).toThrow('read-only');
    expect(cordoned()).toBe(false);
    readOnly = false;
    const reviewed = demoNodePreflight(clusterId, 'node-a');
    readOnly = true;
    expect(() => demoNodeDrain(clusterId, request(reviewed))).toThrow('read-only');
    expect(cordoned()).toBe(false);
    connected = false;
    expect(() => demoNodePreflight(clusterId, 'node-a')).toThrow('disconnected');
  });

  it('rejects changed evidence, replaced node identity and expired review before cordoning', () => {
    let plan = demoNodePreflight(clusterId, 'node-a');
    put(db, { ...find(db, 'pods', 'app', 'api-old')!, status: { phase: 'Pending' } });
    expect(() => demoNodeDrain(clusterId, request(plan))).toThrow('stale-plan');
    expect(cordoned()).toBe(false);
    plan = demoNodePreflight(clusterId, 'node-a');
    const node = find(db, 'nodes', null, 'node-a')!;
    drop(db, node);
    put(db, { ...node, metadata: { ...node.metadata, uid: 'recreated-node' } });
    expect(() => demoNodeDrain(clusterId, request(plan))).toThrow('stale-plan');
    expect(cordoned()).toBe(false);
    plan = demoNodePreflight(clusterId, 'node-a');
    vi.advanceTimersByTime(120_001);
    expect(() => demoNodeDrain(clusterId, request(plan))).toThrow('stale-plan');
    expect(cordoned()).toBe(false);
  });

  it('does not cordon when Pod eviction permission is denied', () => {
    const decide = access.mockDecide;
    vi.spyOn(access, 'mockDecide').mockImplementation((id, check) =>
      check.subresource === 'eviction'
        ? { allowed: false, denied: true, reason: 'fixture denial', error: null }
        : decide(id, check),
    );
    const plan = demoNodePreflight(clusterId, 'node-a');
    expect(() => demoNodeDrain(clusterId, request(plan))).toThrow('permission-denied');
    expect(cordoned()).toBe(false);
    expect(find(db, 'pods', 'app', 'api-old')?.metadata.deletionTimestamp).toBeUndefined();
  });

  it('distinguishes accepted eviction, exited source and a new Ready replacement; refuses replay', async () => {
    const plan = demoNodePreflight(clusterId, 'node-a');
    expect(() => demoNodeProgress(clusterId, plan.plan_id)).toThrow('not-started');
    const receipt = demoNodeDrain(clusterId, request(plan));
    expect(receipt.evictions[0]?.status).toBe('accepted');
    expect(cordoned()).toBe(true);
    let progress = demoNodeProgress(clusterId, plan.plan_id);
    expect(progress.sources[0]?.state).toBe('terminating');
    expect(maintenanceObservedReady(plan, progress, receipt)).toBe(false);
    expect(() => demoNodeDrain(clusterId, request(plan))).toThrow('stale-plan');
    await vi.advanceTimersByTimeAsync(1_600);
    put(db, pod('api-new', 'node-b', false));
    progress = demoNodeProgress(clusterId, plan.plan_id);
    expect(progress.sources[0]?.state).toBe('gone');
    expect(maintenanceObservedReady(plan, progress, receipt)).toBe(false);
    put(db, pod('api-new', 'node-b', true));
    expect(maintenanceObservedReady(plan, demoNodeProgress(clusterId, plan.plan_id), receipt)).toBe(
      true,
    );
  });

  it('shares PDB allowance across Pods and does not reuse it while earlier evictions are terminating', () => {
    put(db, pod('api-second'));
    put(db, {
      apiVersion: 'policy/v1',
      kind: 'PodDisruptionBudget',
      metadata: { name: 'api', namespace: 'app', uid: 'pdb', generation: 1 },
      spec: { selector: { matchLabels: { app: 'api' } }, minAvailable: 1 },
      status: {
        observedGeneration: 1,
        currentHealthy: 2,
        desiredHealthy: 1,
        disruptionsAllowed: 1,
        expectedPods: 2,
      },
    });
    const plan = demoNodePreflight(clusterId, 'node-a');
    expect(plan.pdbs[0]).toMatchObject({ disruptions_allowed: 1, required_disruptions: 2 });
    const receipt = demoNodeDrain(clusterId, request(plan));
    expect(receipt.evictions.map((item) => item.status)).toEqual(['accepted', 'pdb-blocked']);
    const secondPlan = demoNodePreflight(clusterId, 'node-a');
    expect(secondPlan.pdbs[0]?.disruptions_allowed).toBe(0);
    const secondReceipt = demoNodeDrain(clusterId, request(secondPlan));
    expect(secondReceipt.evictions.find((item) => item.name === 'api-second')?.status).toBe(
      'pdb-blocked',
    );
  });

  it('marks oversized peer inventories partial and blocks an oversized affected-Pod plan', () => {
    for (let index = 0; index < 1_000; index++) put(db, pod(`peer-${index}`, 'node-b'));
    let plan = demoNodePreflight(clusterId, 'node-a');
    expect(plan.inventory_complete).toBe(true);
    expect(plan.workloads[0]?.complete).toBe(false);
    expect(plan.warnings).toContain('workloads-partial');
    for (let index = 0; index < 500; index++) put(db, pod(`source-${index}`));
    plan = demoNodePreflight(clusterId, 'node-a');
    expect(plan.pods).toHaveLength(500);
    expect(plan.inventory_complete).toBe(false);
    expect(() => demoNodeDrain(clusterId, request(plan))).toThrow('incomplete-inventory');
    expect(cordoned()).toBe(false);
  });

  it('fingerprints reviewed evidence without tying it to a generated plan ID or clock time', () => {
    const plan = demoNodePreflight(clusterId, 'node-a');
    expect(
      nodePlanFingerprint({ ...plan, plan_id: 'another-id', checked_at: plan.checked_at + 50_000 }),
    ).toBe(plan.fingerprint);
    expect(nodePlanFingerprint({ ...plan, node_uid: 'another-node' })).not.toBe(plan.fingerprint);
  });
});
