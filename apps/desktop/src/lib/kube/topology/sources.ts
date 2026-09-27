import type { ApiResourceInfo, Gvk } from '@/types';
import { BUILTIN, gvkFromApiResource, isServed, toGvk, type KindDef } from '../catalog';

/**
 * The kinds the relationship map reads. The list has a fixed length so a
 * component can subscribe to one watch per entry; kinds the cluster does not
 * serve resolve to `null` (no watch).
 */

const BUILTIN_SOURCES: readonly KindDef[] = [
  BUILTIN.Pod,
  BUILTIN.Deployment,
  BUILTIN.ReplicaSet,
  BUILTIN.StatefulSet,
  BUILTIN.DaemonSet,
  BUILTIN.Job,
  BUILTIN.CronJob,
  BUILTIN.ReplicationController,
  BUILTIN.Service,
  BUILTIN.EndpointSlice,
  BUILTIN.Ingress,
  BUILTIN.IngressClass,
  BUILTIN.NetworkPolicy,
  BUILTIN.ConfigMap,
  BUILTIN.Secret,
  BUILTIN.PersistentVolumeClaim,
  BUILTIN.PersistentVolume,
  BUILTIN.StorageClass,
  BUILTIN.ServiceAccount,
  BUILTIN.Role,
  BUILTIN.ClusterRole,
  BUILTIN.RoleBinding,
  BUILTIN.ClusterRoleBinding,
  BUILTIN.Node,
  BUILTIN.HorizontalPodAutoscaler,
  BUILTIN.PodDisruptionBudget,
];

export const GATEWAY_GROUP = 'gateway.networking.k8s.io';

/** Gateway API kinds, read only when their CRDs are served. */
export const GATEWAY_KINDS = ['Gateway', 'HTTPRoute', 'GRPCRoute'] as const;

/** Number of watch slots (`topologySources().length` is always this). */
export const TOPOLOGY_SOURCE_COUNT = BUILTIN_SOURCES.length + GATEWAY_KINDS.length;

/** One Gvk (or null when not served) per watch slot, in a fixed order. */
export function topologySources(
  apiResources: readonly ApiResourceInfo[] | null,
): Array<Gvk | null> {
  const builtins = BUILTIN_SOURCES.map((k) => (isServed(k, apiResources) ? toGvk(k) : null));
  const gateway = GATEWAY_KINDS.map((kind) => {
    const found = apiResources?.find((r) => r.group === GATEWAY_GROUP && r.kind === kind);
    return found ? gvkFromApiResource(found) : null;
  });
  return [...builtins, ...gateway];
}

/** Cluster-scoped kinds: they join a namespace map only when something in scope relates to them. */
export function isClusterScopedKind(kind: string): boolean {
  return [
    'Node',
    'PersistentVolume',
    'StorageClass',
    'IngressClass',
    'ClusterRole',
    'ClusterRoleBinding',
    'GatewayClass',
    'Namespace',
  ].includes(kind);
}
