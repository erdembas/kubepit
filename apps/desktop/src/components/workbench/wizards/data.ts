import { useMemo } from 'react';
import { BUILTIN, isServed, resolveRef, toGvk } from '@/lib/kube/catalog';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ClusterId, Gvk, KubeObject } from '@/types';
import { useWatch } from '../data/watchCache';

/**
 * Live lists the wizards pick from (Services, TLS Secrets, IngressClasses,
 * roles, …), through the shared watch cache the tables use. Watches stop
 * when the wizard closes.
 */

export const GVK = {
  pod: toGvk(BUILTIN.Pod),
  service: toGvk(BUILTIN.Service),
  secret: toGvk(BUILTIN.Secret),
  configMap: toGvk(BUILTIN.ConfigMap),
  namespace: toGvk(BUILTIN.Namespace),
  serviceAccount: toGvk(BUILTIN.ServiceAccount),
  role: toGvk(BUILTIN.Role),
  clusterRole: toGvk(BUILTIN.ClusterRole),
  roleBinding: toGvk(BUILTIN.RoleBinding),
  ingress: toGvk(BUILTIN.Ingress),
  ingressClass: toGvk(BUILTIN.IngressClass),
  cronJob: toGvk(BUILTIN.CronJob),
  job: toGvk(BUILTIN.Job),
  resourceQuota: toGvk(BUILTIN.ResourceQuota),
  limitRange: toGvk(BUILTIN.LimitRange),
  deployment: toGvk(BUILTIN.Deployment),
  statefulSet: toGvk(BUILTIN.StatefulSet),
  daemonSet: toGvk(BUILTIN.DaemonSet),
  replicaSet: toGvk(BUILTIN.ReplicaSet),
  replicationController: toGvk(BUILTIN.ReplicationController),
} as const;

const byName = (a: KubeObject, b: KubeObject) => a.metadata.name.localeCompare(b.metadata.name);

/** Objects of `gvk` in `namespace` (all namespaces / cluster scope when null), sorted by name. */
export function useLiveList(
  clusterId: ClusterId,
  gvk: Gvk | null,
  namespace: string | null,
  enabled = true,
): { items: KubeObject[]; synced: boolean } {
  const snap = useWatch(clusterId, gvk, gvk?.namespaced && namespace ? [namespace] : [], enabled);
  const items = useMemo(() => [...snap.items].sort(byName), [snap.items]);
  return { items, synced: snap.synced || snap.status === 'error' };
}

/** A custom resource kind when the cluster serves it (cert-manager issuers). */
export function useServedKind(clusterId: ClusterId, apiVersion: string, kind: string): Gvk | null {
  const apiResources = useWorkbenchStore((s) => s.apiResources[clusterId] ?? null);
  return useMemo(() => {
    if (!apiResources) return null;
    const gvk = resolveRef(apiVersion, kind, apiResources);
    return gvk && isServed(gvk, apiResources) ? gvk : null;
  }, [apiResources, apiVersion, kind]);
}
