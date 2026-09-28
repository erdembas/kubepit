import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@/types';
import { kindKey } from '@/lib/kube/catalog';
import { buildTopology } from './build';
import { nodeId } from './model';
import { planMapScope, plannedGraphScope, scopeNamespaces, type SlotScope } from './scope';
import { topologySources } from './sources';
import { neighbourhood } from './view';

const sources = topologySources(null);
const slot = (plan: ReturnType<typeof planMapScope>, key: string) =>
  plan[sources.findIndex((g) => g && kindKey(g) === key)];
const pod = (ns: string, node: string) => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: `p-${ns}`, namespace: ns, uid: `${ns}-${node}` },
  spec: { nodeName: node, volumes: [{ name: 'cfg', configMap: { name: `cm-${ns}` } }] },
});

/** The graph a Map tab builds from `objects` under `plan`, as `useTopologyData` does. */
function mapGraph(plan: readonly SlotScope[], objects: readonly KubeObject[]) {
  const graphScope = plannedGraphScope(plan);
  const lists = sources.flatMap((gvk, i) => {
    const scope = plan[i];
    if (!gvk || scope == null) return [];
    const watched = objects.filter(
      (o) =>
        o.kind === gvk.kind &&
        (!gvk.namespaced || !scope.length || scope.includes(o.metadata.namespace ?? '')),
    );
    return [{ gvk, items: watched, synced: true }];
  });
  return buildTopology({ lists, namespaces: graphScope, apiResources: null });
}

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
    sources.forEach((gvk, i) => {
      if (!gvk) return;
      if (!gvk.namespaced || kindKey(gvk) === 'pods') expect(plan[i]).toEqual([]);
      else expect(plan[i], kindKey(gvk)).toBeNull();
    });
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

describe('ClusterRole seeds', () => {
  const role = {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRole',
    metadata: { name: 'operator', uid: 'cr' },
  };
  const opSa = {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: 'op-sa', namespace: 'operators', uid: 'sa' },
  };
  const crb = (roleName: string) => ({
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRoleBinding',
    metadata: { name: `crb-${roleName}`, uid: `crb-${roleName}` },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: roleName },
    subjects: [
      { kind: 'ServiceAccount', name: 'op-sa', namespace: 'operators' },
      { kind: 'User', name: 'alice' },
    ],
  });

  it('a ClusterRole bound only by a ClusterRoleBinding reaches its service accounts', () => {
    const bindings = [crb('operator'), { ...crb('other'), subjects: [] }];
    const plan = planMapScope({ kind: 'ClusterRole', name: 'operator' }, sources, {
      items: bindings,
      synced: true,
    });
    expect(slot(plan, 'serviceaccounts')).toEqual(['operators']);
    expect(slot(plan, 'rolebindings.rbac.authorization.k8s.io')).toEqual([]);
    expect(slot(plan, 'clusterrolebindings.rbac.authorization.k8s.io')).toEqual([]);
    const graph = mapGraph(plan, [role, opSa, ...bindings]);
    const rootId = nodeId('clusterroles.rbac.authorization.k8s.io', null, 'operator');
    expect(
      neighbourhood(graph, rootId, 2).has(nodeId('serviceaccounts', 'operators', 'op-sa')),
    ).toBe(true);
  });
  it('RoleBindings add the namespaces of their service-account subjects', () => {
    const rb = {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: { name: 'deploy', namespace: 'ops', uid: 'rb' },
      roleRef: { kind: 'ClusterRole', name: 'edit' },
      subjects: [
        { kind: 'ServiceAccount', name: 'deployer', namespace: 'ci' },
        { kind: 'ServiceAccount', name: 'local' },
        { kind: 'User', name: 'bob', namespace: 'ignored' },
      ],
    };
    const roleBinding = {
      ...rb,
      roleRef: { kind: 'Role', name: 'edit' },
      metadata: { ...rb.metadata, namespace: 'x', uid: 'r2' },
    };
    const plan = planMapScope({ kind: 'ClusterRole', name: 'edit' }, sources, {
      items: [rb, roleBinding],
      synced: true,
    });
    expect(slot(plan, 'serviceaccounts')).toEqual(['ci', 'ops']);
  });
});

describe('ClusterRoleBinding seeds', () => {
  const subjects = [
    { kind: 'ServiceAccount', name: 'coredns', namespace: 'kube-system' },
    { kind: 'Group', name: 'system:authenticated' },
  ];
  const root = {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRoleBinding',
    metadata: { name: 'system:kube-dns', uid: 'crb' },
    roleRef: {
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'ClusterRole',
      name: 'system:kube-dns',
    },
    subjects,
  };
  const sa = {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: 'coredns', namespace: 'kube-system', uid: 'sa' },
  };
  const rb = (ns: string, saNs: string, saName: string) => ({
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: { name: `leader-${ns}`, namespace: ns, uid: `rb-${ns}` },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'leader' },
    subjects: [{ kind: 'ServiceAccount', name: saName, namespace: saNs }],
  });
  const role = {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: 'leader', namespace: 'dns-ops', uid: 'role' },
  };
  const mapRoot = { kind: 'ClusterRoleBinding', name: 'system:kube-dns', subjects };

  it('reaches its service accounts, their RoleBindings elsewhere and their Roles', () => {
    const bindings = [rb('dns-ops', 'kube-system', 'coredns'), rb('other', 'other', 'x')];
    const plan = planMapScope(mapRoot, sources, { items: bindings, synced: true });
    expect(slot(plan, 'rolebindings.rbac.authorization.k8s.io')).toEqual([]);
    expect(slot(plan, 'serviceaccounts')).toEqual(['dns-ops', 'kube-system']);
    const reach = neighbourhood(
      mapGraph(plan, [root, sa, role, ...bindings]),
      nodeId('clusterrolebindings.rbac.authorization.k8s.io', null, 'system:kube-dns'),
      3,
    );
    expect(reach.get(nodeId('serviceaccounts', 'kube-system', 'coredns'))).toBe(1);
    expect(
      reach.get(nodeId('rolebindings.rbac.authorization.k8s.io', 'dns-ops', 'leader-dns-ops')),
    ).toBe(2);
    expect(reach.get(nodeId('roles.rbac.authorization.k8s.io', 'dns-ops', 'leader'))).toBe(3);
    expect(
      reach.has(nodeId('rolebindings.rbac.authorization.k8s.io', 'other', 'leader-other')),
    ).toBe(false);
  });
  it("scopes to the subjects' namespaces when no RoleBinding binds them", () => {
    const plan = planMapScope(mapRoot, sources, { items: [], synced: true });
    expect(slot(plan, 'serviceaccounts')).toEqual(['kube-system']);
    expect(
      slot(planMapScope(mapRoot, sources, { items: [], synced: false }), 'serviceaccounts'),
    ).toBeNull();
  });
});

describe('IngressClass seeds', () => {
  const ing = (
    ns: string,
    spec: Record<string, unknown>,
    annotations?: Record<string, string>,
  ) => ({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: { name: `i-${ns}`, namespace: ns, uid: ns, annotations },
    spec,
  });
  const items = [
    ing('named', { ingressClassName: 'nginx' }),
    ing('legacy', {}, { 'kubernetes.io/ingress.class': 'nginx' }),
    ing('classless', {}),
    ing('other', { ingressClassName: 'traefik' }, { 'kubernetes.io/ingress.class': 'nginx' }),
  ];

  it('follows the builder: class name, then the legacy annotation', () => {
    const plan = planMapScope({ kind: 'IngressClass', name: 'nginx' }, sources, {
      items,
      synced: true,
    });
    expect(slot(plan, 'services')).toEqual(['legacy', 'named']);
  });
  it('the default class also gets the Ingresses without a class', () => {
    const root = {
      kind: 'IngressClass',
      name: 'nginx',
      annotations: { 'ingressclass.kubernetes.io/is-default-class': 'true' },
    };
    const plan = planMapScope(root, sources, { items, synced: true });
    expect(slot(plan, 'services')).toEqual(['classless', 'legacy', 'named']);
  });
});

describe('Map tab graph scope', () => {
  const placeholders = (graph: ReturnType<typeof mapGraph>) =>
    [...graph.nodes.values()].filter((n) => n.namespace && n.uid === null).map((n) => n.id);

  it('makes placeholders only in the namespaces the plan names', () => {
    const objects = [pod('a', 'n1'), pod('c', 'n2')];
    const plan = planMapScope({ kind: 'Node', name: 'n1' }, sources, {
      items: objects,
      synced: true,
    });
    expect(plannedGraphScope(plan)).toEqual(['a']);
    // The pod of namespace c (on another node) references cm-c and its
    // service account too; only namespace a's references become placeholders.
    expect(placeholders(mapGraph(plan, objects)).sort()).toEqual([
      nodeId('configmaps', 'a', 'cm-a'),
      nodeId('serviceaccounts', 'a', 'default'),
    ]);
  });
  it('an idle node makes no namespaced placeholder', () => {
    const objects = [pod('a', 'n1'), pod('b', 'n1')];
    const plan = planMapScope({ kind: 'Node', name: 'idle' }, sources, {
      items: objects,
      synced: true,
    });
    expect(plannedGraphScope(plan)).toBeNull();
    expect(placeholders(mapGraph(plan, objects))).toEqual([]);
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
