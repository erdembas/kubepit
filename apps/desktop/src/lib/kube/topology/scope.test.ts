import { describe, expect, it } from 'vitest';
import { topologySources } from './sources';
import { planMapScope, scopeNamespaces } from './scope';
import { kindKey } from '@/lib/kube/catalog';

const sources = topologySources(null);
const slot = (plan: ReturnType<typeof planMapScope>, key: string) =>
  plan[sources.findIndex((g) => g && kindKey(g) === key)];
const pod = (ns: string, node: string) => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: `p-${ns}`, namespace: ns, uid: `${ns}-${node}` },
  spec: { nodeName: node },
});

describe('planMapScope', () => {
  it('scopes namespaced slots to the namespaces of pods on the node', () => {
    const plan = planMapScope({ kind: 'Node', name: 'n1' }, sources, {
      items: [pod('a', 'n1'), pod('b', 'n1'), pod('c', 'n2')],
      synced: true,
    });
    expect(slot(plan, 'pods')).toEqual([]);
    expect(slot(plan, 'deployments.apps')).toEqual(['a', 'b']);
    expect(slot(plan, 'secrets')).toEqual(['a', 'b']);
    expect(slot(plan, 'nodes')).toEqual([]);
    expect(slot(plan, 'clusterroles.rbac.authorization.k8s.io')).toEqual([]);
  });
  it('node without pods watches no namespaced slot', () => {
    const plan = planMapScope({ kind: 'Node', name: 'idle' }, sources, {
      items: [pod('a', 'n1')],
      synced: true,
    });
    expect(slot(plan, 'pods')).toEqual([]);
    expect(slot(plan, 'configmaps')).toBeNull();
    expect(slot(plan, 'endpointslices.discovery.k8s.io')).toBeNull();
  });
  it('waits for the seed before scoping', () => {
    const plan = planMapScope({ kind: 'Node', name: 'n1' }, sources, { items: [], synced: false });
    expect(slot(plan, 'services')).toBeNull();
  });
  it('seeds StorageClass, ClusterRole and IngressClass roots', () => {
    const pvc = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: 'd', namespace: 'db', uid: 'v' },
      spec: { storageClassName: 'fast' },
    };
    expect(
      slot(
        planMapScope({ kind: 'StorageClass', name: 'fast' }, sources, {
          items: [pvc],
          synced: true,
        }),
        'pods',
      ),
    ).toEqual(['db']);
    const rb = {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: { name: 'r', namespace: 'ops', uid: 'r' },
      roleRef: { kind: 'ClusterRole', name: 'view' },
    };
    expect(
      slot(
        planMapScope({ kind: 'ClusterRole', name: 'view' }, sources, { items: [rb], synced: true }),
        'serviceaccounts',
      ),
    ).toEqual(['ops']);
    const ing = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: { name: 'i', namespace: 'web', uid: 'i' },
      spec: { ingressClassName: 'nginx' },
    };
    expect(
      slot(
        planMapScope({ kind: 'IngressClass', name: 'nginx' }, sources, {
          items: [ing],
          synced: true,
        }),
        'services',
      ),
    ).toEqual(['web']);
  });
  it('roots without a seed watch cluster-scoped slots only', () => {
    const plan = planMapScope({ kind: 'PriorityClass', name: 'high' }, sources, null);
    expect(slot(plan, 'pods')).toBeNull();
    expect(slot(plan, 'nodes')).toEqual([]);
  });
});

describe('scopeNamespaces', () => {
  it('unions the explicit namespace lists', () => {
    expect(scopeNamespaces([[], ['b', 'a'], null, ['a', 'c']])).toEqual(['a', 'b', 'c']);
  });
  it('is all namespaces when no slot names one', () => {
    expect(scopeNamespaces([[], null, []])).toEqual([]);
  });
});
