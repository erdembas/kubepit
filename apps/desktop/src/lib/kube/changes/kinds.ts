import type { Gvk, KubeObject } from '@/types';
import { BUILTIN, parseApiVersion, toGvk, type KindDef } from '../catalog';

/**
 * Kinds the backend change journal records (`JOURNALED_KINDS` in
 * `crates/kubepit-core/src/change_journal.rs`), in display order.
 */
export const JOURNALED_KINDS: readonly KindDef[] = [
  BUILTIN.Deployment,
  BUILTIN.StatefulSet,
  BUILTIN.DaemonSet,
  BUILTIN.CronJob,
  BUILTIN.Service,
  BUILTIN.Ingress,
  BUILTIN.ConfigMap,
  BUILTIN.Secret,
  BUILTIN.HorizontalPodAutoscaler,
  BUILTIN.PodDisruptionBudget,
  BUILTIN.NetworkPolicy,
  BUILTIN.Namespace,
  BUILTIN.Node,
  BUILTIN.Role,
  BUILTIN.RoleBinding,
  BUILTIN.ClusterRole,
  BUILTIN.ClusterRoleBinding,
];

const BY_GROUP_KIND = new Map(JOURNALED_KINDS.map((k) => [`${k.group}/${k.kind}`, k]));

/** Whether changes of `obj` are journaled (the details panel's Changes tab). */
export function isJournaled(obj: Pick<KubeObject, 'apiVersion' | 'kind'>): boolean {
  return BY_GROUP_KIND.has(`${parseApiVersion(obj.apiVersion).group}/${obj.kind}`);
}

/** Position of a kind in `JOURNALED_KINDS` (unknown kinds sort last). */
export function journaledOrder(kind: string): number {
  const index = JOURNALED_KINDS.findIndex((k) => k.kind === kind);
  return index < 0 ? JOURNALED_KINDS.length : index;
}

/** The catalog Gvk of a journal entry (the entry's own Gvk when unknown). */
export function journaledGvk(gvk: Gvk): Gvk {
  const known = BY_GROUP_KIND.get(`${gvk.group}/${gvk.kind}`);
  return known ? toGvk(known) : gvk;
}
