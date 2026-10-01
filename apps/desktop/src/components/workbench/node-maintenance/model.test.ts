import { describe, expect, it } from 'vitest';
import type {
  NodeMaintenancePlan,
  NodeMaintenanceProgress,
  NodeMaintenanceReceipt,
} from '@/types/nodeMaintenance';
import { drainReviewBlock, maintenanceObservedReady } from './model';

function observation() {
  const owner = { kind: 'ReplicaSet', name: 'api-rs', uid: 'owner-uid' };
  const plan: NodeMaintenancePlan = {
    plan_id: 'reviewed-plan',
    node_name: 'node-a',
    node_uid: 'node-uid',
    fingerprint: 'fingerprint',
    checked_at: 0,
    unschedulable: false,
    read_only: false,
    inventory_complete: true,
    pdbs_complete: true,
    warnings: [],
    pdbs: [],
    pods: [
      {
        namespace: 'app',
        name: 'api-old',
        uid: 'source-uid',
        action: 'evict',
        phase: 'Running',
        ready: true,
        terminating: false,
        owner,
        volumes: [],
        pdbs: [],
      },
    ],
    workloads: [
      {
        namespace: 'app',
        owner,
        baseline_uids: ['source-uid', 'existing-healthy-uid'],
        expected_replacements: 1,
        complete: true,
      },
    ],
  };
  const receipt: NodeMaintenanceReceipt = {
    plan_id: plan.plan_id,
    started_at: 1,
    node_cordoned: true,
    evictions: [
      { namespace: 'app', name: 'api-old', uid: 'source-uid', status: 'accepted', error: null },
    ],
  };
  const progress: NodeMaintenanceProgress = {
    checked_at: 2,
    node_uid_matches: true,
    node_cordoned: true,
    warnings: [],
    sources: [{ namespace: 'app', name: 'api-old', uid: 'source-uid', state: 'gone' }],
    workloads: [
      {
        namespace: 'app',
        owner,
        expected_replacements: 1,
        complete: true,
        replacements: [
          {
            name: 'api-new',
            uid: 'replacement-uid',
            node: 'node-b',
            ready: true,
            phase: 'Running',
          },
        ],
      },
    ],
  };
  return { plan, receipt, progress };
}

describe('reviewed node maintenance completion', () => {
  it('requires gone sources and new Ready Pods on another node, not only accepted evictions', () => {
    const { plan, receipt, progress } = observation();
    expect(maintenanceObservedReady(plan, null, receipt)).toBe(false);
    expect(maintenanceObservedReady(plan, progress, null)).toBe(false);
    for (const state of ['present', 'terminating', 'unknown'] as const) {
      progress.sources[0]!.state = state;
      expect(maintenanceObservedReady(plan, progress, receipt)).toBe(false);
    }
    progress.sources[0]!.state = 'gone';
    for (const replacement of [
      { node: 'node-a', ready: true, uid: 'replacement-uid' },
      { node: '', ready: true, uid: 'replacement-uid' },
      { node: 'node-b', ready: false, uid: 'replacement-uid' },
      { node: 'node-b', ready: true, uid: 'existing-healthy-uid' },
    ]) {
      Object.assign(progress.workloads[0]!.replacements[0]!, replacement);
      expect(maintenanceObservedReady(plan, progress, receipt)).toBe(false);
    }
    Object.assign(progress.workloads[0]!.replacements[0]!, {
      node: 'node-b',
      ready: true,
      uid: 'new-uid',
    });
    expect(maintenanceObservedReady(plan, progress, receipt)).toBe(true);
  });

  it('does not infer readiness from partial evidence or an unverified/uncordoned node', () => {
    for (const change of [
      (value: ReturnType<typeof observation>) => {
        value.plan.workloads[0]!.complete = false;
      },
      (value: ReturnType<typeof observation>) => {
        value.progress.workloads[0]!.complete = false;
      },
      (value: ReturnType<typeof observation>) => {
        value.progress.node_uid_matches = false;
      },
      (value: ReturnType<typeof observation>) => {
        value.progress.node_cordoned = null;
      },
      (value: ReturnType<typeof observation>) => {
        value.progress.node_cordoned = false;
      },
      (value: ReturnType<typeof observation>) => {
        value.progress.workloads = [];
      },
      (value: ReturnType<typeof observation>) => {
        value.progress.sources = [];
      },
    ]) {
      const value = observation();
      change(value);
      expect(maintenanceObservedReady(value.plan, value.progress, value.receipt)).toBe(false);
    }
  });

  it('does not count duplicate replacement UIDs or failed/unknown eviction outcomes', () => {
    const { plan, progress, receipt } = observation();
    for (const status of ['failed', 'pdb-blocked', 'timeout', 'not-attempted'] as const) {
      receipt.evictions[0]!.status = status;
      expect(maintenanceObservedReady(plan, progress, receipt)).toBe(false);
    }
    receipt.evictions[0]!.status = 'already-gone';
    expect(maintenanceObservedReady(plan, progress, receipt)).toBe(true);
    plan.workloads[0]!.expected_replacements = 2;
    progress.workloads[0]!.replacements.push({ ...progress.workloads[0]!.replacements[0]! });
    expect(maintenanceObservedReady(plan, progress, receipt)).toBe(false);
  });

  it('binds completion to the receipt for this reviewed plan and exact source identities', () => {
    const { plan, progress, receipt } = observation();
    receipt.plan_id = 'another-plan';
    expect(maintenanceObservedReady(plan, progress, receipt)).toBe(false);
    receipt.plan_id = plan.plan_id;
    receipt.evictions[0]!.uid = 'unrelated-source';
    expect(maintenanceObservedReady(plan, progress, receipt)).toBe(false);
    receipt.evictions[0]!.uid = 'source-uid';
    plan.pods.push({ ...plan.pods[0]!, uid: 'second-source', name: 'second-source' });
    progress.sources.push({ ...progress.sources[0]!, uid: 'second-source', name: 'second-source' });
    receipt.evictions.push({ ...receipt.evictions[0]! });
    expect(maintenanceObservedReady(plan, progress, receipt)).toBe(false);
  });

  it('blocks read-only, incomplete and unmanaged plans while keeping unknown PDB evidence distinct', () => {
    const { plan } = observation();
    expect(drainReviewBlock({ ...plan, read_only: true })).toBe('read-only');
    expect(drainReviewBlock({ ...plan, inventory_complete: false })).toBe('incomplete-inventory');
    expect(drainReviewBlock({ ...plan, warnings: ['namespace-limit'] })).toBe(
      'incomplete-inventory',
    );
    expect(drainReviewBlock({ ...plan, pods: [{ ...plan.pods[0]!, action: 'unmanaged' }] })).toBe(
      'unmanaged-pods',
    );
    expect(
      drainReviewBlock({ ...plan, pdbs_complete: false, warnings: ['pdbs-forbidden'] }),
    ).toBeNull();
  });
});
