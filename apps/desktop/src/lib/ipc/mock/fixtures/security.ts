import { buildDeployment } from './builders';
import { syncReplicaSet } from './controllers';
import { drop, find, list, ownedBy, put, type ClusterDb } from './db';
import { makePod } from './pods';
import { buildPolicyReports } from './policyReports';
import { tpl } from './template';
import { buildTrivy } from './trivy';
import { DAY, HOUR, meta, obj } from './util';

/**
 * Security demo data: Pod Security labels on namespaces (with workloads
 * that violate them), a few risky RBAC grants for the health checks and
 * "who can", the Trivy Operator reports and the policy reports (both
 * built last, so they cover everything above).
 */

const PSS = 'pod-security.kubernetes.io/';
const RBAC = 'rbac.authorization.k8s.io/v1';

const NAMESPACE_LABELS: Record<string, Record<string, string>> = {
  'kube-system': { [`${PSS}enforce`]: 'privileged' },
  monitoring: { [`${PSS}enforce`]: 'privileged', [`${PSS}warn`]: 'baseline' },
  default: { [`${PSS}audit`]: 'baseline', [`${PSS}warn`]: 'baseline' },
  checkout: {
    [`${PSS}enforce`]: 'baseline',
    [`${PSS}audit`]: 'restricted',
    [`${PSS}warn`]: 'restricted',
  },
  web: {
    [`${PSS}enforce`]: 'baseline',
    [`${PSS}warn`]: 'restricted',
    [`${PSS}warn-version`]: 'v1.31',
  },
  data: { [`${PSS}audit`]: 'restricted', [`${PSS}warn`]: 'restricted' },
  'ingress-nginx': { [`${PSS}enforce`]: 'baseline' },
};

function labelNamespaces(db: ClusterDb) {
  for (const ns of list(db, 'namespaces')) {
    const name = ns.metadata.name;
    const extra =
      NAMESPACE_LABELS[name] ??
      (name.startsWith('team-')
        ? { [`${PSS}enforce`]: 'baseline', [`${PSS}enforce-version`]: 'v1.30' }
        : null);
    if (!extra) continue;
    ns.metadata.labels = { ...ns.metadata.labels, ...extra };
    put(db, ns);
  }
}

/** Workloads that show local evaluation next to what the API server reports. */
function podSecurityWorkloads(db: ClusterDb) {
  // A debug Deployment whose template violates `web`'s enforced baseline:
  // the ReplicaSet cannot create its pod.
  const netshoot = tpl(
    'netshoot-debug',
    [
      {
        name: 'netshoot',
        image: 'docker.io/nicolaka/netshoot:v0.13',
        command: ['sleep', 'infinity'],
      },
    ],
    { hostNetwork: true, labels: { team: 'web' } },
  );
  (netshoot.spec.containers as Array<Record<string, unknown>>)[0]!.securityContext = {
    capabilities: { add: ['NET_ADMIN', 'NET_RAW'] },
  };
  const dep = buildDeployment(db, {
    namespace: 'web',
    name: 'netshoot-debug',
    age: 2 * DAY,
    replicas: 1,
    template: netshoot,
  });
  const message =
    'pods "netshoot-debug-" is forbidden: violates PodSecurity "baseline:latest": host namespaces (hostNetwork=true, hostPID=true), non-default capabilities (container "netshoot" must not include "NET_ADMIN" in securityContext.capabilities.add)';
  for (const rs of ownedBy(db, 'replicasets.apps', dep)) {
    for (const pod of ownedBy(db, 'pods', rs)) drop(db, pod);
    syncReplicaSet(db, rs);
    rs.status = {
      ...rs.status,
      conditions: [
        {
          type: 'ReplicaFailure',
          status: 'True',
          reason: 'FailedCreate',
          message,
          lastTransitionTime: new Date(Date.now() - 2 * DAY).toISOString(),
        },
      ],
    };
    put(db, rs);
  }

  // A bare pod started before `checkout` enforced baseline: still running,
  // but the API server would reject it if it were recreated.
  const tcpdump = tpl('tcpdump-oncall', [
    { name: 'tcpdump', image: 'docker.io/corfr/tcpdump:latest', command: ['tcpdump', '-i', 'any'] },
  ]);
  tcpdump.spec.hostPID = true;
  tcpdump.spec.securityContext = {};
  (tcpdump.spec.containers as Array<Record<string, unknown>>)[0]!.securityContext = {
    capabilities: { add: ['NET_ADMIN'] },
  };
  put(
    db,
    makePod(db, {
      namespace: 'checkout',
      name: 'tcpdump-oncall',
      owner: null,
      template: tcpdump,
      age: 9 * HOUR,
    }),
  );

  // A workload that already passes restricted.
  const hardened = tpl(
    'quota-api',
    [
      {
        name: 'api',
        image: 'ghcr.io/acme/quota-api:1.4.0',
        ports: [8080],
        cpu: ['50m', '200m'],
        mem: ['64Mi', '128Mi'],
        probe: 'http',
      },
    ],
    { labels: { team: 'data' } },
  );
  hardened.spec.securityContext = {
    runAsNonRoot: true,
    runAsUser: 10001,
    seccompProfile: { type: 'RuntimeDefault' },
  };
  (hardened.spec.containers as Array<Record<string, unknown>>)[0]!.securityContext = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ['ALL'] },
  };
  buildDeployment(db, {
    namespace: 'data',
    name: 'quota-api',
    age: 20 * DAY,
    replicas: 2,
    template: hardened,
  });
}

type Rule = [string[], string[], string[], string[]?];

const rules = (list: Rule[]) =>
  list.map(([apiGroups, resources, verbs, resourceNames]) => ({
    apiGroups,
    resources,
    verbs,
    ...(resourceNames ? { resourceNames } : {}),
  }));

/** Grants the RBAC health checks flag, plus a group binding and a dangling binding. */
function riskyRbac(db: ClusterDb) {
  const sa = (namespace: string, name: string) => {
    if (!find(db, 'serviceaccounts', namespace, name))
      put(db, obj('v1', 'ServiceAccount', meta({ name, namespace, age: 90 * DAY })));
  };
  const clusterRole = (name: string, r: Rule[]) =>
    put(db, obj(RBAC, 'ClusterRole', meta({ name, age: 90 * DAY }), { rules: rules(r) }));
  const crb = (name: string, role: string, subjects: Array<Record<string, string>>) =>
    put(
      db,
      obj(RBAC, 'ClusterRoleBinding', meta({ name, age: 90 * DAY }), {
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: role },
        subjects,
      }),
    );
  const role = (namespace: string, name: string, r: Rule[]) =>
    put(db, obj(RBAC, 'Role', meta({ name, namespace, age: 60 * DAY }), { rules: rules(r) }));
  const rb = (
    namespace: string,
    name: string,
    kind: 'Role' | 'ClusterRole',
    roleName: string,
    subjects: Array<Record<string, string>>,
  ) =>
    put(
      db,
      obj(RBAC, 'RoleBinding', meta({ name, namespace, age: 60 * DAY }), {
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind, name: roleName },
        subjects,
      }),
    );
  const group = (name: string) => ({ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name });
  const user = (name: string) => ({ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name });

  sa('default', 'gitlab-runner');
  clusterRole('ci-deployer', [
    [
      ['apps'],
      ['deployments', 'statefulsets', 'daemonsets'],
      ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
    ],
    [[''], ['pods'], ['get', 'list', 'watch', 'create', 'delete']],
    [[''], ['services', 'configmaps'], ['*']],
    [[''], ['secrets'], ['get', 'list']],
  ]);
  crb('ci-deployer', 'ci-deployer', [
    { kind: 'ServiceAccount', name: 'gitlab-runner', namespace: 'default' },
  ]);

  clusterRole('sre-impersonator', [
    [[''], ['users', 'groups', 'serviceaccounts'], ['impersonate']],
  ]);
  crb('sre-impersonation', 'sre-impersonator', [group('acme:sre')]);

  clusterRole('node-debugger', [
    [[''], ['nodes'], ['get', 'list']],
    [[''], ['nodes/proxy'], ['get']],
  ]);
  crb('node-debugger', 'node-debugger', [user('alice@acme.io')]);

  crb('legacy-admin', 'cluster-admin', [user('bob@acme.io')]);

  sa('default', 'rbac-sync');
  clusterRole('rbac-manager', [
    [
      ['rbac.authorization.k8s.io'],
      ['roles', 'rolebindings', 'clusterroles', 'clusterrolebindings'],
      ['get', 'list', 'watch', 'create', 'update', 'escalate', 'bind'],
    ],
  ]);
  crb('rbac-sync', 'rbac-manager', [
    { kind: 'ServiceAccount', name: 'rbac-sync', namespace: 'default' },
  ]);

  sa('default', 'debug-toolbox');
  role('kube-system', 'debug-tools', [
    [[''], ['pods'], ['get', 'list', 'create', 'delete']],
    [[''], ['pods/exec', 'pods/attach'], ['create']],
  ]);
  rb('kube-system', 'debug-tools', 'Role', 'debug-tools', [
    { kind: 'ServiceAccount', name: 'debug-toolbox', namespace: 'default' },
  ]);

  role('web', 'secret-reader', [[[''], ['secrets'], ['get', 'list', 'watch']]]);
  rb('web', 'web-service-accounts-read-secrets', 'Role', 'secret-reader', [
    group('system:serviceaccounts:web'),
  ]);

  // Points at a Role that was deleted.
  rb('checkout', 'old-deployer', 'Role', 'deployer', [
    { kind: 'ServiceAccount', name: 'default', namespace: 'checkout' },
  ]);
}

export function buildSecurityDemo(db: ClusterDb) {
  labelNamespaces(db);
  if (db.profile.troubled) {
    podSecurityWorkloads(db);
    riskyRbac(db);
  }
  buildTrivy(db);
  buildPolicyReports(db);
}
