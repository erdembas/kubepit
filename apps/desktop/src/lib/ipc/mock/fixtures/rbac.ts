import { put, type ClusterDb } from './db';
import { DAY, meta, obj } from './util';

/** ClusterRoles, Roles and their bindings. */

type Rule = [string[], string[], string[]] | [string[], string[], string[], string[]];

const rules = (list: Rule[]) =>
  list.map(([apiGroups, resources, verbs, resourceNames]) => ({
    apiGroups,
    resources,
    verbs,
    ...(resourceNames ? { resourceNames } : {}),
  }));

const RBAC = 'rbac.authorization.k8s.io/v1';

export function buildRbac(db: ClusterDb) {
  const clusterRoles: Array<[string, Rule[], Record<string, string>?]> = [
    ['cluster-admin', [[['*'], ['*'], ['*']]], { 'kubernetes.io/bootstrapping': 'rbac-defaults' }],
    [
      'admin',
      [
        [
          [''],
          [
            'pods',
            'pods/attach',
            'pods/exec',
            'pods/portforward',
            'pods/proxy',
            'services',
            'configmaps',
            'secrets',
            'persistentvolumeclaims',
          ],
          ['create', 'delete', 'deletecollection', 'get', 'list', 'patch', 'update', 'watch'],
        ],
        [['apps'], ['deployments', 'daemonsets', 'statefulsets', 'replicasets'], ['*']],
        [['batch'], ['jobs', 'cronjobs'], ['*']],
      ],
      { 'kubernetes.io/bootstrapping': 'rbac-defaults' },
    ],
    [
      'edit',
      [
        [
          [''],
          ['pods', 'services', 'configmaps', 'secrets'],
          ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'],
        ],
        [
          ['apps'],
          ['deployments', 'statefulsets'],
          ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'],
        ],
      ],
      { 'kubernetes.io/bootstrapping': 'rbac-defaults' },
    ],
    [
      'view',
      [
        [
          [''],
          [
            'pods',
            'services',
            'configmaps',
            'endpoints',
            'persistentvolumeclaims',
            'events',
            'namespaces',
          ],
          ['get', 'list', 'watch'],
        ],
        [
          ['apps'],
          ['deployments', 'daemonsets', 'statefulsets', 'replicasets'],
          ['get', 'list', 'watch'],
        ],
        [['batch'], ['jobs', 'cronjobs'], ['get', 'list', 'watch']],
      ],
      { 'kubernetes.io/bootstrapping': 'rbac-defaults' },
    ],
    [
      'system:node',
      [
        [[''], ['nodes', 'nodes/status'], ['create', 'get', 'list', 'watch', 'patch', 'update']],
        [[''], ['pods'], ['get', 'list', 'watch', 'create', 'delete']],
      ],
      { 'kubernetes.io/bootstrapping': 'rbac-defaults' },
    ],
    [
      'system:kube-dns',
      [[[''], ['endpoints', 'services'], ['list', 'watch']]],
      { 'kubernetes.io/bootstrapping': 'rbac-defaults' },
    ],
    [
      'system:metrics-server',
      [
        [[''], ['nodes/metrics'], ['get']],
        [[''], ['pods', 'nodes'], ['get', 'list', 'watch']],
      ],
    ],
    [
      'prometheus-server',
      [
        [
          [''],
          [
            'nodes',
            'nodes/proxy',
            'nodes/metrics',
            'services',
            'endpoints',
            'pods',
            'ingresses',
            'configmaps',
          ],
          ['get', 'list', 'watch'],
        ],
        [['networking.k8s.io'], ['ingresses', 'ingresses/status'], ['get', 'list', 'watch']],
        [[], ['/metrics'], ['get']],
      ],
      { 'app.kubernetes.io/name': 'prometheus' },
    ],
    [
      'kube-state-metrics',
      [
        [
          ['', 'apps', 'batch', 'autoscaling', 'policy', 'networking.k8s.io', 'storage.k8s.io'],
          ['*'],
          ['list', 'watch'],
        ],
      ],
    ],
    [
      'cert-manager-controller-certificates',
      [
        [
          ['cert-manager.io'],
          [
            'certificates',
            'certificates/status',
            'certificaterequests',
            'certificaterequests/status',
          ],
          ['update', 'patch'],
        ],
        [[''], ['secrets'], ['get', 'list', 'watch', 'create', 'update', 'delete', 'patch']],
      ],
      { 'app.kubernetes.io/instance': 'cert-manager' },
    ],
    [
      'ingress-nginx',
      [
        [
          [''],
          ['configmaps', 'endpoints', 'nodes', 'pods', 'secrets', 'namespaces'],
          ['list', 'watch'],
        ],
        [['networking.k8s.io'], ['ingresses', 'ingressclasses'], ['get', 'list', 'watch']],
      ],
      { 'app.kubernetes.io/name': 'ingress-nginx' },
    ],
    [
      'platform-readonly',
      [[['*'], ['*'], ['get', 'list', 'watch']]],
      { 'acme.io/managed-by': 'platform-team' },
    ],
  ];
  if (db.profile.argocd)
    clusterRoles.push([
      'argocd-application-controller',
      [
        [['*'], ['*'], ['*']],
        [[], ['*'], ['*']],
      ],
      { 'app.kubernetes.io/part-of': 'argocd' },
    ]);
  for (const [name, r, labels] of clusterRoles) {
    put(
      db,
      obj(
        RBAC,
        'ClusterRole',
        meta({
          name,
          age:
            (name.startsWith('system:') || ['admin', 'edit', 'view', 'cluster-admin'].includes(name)
              ? 400
              : 150) * DAY,
          labels,
          annotations: labels?.['kubernetes.io/bootstrapping']
            ? { 'rbac.authorization.kubernetes.io/autoupdate': 'true' }
            : {},
        }),
        { rules: rules(r) },
      ),
    );
  }
  const crb = (name: string, role: string, subjects: Array<Record<string, string>>) =>
    put(
      db,
      obj(RBAC, 'ClusterRoleBinding', meta({ name, age: 150 * DAY }), {
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: role },
        subjects,
      }),
    );
  crb('cluster-admin', 'cluster-admin', [
    { apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'system:masters' },
  ]);
  crb('system:kube-dns', 'system:kube-dns', [
    { kind: 'ServiceAccount', name: 'coredns', namespace: 'kube-system' },
  ]);
  crb('prometheus-server', 'prometheus-server', [
    { kind: 'ServiceAccount', name: 'prometheus-server', namespace: 'monitoring' },
  ]);
  crb('kube-state-metrics', 'kube-state-metrics', [
    { kind: 'ServiceAccount', name: 'kube-state-metrics', namespace: 'monitoring' },
  ]);
  crb('ingress-nginx', 'ingress-nginx', [
    { kind: 'ServiceAccount', name: 'ingress-nginx', namespace: 'ingress-nginx' },
  ]);
  crb('cert-manager-controller-certificates', 'cert-manager-controller-certificates', [
    { kind: 'ServiceAccount', name: 'cert-manager', namespace: 'cert-manager' },
  ]);
  crb('platform-readonly', 'platform-readonly', [
    { apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'acme:engineering' },
    { apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: 'oncall@acme.io' },
  ]);
  if (db.profile.argocd)
    crb('argocd-application-controller', 'argocd-application-controller', [
      { kind: 'ServiceAccount', name: 'argocd-application-controller', namespace: 'argocd' },
    ]);

  const role = (namespace: string, name: string, r: Rule[]) =>
    put(db, obj(RBAC, 'Role', meta({ name, namespace, age: 120 * DAY }), { rules: rules(r) }));
  const rb = (
    namespace: string,
    name: string,
    kind: 'Role' | 'ClusterRole',
    roleName: string,
    subjects: Array<Record<string, string>>,
  ) =>
    put(
      db,
      obj(RBAC, 'RoleBinding', meta({ name, namespace, age: 120 * DAY }), {
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind, name: roleName },
        subjects,
      }),
    );
  role('checkout', 'payment-api', [
    [[''], ['configmaps'], ['get', 'list', 'watch']],
    [[''], ['secrets'], ['get'], ['payment-api-secrets']],
  ]);
  rb('checkout', 'payment-api', 'Role', 'payment-api', [
    { kind: 'ServiceAccount', name: 'payment-api', namespace: 'checkout' },
  ]);
  role('kube-system', 'cert-manager:leaderelection', [
    [['coordination.k8s.io'], ['leases'], ['get', 'create', 'update', 'patch']],
  ]);
  rb('kube-system', 'cert-manager:leaderelection', 'Role', 'cert-manager:leaderelection', [
    { kind: 'ServiceAccount', name: 'cert-manager', namespace: 'cert-manager' },
  ]);
  role('ingress-nginx', 'ingress-nginx', [
    [[''], ['configmaps', 'pods', 'secrets', 'endpoints'], ['get', 'list', 'watch']],
    [['coordination.k8s.io'], ['leases'], ['get', 'update'], ['ingress-nginx-leader']],
  ]);
  rb('ingress-nginx', 'ingress-nginx', 'Role', 'ingress-nginx', [
    { kind: 'ServiceAccount', name: 'ingress-nginx', namespace: 'ingress-nginx' },
  ]);
  for (const ns of ['checkout', 'web', 'data']) {
    rb(ns, `${ns}-developers`, 'ClusterRole', 'edit', [
      { apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: `acme:${ns}-devs` },
    ]);
  }
  for (const team of db.profile.teams) {
    rb(`team-${team}`, `${team}-admins`, 'ClusterRole', 'admin', [
      { apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: `acme:team-${team}` },
    ]);
  }
}
