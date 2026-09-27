import { accessCheck, ruleAllows } from '@/lib/kube/access';
import type {
  AccessCheck,
  AccessDecision,
  AccessNonResourceRule,
  AccessResourceRule,
  AccessRules,
  Gvk,
  WhoAmI,
} from '@/types';
import { sleep } from './bus';
import { register, type MockArgs } from './registry';

/**
 * Demo RBAC for browser previews: one identity per demo cluster, with the
 * grants a real API server would evaluate.
 *
 *  - prod-eu (EKS): read-only viewer through an EKS access policy. The
 *    webhook authorizer cannot list its rules, so rules reviews are
 *    `incomplete` and only the small RBAC part shows up in them.
 *  - prod-us (EKS): developer with cluster-wide read, `edit` in two team
 *    namespaces and a name-restricted on-call role in `checkout`.
 *  - staging (GKE): `view` everywhere (no secrets), `edit` in checkout and web.
 *  - dev (AKS), kind and any added cluster: cluster-admin.
 */

interface Grant {
  /** How RBAC describes the binding in an "allowed by" reason. */
  via: string;
  rules: AccessResourceRule[];
}

interface Identity {
  who: WhoAmI;
  /** ClusterRoleBindings: listed by rules reviews, apply everywhere. */
  cluster: Grant[];
  /** RoleBindings per namespace. */
  namespaced: Record<string, Grant[]>;
  /** Grants of a webhook authorizer: honoured by reviews, invisible to rules reviews. */
  webhook?: Grant[];
}

type RuleSpec = [groups: string[], resources: string[], verbs: string[], names?: string[]];

const rules = (specs: RuleSpec[]): AccessResourceRule[] =>
  specs.map(([api_groups, resources, verbs, resource_names = []]) => ({
    verbs,
    api_groups,
    resources,
    resource_names,
  }));

const READ = ['get', 'list', 'watch'];
const WRITE = ['create', 'delete', 'deletecollection', 'patch', 'update'];

/** Granted to every authenticated user (system:basic-user, system:discovery). */
const BASIC = rules([
  [['authorization.k8s.io'], ['selfsubjectaccessreviews', 'selfsubjectrulesreviews'], ['create']],
  [['authentication.k8s.io'], ['selfsubjectreviews'], ['create']],
]);
const BASIC_URLS: AccessNonResourceRule[] = [
  {
    verbs: ['get'],
    non_resource_urls: [
      '/api',
      '/api/*',
      '/apis',
      '/apis/*',
      '/healthz',
      '/livez',
      '/openapi',
      '/openapi/*',
      '/readyz',
      '/version',
      '/version/',
    ],
  },
];

/** The bootstrap `view` ClusterRole (abridged). */
const VIEW = rules([
  [
    [''],
    [
      'configmaps',
      'endpoints',
      'persistentvolumeclaims',
      'pods',
      'replicationcontrollers',
      'replicationcontrollers/scale',
      'serviceaccounts',
      'services',
    ],
    READ,
  ],
  [[''], ['bindings', 'events', 'limitranges', 'pods/log', 'pods/status', 'resourcequotas'], READ],
  [[''], ['namespaces'], READ],
  [['discovery.k8s.io'], ['endpointslices'], READ],
  [
    ['apps'],
    [
      'controllerrevisions',
      'daemonsets',
      'deployments',
      'deployments/scale',
      'replicasets',
      'replicasets/scale',
      'statefulsets',
      'statefulsets/scale',
    ],
    READ,
  ],
  [['autoscaling'], ['horizontalpodautoscalers'], READ],
  [['batch'], ['cronjobs', 'jobs'], READ],
  [['policy'], ['poddisruptionbudgets'], READ],
  [['networking.k8s.io'], ['ingresses', 'networkpolicies'], READ],
]);

/** The bootstrap `edit` ClusterRole (abridged; aggregates `view`). */
const EDIT = [
  ...VIEW,
  ...rules([
    [
      [''],
      ['pods/attach', 'pods/exec', 'pods/portforward', 'pods/proxy', 'secrets', 'services/proxy'],
      READ,
    ],
    [[''], ['pods', 'pods/attach', 'pods/exec', 'pods/portforward', 'pods/proxy'], WRITE],
    [[''], ['pods/eviction', 'serviceaccounts/token'], ['create']],
    [
      [''],
      [
        'configmaps',
        'events',
        'persistentvolumeclaims',
        'replicationcontrollers',
        'replicationcontrollers/scale',
        'secrets',
        'serviceaccounts',
        'services',
      ],
      WRITE,
    ],
    [
      ['apps'],
      [
        'daemonsets',
        'deployments',
        'deployments/scale',
        'replicasets',
        'replicasets/scale',
        'statefulsets',
        'statefulsets/scale',
      ],
      WRITE,
    ],
    [['autoscaling'], ['horizontalpodautoscalers'], WRITE],
    [['batch'], ['cronjobs', 'jobs'], WRITE],
    [['networking.k8s.io'], ['ingresses', 'networkpolicies'], WRITE],
    [['policy'], ['poddisruptionbudgets'], WRITE],
  ]),
];

/** Cluster-scoped reads most viewers get alongside `view`. */
const CLUSTER_READER = rules([
  [[''], ['nodes', 'persistentvolumes'], READ],
  [['storage.k8s.io'], ['storageclasses'], READ],
  [['networking.k8s.io'], ['ingressclasses'], READ],
  [['apiextensions.k8s.io'], ['customresourcedefinitions'], READ],
]);

const CRD_READER = rules([
  [['cert-manager.io', 'argoproj.io', 'monitoring.coreos.com'], ['*'], READ],
]);

const CLUSTER_ADMIN = rules([[['*'], ['*'], ['*']]]);

const EKS_EXTRA = (role: string, user: string) => ({
  accessKeyId: ['ASIA4XAMPLE7HQ2W3M'],
  arn: [`arn:aws:sts::123456789012:assumed-role/${role}/${user}`],
  canonicalArn: [`arn:aws:iam::123456789012:role/${role}`],
  principalId: ['AROA4XAMPLEZ6QK7NM3P'],
  sessionName: [user],
});

const IDENTITIES: Record<string, Identity> = {
  'c-prod-eu': {
    who: {
      username: 'arn:aws:sts::123456789012:assumed-role/AcmeReadOnly/erdem',
      uid: 'aws-iam-authenticator:123456789012:AROA4XAMPLEZ6QK7NM3P',
      groups: ['acme:readonly', 'system:authenticated'],
      extra: EKS_EXTRA('AcmeReadOnly', 'erdem'),
    },
    cluster: [
      {
        via: 'ClusterRoleBinding "acme-cluster-reader" of ClusterRole "acme:cluster-reader" to Group "acme:readonly"',
        rules: CLUSTER_READER,
      },
    ],
    namespaced: {},
    webhook: [
      {
        via: 'EKS access policy "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy" (cluster scope)',
        rules: [...VIEW, ...CRD_READER],
      },
    ],
  },
  'c-prod-us': {
    who: {
      username: 'arn:aws:sts::123456789012:assumed-role/AcmeDeveloper/erdem',
      uid: 'aws-iam-authenticator:123456789012:AROA4XAMPLEDEV2K9QX1',
      groups: ['acme:developers', 'system:authenticated'],
      extra: EKS_EXTRA('AcmeDeveloper', 'erdem'),
    },
    cluster: [
      {
        via: 'ClusterRoleBinding "acme-developers-readonly" of ClusterRole "acme:developer-readonly" to Group "acme:developers"',
        rules: [
          ...VIEW.filter((r) => !r.resources.includes('namespaces')),
          ...rules([[[''], ['namespaces', 'nodes'], READ]]),
        ],
      },
    ],
    namespaced: {
      'team-identity': [
        {
          via: 'RoleBinding "developers-edit/team-identity" of ClusterRole "edit" to Group "acme:developers"',
          rules: EDIT,
        },
      ],
      'team-notifications': [
        {
          via: 'RoleBinding "developers-edit/team-notifications" of ClusterRole "edit" to Group "acme:developers"',
          rules: EDIT,
        },
      ],
      checkout: [
        {
          via: 'RoleBinding "checkout-oncall/checkout" of Role "checkout-oncall" to Group "acme:developers"',
          rules: rules([
            [['apps'], ['deployments'], ['patch'], ['checkout-api', 'checkout-worker']],
            [[''], ['secrets'], ['get'], ['checkout-config']],
            [[''], ['pods/exec'], ['create']],
          ]),
        },
      ],
    },
  },
  'c-staging': {
    who: {
      username: 'dev@acme.io',
      uid: null,
      groups: ['staging-devs@acme.io', 'system:authenticated'],
      extra: {
        'iam.gke.io/user-assertion': ['AK8sQQ3yP…redacted'],
        'user-assertion.cloud.google.com': ['AK8sQQ3yP…redacted'],
      },
    },
    cluster: [
      {
        via: 'ClusterRoleBinding "staging-devs-view" of ClusterRole "view" to Group "staging-devs@acme.io"',
        rules: [...VIEW, ...CLUSTER_READER, ...CRD_READER],
      },
    ],
    namespaced: Object.fromEntries(
      ['checkout', 'web'].map((ns) => [
        ns,
        [
          {
            via: `RoleBinding "staging-devs-edit/${ns}" of ClusterRole "edit" to Group "staging-devs@acme.io"`,
            rules: EDIT,
          },
        ],
      ]),
    ),
  },
  'c-dev': {
    who: {
      username: 'erdem@acme.dev',
      uid: null,
      groups: ['3f6c1e0d-8a2b-4c7e-9d2f-1b5a7e9c4d30', 'system:authenticated'],
      extra: { oid: ['a1b2c3d4-5e6f-4a8b-9c0d-e1f2a3b4c5d6'] },
    },
    cluster: [
      {
        via: 'ClusterRoleBinding "aks-cluster-admin-binding-aad" of ClusterRole "cluster-admin" to Group "3f6c1e0d-8a2b-4c7e-9d2f-1b5a7e9c4d30"',
        rules: CLUSTER_ADMIN,
      },
    ],
    namespaced: {},
  },
};

function kindAdmin(): Identity {
  return {
    who: {
      username: 'kubernetes-admin',
      uid: null,
      groups: ['kubeadm:cluster-admins', 'system:authenticated'],
      extra: {},
    },
    cluster: [
      {
        via: 'ClusterRoleBinding "kubeadm:cluster-admins" of ClusterRole "cluster-admin" to Group "kubeadm:cluster-admins"',
        rules: CLUSTER_ADMIN,
      },
    ],
    namespaced: {},
  };
}

function identity(clusterId: string): Identity {
  return IDENTITIES[clusterId] ?? kindAdmin();
}

/** RBAC grants that apply to `check` (RoleBindings only inside their namespace). */
function grantsFor(id: Identity, check: AccessCheck): Grant[] {
  const ns = check.namespace ? (id.namespaced[check.namespace] ?? []) : [];
  return [...id.cluster, ...ns];
}

function isAdmin(id: Identity) {
  return id.cluster.some((g) => g.rules === CLUSTER_ADMIN);
}

/** A SelfSubjectAccessReview answered like the API server would. */
export function mockDecide(clusterId: string, check: AccessCheck): AccessDecision {
  if (!check.verb || !check.resource)
    return { allowed: false, denied: false, reason: null, error: 'verb and resource are required' };
  const id = identity(clusterId);
  for (const grant of [...grantsFor(id, check), ...(id.webhook ?? [])])
    if (grant.rules.some((rule) => ruleAllows(rule, check)))
      return {
        allowed: true,
        denied: false,
        reason: id.webhook?.includes(grant)
          ? `EKS access policy: allowed by ${grant.via}`
          : `RBAC: allowed by ${grant.via}`,
        error: null,
      };
  return { allowed: false, denied: false, reason: null, error: null };
}

export function mockRules(clusterId: string, namespace: string): AccessRules {
  const id = identity(clusterId);
  const grants = [...id.cluster, ...(id.namespaced[namespace] ?? [])];
  return {
    resource_rules: [...BASIC, ...grants.flatMap((g) => g.rules)].map((r) => structuredClone(r)),
    non_resource_rules: isAdmin(id)
      ? [{ verbs: ['*'], non_resource_urls: ['*'] }]
      : structuredClone(BASIC_URLS),
    incomplete: !!id.webhook,
    evaluation_error: id.webhook
      ? 'webhook authorizer does not support user rule resolution'
      : null,
  };
}

/**
 * The 403 a list/watch of `gvk` gets in `namespaces` ([] = cluster-wide),
 * or null when every scope is allowed. Used by the demo resource watches.
 */
export function mockListForbidden(
  clusterId: string,
  gvk: Gvk,
  namespaces: string[],
): string | null {
  const scopes = gvk.namespaced && namespaces.length ? namespaces : [null];
  for (const namespace of scopes) {
    const check = accessCheck('list', gvk, { namespace });
    if (mockDecide(clusterId, check).allowed) continue;
    const user = identity(clusterId).who.username;
    const where = check.namespace
      ? `in the namespace "${check.namespace}"`
      : 'at the cluster scope';
    return `${gvk.plural}${gvk.group ? `.${gvk.group}` : ''} is forbidden: User "${user}" cannot list resource "${gvk.plural}" in API group "${gvk.group}" ${where}`;
  }
  return null;
}

register({
  access_review: async ({ clusterId, checks }: MockArgs) => {
    await sleep(90 + Math.min(400, (checks as AccessCheck[]).length * 2));
    return (checks as AccessCheck[]).map((c) => mockDecide(clusterId, c));
  },
  access_rules: async ({ clusterId, namespace }: MockArgs) => {
    await sleep(110);
    if (!namespace) throw new Error('a namespace is required to list access rules');
    return mockRules(clusterId, namespace);
  },
  access_whoami: async ({ clusterId }: MockArgs) => {
    await sleep(80);
    return structuredClone(identity(clusterId).who);
  },
});
