import { describe, expect, it, vi } from 'vitest';
import type { Gvk } from '@/types';

// The stores pull in window-bound modules (Vitest runs in the node
// environment); `scopeFrom` is pure and `currentScope` only reads them.
vi.mock('@/store/useAppStore', () => ({ useAppStore: { getState: () => ({}) } }));
vi.mock('@/store/useWorkbenchStore', () => ({
  useWorkbenchStore: { getState: () => ({}) },
  gvkForCluster: () => null,
}));

import { scopeFrom } from './scope';

const POD: Gvk = { group: '', version: 'v1', kind: 'Pod', plural: 'pods', namespaced: true };
const NODE: Gvk = { group: '', version: 'v1', kind: 'Node', plural: 'nodes', namespaced: false };
const DEPLOY: Gvk = {
  group: 'apps',
  version: 'v1',
  kind: 'Deployment',
  plural: 'deployments',
  namespaced: true,
};

describe('scopeFrom', () => {
  it('is empty without a cluster', () => {
    expect(
      scopeFrom({ clusterId: null, namespaces: ['shop'], defaultNamespace: null, selection: null }),
    ).toEqual({ cluster_id: null, namespace: null, object: null });
  });

  it('uses the one selected namespace, else the cluster default', () => {
    const base = { clusterId: 'c1', defaultNamespace: 'default', selection: null };
    expect(scopeFrom({ ...base, namespaces: ['shop'] }).namespace).toBe('shop');
    expect(scopeFrom({ ...base, namespaces: undefined }).namespace).toBe('default');
    // Several or all namespaces: no single namespace.
    expect(scopeFrom({ ...base, namespaces: ['a', 'b'] }).namespace).toBeNull();
    expect(scopeFrom({ ...base, namespaces: [] }).namespace).toBeNull();
  });

  it('names the selected object with its apiVersion and namespace', () => {
    const scope = scopeFrom({
      clusterId: 'c1',
      namespaces: [],
      defaultNamespace: null,
      selection: { gvk: DEPLOY, namespace: 'shop', name: 'web' },
    });
    expect(scope).toEqual({
      cluster_id: 'c1',
      namespace: 'shop',
      object: { api_version: 'apps/v1', kind: 'Deployment', namespace: 'shop', name: 'web' },
    });
  });

  it('drops the namespace of cluster-scoped objects', () => {
    const scope = scopeFrom({
      clusterId: 'c1',
      namespaces: ['shop'],
      defaultNamespace: null,
      selection: { gvk: NODE, namespace: 'shop', name: 'node-1' },
    });
    expect(scope.object).toEqual({
      api_version: 'v1',
      kind: 'Node',
      namespace: null,
      name: 'node-1',
    });
    expect(scope.namespace).toBe('shop');
  });

  it('prefers the object namespace over the view namespaces', () => {
    const scope = scopeFrom({
      clusterId: 'c1',
      namespaces: ['a', 'b'],
      defaultNamespace: 'default',
      selection: { gvk: POD, namespace: 'b', name: 'web-1' },
    });
    expect(scope.namespace).toBe('b');
  });
});
