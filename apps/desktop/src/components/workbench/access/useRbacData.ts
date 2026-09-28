import { useLocaleMemo as useMemo } from '@/i18n';
import { BUILTIN, isServed, toGvk, type KindDef } from '@/lib/kube/catalog';
import { buildRbacIndex, type RbacIndex } from '@/lib/kube/rbac';
import type { ApiResourceInfo, ClusterId, Gvk } from '@/types';
import { useWatch, type WatchSnapshot } from '../data/watchCache';

/**
 * Roles, ClusterRoles and their bindings for "who can" and permission
 * summaries. Namespaced lists are watched cluster-wide, falling back to
 * `fallbackNamespaces` when that is forbidden. Lists that cannot be read at
 * all are reported, never guessed: the index marks them as not loaded.
 */

export interface RbacData {
  index: RbacIndex;
  /** Every readable list synced (or failed). */
  synced: boolean;
  /** Kinds that could not be listed (RBAC or errors). */
  unavailable: string[];
  /** Namespaced lists only cover `fallbackNamespaces` (cluster-wide listing is forbidden). */
  partial: boolean;
}

function gvkOf(def: KindDef, apiResources: readonly ApiResourceInfo[] | null): Gvk | null {
  return isServed(def, apiResources) ? toGvk(def) : null;
}

function useScopedWatch(
  clusterId: ClusterId,
  gvk: Gvk | null,
  fallback: string[],
  enabled: boolean,
): { snap: WatchSnapshot; partial: boolean } {
  const all = useWatch(clusterId, gvk, [], enabled);
  const useFallback = all.forbidden && fallback.length > 0;
  const scoped = useWatch(clusterId, gvk, fallback, enabled && useFallback);
  return useFallback ? { snap: scoped, partial: true } : { snap: all, partial: false };
}

const loaded = (s: WatchSnapshot) => s.synced && s.status !== 'error';

export function useRbacData(
  clusterId: ClusterId,
  apiResources: readonly ApiResourceInfo[] | null,
  enabled: boolean,
  fallbackNamespaces: string[] = [],
): RbacData {
  const gvks = useMemo(
    () => ({
      roles: gvkOf(BUILTIN.Role, apiResources),
      clusterRoles: gvkOf(BUILTIN.ClusterRole, apiResources),
      roleBindings: gvkOf(BUILTIN.RoleBinding, apiResources),
      clusterRoleBindings: gvkOf(BUILTIN.ClusterRoleBinding, apiResources),
    }),
    [apiResources],
  );
  const roles = useScopedWatch(clusterId, gvks.roles, fallbackNamespaces, enabled);
  const roleBindings = useScopedWatch(clusterId, gvks.roleBindings, fallbackNamespaces, enabled);
  const clusterRoles = useWatch(clusterId, gvks.clusterRoles, [], enabled);
  const clusterRoleBindings = useWatch(clusterId, gvks.clusterRoleBindings, [], enabled);

  const index = useMemo(
    () =>
      buildRbacIndex(
        {
          roles: roles.snap.items,
          clusterRoles: clusterRoles.items,
          roleBindings: roleBindings.snap.items,
          clusterRoleBindings: clusterRoleBindings.items,
        },
        {
          roles: loaded(roles.snap),
          clusterRoles: loaded(clusterRoles),
          roleBindings: loaded(roleBindings.snap),
          clusterRoleBindings: loaded(clusterRoleBindings),
        },
      ),
    // The snapshots' items identities change with every applied batch.
    [roles.snap, clusterRoles, roleBindings.snap, clusterRoleBindings],
  );
  const lists: Array<[string, WatchSnapshot]> = [
    ['Role', roles.snap],
    ['ClusterRole', clusterRoles],
    ['RoleBinding', roleBindings.snap],
    ['ClusterRoleBinding', clusterRoleBindings],
  ];
  return {
    index,
    synced: lists.every(([, s]) => s.synced || s.status === 'error'),
    unavailable: lists.filter(([, s]) => s.status === 'error').map(([kind]) => kind),
    partial: roles.partial || roleBindings.partial,
  };
}
