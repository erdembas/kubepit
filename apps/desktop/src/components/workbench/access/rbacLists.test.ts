import { describe, expect, it } from 'vitest';
import type { ListState } from '../data/listState';
import { rbacListStatus } from './rbacLists';

const ready: ListState = { synced: true, status: 'ready', error: null };
const forbiddenB =
  'rolebindings.rbac.authorization.k8s.io is forbidden: User "dev" cannot list resource "rolebindings" in the namespace "b"';

describe('RBAC list status', () => {
  it('complete lists are loaded and nothing is reported', () => {
    const status = rbacListStatus({
      roles: ready,
      clusterRoles: ready,
      roleBindings: ready,
      clusterRoleBindings: ready,
    });
    expect(status.loaded).toEqual({
      roles: true,
      clusterRoles: true,
      roleBindings: true,
      clusterRoleBindings: true,
    });
    expect(status.unavailable).toEqual([]);
    expect(status.synced).toBe(true);
  });

  it('a partially readable list is not loaded and is reported as incomplete', () => {
    const status = rbacListStatus({
      roles: ready,
      clusterRoles: ready,
      // Rows of the readable namespaces kept, namespace "b" forbidden.
      roleBindings: { ...ready, error: forbiddenB },
      clusterRoleBindings: ready,
    });
    expect(status.loaded.roleBindings).toBe(false);
    expect(status.loaded.roles).toBe(true);
    expect(status.unavailable).toEqual(['RoleBinding']);
    expect(status.synced).toBe(true);
  });

  it('a failed list is reported and settles the sync', () => {
    const status = rbacListStatus({
      roles: ready,
      clusterRoles: { synced: false, status: 'error', error: 'clusterroles is forbidden' },
      roleBindings: ready,
      clusterRoleBindings: { synced: false, status: 'loading', error: null },
    });
    expect(status.loaded.clusterRoles).toBe(false);
    expect(status.unavailable).toEqual(['ClusterRole']);
    expect(status.synced).toBe(false);
  });
});
