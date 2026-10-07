import { kindKey, parseApiVersion, resolveRef } from '@/lib/kube/catalog';
import type { ClusterDef, ClusterStatus, Gvk, KubeObject } from '@/types';
import type {
  NamespaceCleanupKindResult,
  NamespaceCleanupPlan,
  NamespaceCleanupRequest,
  NamespaceCleanupResult,
} from '@/types/namespaceCleanup';
import { sleep } from './bus';
import './fixtures/build';
import { find, getDb } from './fixtures/db';
import { deleteObject } from './fixtures/ops';
import { handlers, register, type MockArgs } from './registry';

/**
 * Demo backend of the namespace cleanup (preview + run): the same two-phase
 * contract as the Rust backend, over the fixture store. The run is refused
 * for system namespaces, read-only clusters and a confirmation that does not
 * name the namespace.
 */

const SYSTEM_NAMESPACES = new Set(['default', 'kube-system', 'kube-public', 'kube-node-lease']);
const CONTROLLERS = new Set([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'ReplicationController',
  'Job',
  'CronJob',
]);

/** The backend's deletion order: controllers, ordinary kinds, Pods, data, Events. */
export function cleanupStage(kind: string): number {
  if (CONTROLLERS.has(kind)) return 0;
  if (kind === 'Pod') return 2;
  if (kind === 'PersistentVolumeClaim') return 3;
  if (kind === 'Event') return 4;
  return 1;
}

function gvkOf(key: string, o: KubeObject): Gvk {
  const known = resolveRef(o.apiVersion, o.kind);
  if (known) return known;
  const [plural, group = ''] = key.includes('.') ? (key.split(/\.(.*)/) as [string]) : [key];
  const { version } = parseApiVersion(o.apiVersion);
  return { group, version, kind: o.kind, plural, namespaced: true };
}

export interface CleanupKindObjects {
  gvk: Gvk;
  objects: KubeObject[];
}

/** Every fixture object of `namespace` (cluster-scoped tables never match). */
export function namespaceCleanupKinds(clusterId: string, namespace: string): CleanupKindObjects[] {
  const db = getDb(clusterId);
  const kinds: CleanupKindObjects[] = [];
  for (const [key, table] of db.kinds) {
    if (key === 'namespaces') continue;
    const objects = [...table.values()].filter((o) => o.metadata.namespace === namespace);
    if (!objects.length) continue;
    kinds.push({ gvk: gvkOf(key, objects[0]!), objects });
  }
  kinds.sort(
    (a, b) =>
      cleanupStage(a.gvk.kind) - cleanupStage(b.gvk.kind) ||
      a.gvk.group.localeCompare(b.gvk.group) ||
      a.gvk.kind.localeCompare(b.gvk.kind),
  );
  return kinds;
}

function clusterOf(clusterId: string): ClusterDef | undefined {
  return (handlers.cluster_list?.({}) as ClusterDef[] | undefined)?.find(
    (cluster) => cluster.id === clusterId,
  );
}

function connected(clusterId: string) {
  const state = (handlers.cluster_statuses?.({}) as Record<string, ClusterStatus> | undefined)?.[
    clusterId
  ];
  if (state?.state !== 'connected') throw new Error('namespace-cleanup:disconnected');
}

function validate(namespace: string, confirm: string | null) {
  const ns = namespace.trim();
  if (!ns) throw new Error('namespace-cleanup:invalid-namespace');
  if (SYSTEM_NAMESPACES.has(ns)) throw new Error('namespace-cleanup:system-namespace');
  if (confirm !== null && confirm.trim() !== ns)
    throw new Error('namespace-cleanup:confirm-mismatch');
  return ns;
}

export function demoNamespaceCleanupPreview(clusterId: string, namespace: string) {
  connected(clusterId);
  const ns = validate(namespace, null);
  const db = getDb(clusterId);
  const namespaceObject = find(db, 'namespaces', null, ns);
  if (!namespaceObject) throw new Error('namespace-cleanup:not-found');
  const kinds = namespaceCleanupKinds(clusterId, ns);
  const plan: NamespaceCleanupPlan = {
    namespace: ns,
    checked_at: Date.now(),
    read_only: !!clusterOf(clusterId)?.read_only,
    terminating:
      (namespaceObject.status as { phase?: string } | undefined)?.phase === 'Terminating',
    total_objects: kinds.reduce((sum, kind) => sum + kind.objects.length, 0),
    inventory_complete: true,
    kinds: kinds.map((kind) => ({
      gvk: kind.gvk,
      count: kind.objects.length,
      names: kind.objects
        .map((o) => o.metadata.name)
        .sort()
        .slice(0, 25),
    })),
    warnings: [],
  };
  if (plan.terminating) plan.warnings.push('terminating');
  return plan;
}

export function demoNamespaceCleanupRun(clusterId: string, request: NamespaceCleanupRequest) {
  connected(clusterId);
  const cluster = clusterOf(clusterId);
  if (cluster?.read_only)
    throw new Error(
      `Cluster "${cluster.name}" is read-only in Kubepit; mutating commands are blocked.`,
    );
  const ns = validate(request.namespace, request.confirm_name);
  const db = getDb(clusterId);
  if (!find(db, 'namespaces', null, ns)) throw new Error('namespace-cleanup:not-found');
  const kinds = namespaceCleanupKinds(clusterId, ns);
  const startedAt = Date.now();
  const results: NamespaceCleanupKindResult[] = kinds.map((kind) => {
    let deleted = 0;
    let alreadyGone = 0;
    const errors: string[] = [];
    for (const object of kind.objects) {
      if (!find(db, kindKey(kind.gvk), ns, object.metadata.name)) {
        alreadyGone++;
        continue;
      }
      try {
        deleteObject(db, kind.gvk, ns, object.metadata.name);
        deleted++;
      } catch (error) {
        if (errors.length < 3) errors.push(`${object.metadata.name}: ${String(error)}`);
      }
    }
    return {
      gvk: kind.gvk,
      planned: kind.objects.length,
      deleted,
      already_gone: alreadyGone,
      failed: kind.objects.length - deleted - alreadyGone,
      errors,
    };
  });
  // Helm releases live in namespace Secrets the purge just deleted; the
  // fixture store drops its records with them.
  for (const key of [...db.helm.keys()]) if (key.startsWith(`${ns}/`)) db.helm.delete(key);
  const sum = (pick: (kind: NamespaceCleanupKindResult) => number) =>
    results.reduce((total, kind) => total + pick(kind), 0);
  const result: NamespaceCleanupResult = {
    namespace: ns,
    started_at: startedAt,
    finished_at: Date.now(),
    kinds: results,
    deleted: sum((k) => k.deleted),
    already_gone: sum((k) => k.already_gone),
    failed: sum((k) => k.failed),
    inventory_complete: true,
  };
  return result;
}

register({
  namespace_cleanup_preview: async ({ clusterId, namespace }: MockArgs) => {
    await sleep(300);
    return demoNamespaceCleanupPreview(clusterId, String(namespace));
  },
  namespace_cleanup_run: async ({ clusterId, request }: MockArgs) => {
    const result = demoNamespaceCleanupRun(clusterId, request as NamespaceCleanupRequest);
    await sleep(Math.min(1200, 350 + result.deleted * 6));
    return result;
  },
});
