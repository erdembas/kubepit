import { hasListError, isListComplete, type ListState } from '../data/listState';

/**
 * Load state of the four RBAC lists behind "who can" and permission
 * summaries. A list counts as loaded only when it is complete; a partially
 * readable one (one namespace forbidden) is reported with the unreadable
 * lists, so answers built from it are marked incomplete.
 */

export type RbacList = 'roles' | 'clusterRoles' | 'roleBindings' | 'clusterRoleBindings';

/** Kinds as shown to the user (Kubernetes identifiers, not translated). */
const KINDS: ReadonlyArray<[RbacList, string]> = [
  ['roles', 'Role'],
  ['clusterRoles', 'ClusterRole'],
  ['roleBindings', 'RoleBinding'],
  ['clusterRoleBindings', 'ClusterRoleBinding'],
];

export interface RbacListStatus {
  loaded: Record<RbacList, boolean>;
  /** Every list synced (or failed). */
  synced: boolean;
  /** Kinds that could not be listed, or only partly (RBAC or errors). */
  unavailable: string[];
}

export function rbacListStatus(lists: Readonly<Record<RbacList, ListState>>): RbacListStatus {
  const loaded = {} as Record<RbacList, boolean>;
  for (const [list] of KINDS) loaded[list] = isListComplete(lists[list]);
  return {
    loaded,
    synced: KINDS.every(([list]) => lists[list].synced || lists[list].status === 'error'),
    unavailable: KINDS.filter(([list]) => hasListError(lists[list])).map(([, kind]) => kind),
  };
}
