import { describe, expect, it } from 'vitest';
import { roleBindingAccess, roleBindingNamespace } from './roleBindingTarget';

describe('Add RoleBinding target', () => {
  it('binds in the object namespace, the single selected one, the cluster default, then default', () => {
    expect(roleBindingNamespace('team-a', ['x'], undefined)).toBe('team-a');
    expect(roleBindingNamespace(null, ['team-b'], { default_namespace: 'ops' })).toBe('team-b');
    expect(roleBindingNamespace(null, ['a', 'b'], { default_namespace: 'ops' })).toBe('ops');
    expect(roleBindingNamespace(null, undefined, undefined)).toBe('default');
  });
  it('asks for create rolebindings in that namespace, never cluster-wide', () => {
    expect(roleBindingAccess('team-b')).toEqual([
      expect.objectContaining({
        verb: 'create',
        group: 'rbac.authorization.k8s.io',
        resource: 'rolebindings',
        namespace: 'team-b',
      }),
    ]);
  });
});
