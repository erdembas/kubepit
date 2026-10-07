import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClusterDef, KubeObject } from '@/types';
import type { NamespaceCleanupRequest } from '@/types/namespaceCleanup';
import { getDb, put, type ClusterDb } from './fixtures/db';
import {
  cleanupStage,
  demoNamespaceCleanupPreview,
  demoNamespaceCleanupRun,
} from './namespaceCleanup';
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

function object(apiVersion: string, kind: string, name: string): KubeObject {
  return {
    apiVersion,
    kind,
    metadata: { name, namespace: 'app', uid: '', creationTimestamp: '2026-01-01T00:00:00Z' },
  };
}

function remaining(): KubeObject[] {
  const all: KubeObject[] = [];
  for (const table of db.kinds.values())
    for (const item of table.values())
      if (item.metadata.namespace === 'app' && !item.metadata.deletionTimestamp) all.push(item);
  return all;
}

function request(confirm = 'app'): NamespaceCleanupRequest {
  return { namespace: 'app', confirm_name: confirm };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  clusterId = `namespace-cleanup-fixture-${++sequence}`;
  readOnly = false;
  connected = true;
  handlers.cluster_list = () => [{ id: clusterId, read_only: readOnly } as ClusterDef];
  handlers.cluster_statuses = () => ({
    [clusterId]: { state: connected ? 'connected' : 'disconnected' },
  });
  db = getDb(clusterId);
  db.building = true;
  put(db, {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: 'app', uid: 'ns-app' },
    status: { phase: 'Active' },
  } as KubeObject);
  put(db, object('v1', 'Pod', 'web-0'));
  put(db, object('v1', 'Service', 'web'));
  put(db, object('v1', 'PersistentVolumeClaim', 'data-0'));
  put(db, object('v1', 'ConfigMap', 'settings'));
  put(db, object('apps/v1', 'Deployment', 'api'));
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

describe('local demo namespace cleanup', () => {
  it('previews the inventory in deletion order', () => {
    const plan = demoNamespaceCleanupPreview(clusterId, 'app');
    expect(plan.total_objects).toBe(5);
    expect(plan.kinds.map((k) => k.gvk.kind)).toEqual([
      'Deployment',
      'ConfigMap',
      'Service',
      'Pod',
      'PersistentVolumeClaim',
    ]);
    expect(plan.read_only).toBe(false);
    expect(plan.warnings).toEqual([]);
  });

  it('refuses system namespaces, missing namespaces and disconnected clusters', () => {
    for (const ns of ['kube-system', 'default', 'kube-public', 'kube-node-lease'])
      expect(() => demoNamespaceCleanupPreview(clusterId, ns)).toThrow('system-namespace');
    expect(() => demoNamespaceCleanupPreview(clusterId, 'nope')).toThrow('not-found');
    connected = false;
    expect(() => demoNamespaceCleanupPreview(clusterId, 'app')).toThrow('disconnected');
    expect(() => demoNamespaceCleanupRun(clusterId, request())).toThrow('disconnected');
  });

  it('demands the typed namespace name again before deleting anything', () => {
    expect(() => demoNamespaceCleanupRun(clusterId, request('typo'))).toThrow('confirm-mismatch');
    expect(remaining().length).toBe(5);
  });

  it('keeps read-only clusters inspectable but never deletes', () => {
    readOnly = true;
    const plan = demoNamespaceCleanupPreview(clusterId, 'app');
    expect(plan.read_only).toBe(true);
    expect(() => demoNamespaceCleanupRun(clusterId, request())).toThrow('read-only');
    expect(remaining().length).toBe(5);
  });

  it('deletes everything and reports the receipt', async () => {
    const planned = new Set(
      demoNamespaceCleanupPreview(clusterId, 'app')
        .kinds.flatMap((kind) => kind.names)
        .map((name) => name),
    );
    const result = demoNamespaceCleanupRun(clusterId, request());
    expect(result.deleted).toBe(5);
    expect(result.already_gone).toBe(0);
    expect(result.failed).toBe(0);
    // Every planned object is gone or terminating right away (terminating a
    // Pod also emits a new Event, exactly like the real cluster churns).
    expect(remaining().filter((o) => planned.has(o.metadata.name))).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    // The terminating Pod has actually been dropped from the table.
    expect(
      [...db.kinds.values()].flatMap((t) => [...t.values()]).filter((o) => o.kind === 'Pod'),
    ).toEqual([]);
  });

  it('re-enumerates at run time: an object deleted meanwhile never enters the plan', () => {
    // Something else deletes the ConfigMap between preview and run.
    const cm = db.kinds.get('configmaps')?.values().next().value as KubeObject;
    db.kinds.get('configmaps')!.delete(cm.metadata.uid);
    const result = demoNamespaceCleanupRun(clusterId, request());
    expect(result.kinds.map((k) => k.gvk.kind)).not.toContain('ConfigMap');
    expect(result.deleted).toBe(4);
    expect(result.already_gone).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('stages kinds like the Rust backend', () => {
    expect(cleanupStage('CronJob')).toBe(0);
    expect(cleanupStage('Service')).toBeGreaterThan(cleanupStage('StatefulSet'));
    expect(cleanupStage('Pod')).toBeGreaterThan(cleanupStage('Service'));
    expect(cleanupStage('PersistentVolumeClaim')).toBeGreaterThan(cleanupStage('Pod'));
    expect(cleanupStage('Event')).toBeGreaterThan(cleanupStage('PersistentVolumeClaim'));
  });
});
