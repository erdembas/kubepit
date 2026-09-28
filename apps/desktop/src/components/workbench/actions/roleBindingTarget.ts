import { accessCheck } from '@/lib/kube/access';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import type { AccessCheck, ClusterDef } from '@/types';

const ROLE_BINDING = toGvk(BUILTIN.RoleBinding);

/**
 * Namespace "Add RoleBinding" binds a Role or ClusterRole in: the object's
 * own namespace (a Role), else the single namespace the workbench shows, else
 * the cluster default, else `default`.
 */
export function roleBindingNamespace(
  objNamespace: string | null,
  selected: readonly string[] | undefined,
  cluster: Pick<ClusterDef, 'default_namespace'> | undefined,
): string {
  if (objNamespace) return objNamespace;
  if (selected?.length === 1 && selected[0]) return selected[0];
  return cluster?.default_namespace || 'default';
}

/** The wizard creates a RoleBinding in `namespace`; that is what it needs. */
export function roleBindingAccess(namespace: string): AccessCheck[] {
  return [accessCheck('create', ROLE_BINDING, { namespace })];
}
