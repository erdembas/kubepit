import YAML from 'yaml';
import { kindKey } from '@/lib/kube/catalog';
import type {
  ClusterDef,
  ClusterOverview,
  ClusterStatus,
  Gvk,
  KubeObject,
  WatchBatch,
} from '@/types';
import { mockListForbidden } from './access';
import { sleep } from './bus';
import './fixtures/build';
import {
  addWatcher,
  deliverList,
  getDb,
  helmDetail,
  helmKey,
  inScope,
  list,
  removeWatcher,
} from './fixtures/db';
import { apiResources, nodeMetrics, podMetrics } from './fixtures/discovery';
import { warningEvents } from './fixtures/events';
import { ensureLiveness } from './fixtures/live';
import {
  applyYaml,
  cordonNode,
  deleteObject,
  drainNode,
  getObject,
  helmRollback,
  helmUninstall,
  helmUpgradeValues,
  patchObject,
  restartObject,
  scaleObject,
  triggerCronJob,
} from './fixtures/ops';
import { overviewFor } from './fixtures/overview';
import { handlers, register, type MockArgs } from './registry';

/**
 * Demo Kubernetes backend for browser previews (`pnpm dev:ui`). Fixtures
 * live in `./fixtures/*` (one deterministic in-memory cluster per demo
 * cluster id); this file maps IPC commands onto them.
 */

/** Recent Warning events for the dashboard/overview (newest first). */
export function demoWarnings(clusterId: string): KubeObject[] {
  return warningEvents(getDb(clusterId));
}

/** Overview computed from the same fixtures the workbench lists. */
export function demoOverview(clusterId: string): ClusterOverview {
  const status = (handlers.cluster_statuses?.({}) as Record<string, ClusterStatus> | undefined)?.[
    clusterId
  ];
  return overviewFor(getDb(clusterId), status?.version ?? null, status?.platform ?? null);
}

function assertWritable(clusterId: string) {
  const clusters = (handlers.cluster_list?.({}) as ClusterDef[] | undefined) ?? [];
  const cluster = clusters.find((c) => c.id === clusterId);
  if (cluster?.read_only)
    throw new Error(
      `Cluster "${cluster.name}" is read-only in Kubepit; mutating commands are blocked.`,
    );
}

function parseLabelSelector(selector: string | null | undefined) {
  if (!selector) return () => true;
  const terms = selector
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return (o: KubeObject) =>
    terms.every((term) => {
      const labels = o.metadata.labels ?? {};
      const ne = term.split('!=');
      if (ne.length === 2) return labels[ne[0]!.trim()] !== ne[1]!.trim();
      const eq = term.split(/==?/);
      if (eq.length === 2) return labels[eq[0]!.trim()] === eq[1]!.trim();
      if (term.startsWith('!')) return !(term.slice(1) in labels);
      return term in labels;
    });
}

function listFor(clusterId: string, gvk: Gvk, namespaces: string[]) {
  return list(getDb(clusterId), kindKey(gvk)).filter((o) => inScope(o, namespaces));
}

function forbidden(clusterId: string, gvk: Gvk, namespaces: string[]) {
  const db = getDb(clusterId);
  if (
    db.profile.forbidClusterSecrets &&
    gvk.plural === 'secrets' &&
    !gvk.group &&
    !namespaces.length
  )
    return 'secrets is forbidden: User "dev@acme.io" cannot list resource "secrets" in API group "" at the cluster scope';
  // Demo RBAC identities (./access.ts).
  return mockListForbidden(clusterId, gvk, namespaces);
}

register({
  api_resources: async ({ clusterId }: MockArgs) => {
    await sleep(120);
    return apiResources(getDb(clusterId));
  },
  // Demo discovery is computed live, so a refresh is the same lookup.
  api_resources_refresh: async ({ clusterId }: MockArgs) => {
    await sleep(300);
    return apiResources(getDb(clusterId));
  },
  namespace_names: ({ clusterId }: MockArgs) =>
    list(getDb(clusterId), 'namespaces')
      .map((n) => n.metadata.name)
      .sort(),
  resource_list: async ({ clusterId, gvk, namespace, labelSelector }: MockArgs) => {
    await sleep(120);
    const match = parseLabelSelector(labelSelector);
    const items = listFor(clusterId, gvk, namespace ? [namespace] : []).filter(match);
    return { items: structuredClone(items), resource_version: String(getDb(clusterId).rv) };
  },
  resource_watch: ({ clusterId, gvk, namespaces, onEvent }: MockArgs) => {
    const emit = onEvent as (b: WatchBatch) => void;
    const nss = (namespaces as string[]) ?? [];
    const id = addWatcher(clusterId, kindKey(gvk), nss, emit, 'resource_watch');
    ensureLiveness();
    window.setTimeout(
      () => {
        const error = forbidden(clusterId, gvk, nss);
        if (error) {
          emit({
            watch_id: id,
            reset: true,
            upserts: [],
            deletes: [],
            synced: false,
            error,
            recovered: false,
            seq: 1,
            stopped: false,
          });
          removeWatcher(id);
          return;
        }
        // The list arrived: full chunks of 500 at once, the rest with
        // `synced` at the next tick, then the changes made meanwhile.
        deliverList(id, listFor(clusterId, gvk, nss));
      },
      // The list arrives before the first 150 ms tick, so a small list lands
      // on that tick as it does from the backend.
      20 + Math.random() * 120,
    );
    return id;
  },
  resource_unwatch: ({ watchId }: MockArgs) => removeWatcher(watchId),
  // The demo backend has no ack window: batches never wait for the UI.
  resource_watch_ack: () => undefined,
  resource_get: ({ clusterId, gvk, namespace, name }: MockArgs) =>
    structuredClone(getObject(getDb(clusterId), gvk, namespace, name)),
  resource_get_yaml: async ({ clusterId, gvk, namespace, name }: MockArgs) => {
    await sleep(80);
    return YAML.stringify(getObject(getDb(clusterId), gvk, namespace, name), { lineWidth: 0 });
  },
  resource_apply_yaml: async ({ clusterId, yaml, mode, namespace }: MockArgs) => {
    assertWritable(clusterId);
    await sleep(200);
    return structuredClone(applyYaml(getDb(clusterId), yaml, mode, namespace));
  },
  resource_delete: async ({ clusterId, gvk, namespace, name }: MockArgs) => {
    assertWritable(clusterId);
    await sleep(150);
    deleteObject(getDb(clusterId), gvk, namespace, name);
  },
  resource_patch: async ({ clusterId, gvk, namespace, name, patch, patchType }: MockArgs) => {
    assertWritable(clusterId);
    await sleep(120);
    return structuredClone(patchObject(getDb(clusterId), gvk, namespace, name, patch, patchType));
  },
  resource_scale: async ({ clusterId, gvk, namespace, name, replicas }: MockArgs) => {
    assertWritable(clusterId);
    await sleep(150);
    scaleObject(getDb(clusterId), gvk, namespace, name, Number(replicas));
  },
  resource_restart: async ({ clusterId, gvk, namespace, name }: MockArgs) => {
    assertWritable(clusterId);
    await sleep(150);
    restartObject(getDb(clusterId), gvk, namespace, name);
  },
  resource_events: async ({ clusterId, uid }: MockArgs) => {
    await sleep(90);
    const ts = (e: KubeObject) =>
      Date.parse(String(e.lastTimestamp ?? e.metadata.creationTimestamp));
    return structuredClone(
      list(getDb(clusterId), 'events')
        .filter((e) => (e.involvedObject as { uid?: string } | undefined)?.uid === uid)
        .sort((a, b) => ts(b) - ts(a)),
    );
  },
  cronjob_trigger: async ({ clusterId, namespace, name }: MockArgs) => {
    assertWritable(clusterId);
    await sleep(150);
    return triggerCronJob(getDb(clusterId), namespace, name);
  },
  node_cordon: async ({ clusterId, name, unschedulable }: MockArgs) => {
    assertWritable(clusterId);
    await sleep(150);
    cordonNode(getDb(clusterId), name, !!unschedulable);
  },
  node_drain: async ({ clusterId, name }: MockArgs) => {
    assertWritable(clusterId);
    await sleep(300);
    drainNode(getDb(clusterId), name);
  },
  metrics_nodes: async ({ clusterId }: MockArgs) => {
    await sleep(100);
    return nodeMetrics(getDb(clusterId));
  },
  metrics_pods: async ({ clusterId, namespace }: MockArgs) => {
    await sleep(100);
    return podMetrics(getDb(clusterId), namespace ?? null);
  },
  helm_releases: async ({ clusterId, namespace }: MockArgs) => {
    await sleep(160);
    const db = getDb(clusterId);
    return [...db.helm.values()]
      .map((r) => r.history[r.history.length - 1]!)
      .filter((r) => !namespace || r.namespace === namespace)
      .map((r) => ({ ...r }));
  },
  helm_release_detail: async ({ clusterId, namespace, name }: MockArgs) => {
    await sleep(140);
    const rec = getDb(clusterId).helm.get(helmKey(namespace, name));
    if (!rec) throw new Error(`release: not found`);
    return structuredClone(helmDetail(rec));
  },
  helm_rollback: async ({ clusterId, namespace, name, revision }: MockArgs) => {
    assertWritable(clusterId);
    await sleep(600);
    helmRollback(getDb(clusterId), namespace, name, Number(revision));
  },
  helm_uninstall: async ({ clusterId, namespace, name }: MockArgs) => {
    assertWritable(clusterId);
    await sleep(500);
    helmUninstall(getDb(clusterId), namespace, name);
  },
  helm_upgrade_values: async ({ clusterId, namespace, name, values }: MockArgs) => {
    assertWritable(clusterId);
    await sleep(700);
    helmUpgradeValues(getDb(clusterId), namespace, name, values);
  },
});
