import { put, type ClusterDb } from './db';
import { hasFlux } from './gitops';
import { ago, between, DAY, hexId, iso, meta, obj } from './util';

/** Cluster-scoped infrastructure: namespaces, classes, webhooks, leader leases. */

export const BASE_NAMESPACES = [
  'default',
  'kube-system',
  'kube-public',
  'kube-node-lease',
  'checkout',
  'web',
  'data',
  'monitoring',
  'ingress-nginx',
  'cert-manager',
];

export function namespacesFor(db: ClusterDb): string[] {
  const p = db.profile;
  const out = [...BASE_NAMESPACES];
  if (p.argocd) out.push('argocd');
  if (hasFlux(db)) out.push('flux-system');
  if (p.platform === 'kind') out.push('local-path-storage');
  for (const t of p.teams) out.push(`team-${t}`);
  return out;
}

export function buildNamespaces(db: ClusterDb) {
  namespacesFor(db).forEach((name, i) => {
    const system = name.startsWith('kube-') || name === 'default';
    put(
      db,
      obj(
        'v1',
        'Namespace',
        meta({
          name,
          age: (system ? 420 : 300 - i * 9) * DAY,
          labels: {
            'kubernetes.io/metadata.name': name,
            ...(name.startsWith('team-')
              ? { team: name.slice(5), 'acme.io/cost-center': `cc-${1000 + i}` }
              : {}),
            ...(['checkout', 'web'].includes(name)
              ? { 'pod-security.kubernetes.io/enforce': 'baseline' }
              : {}),
          },
        }),
        { spec: { finalizers: ['kubernetes'] }, status: { phase: 'Active' } },
      ),
    );
  });
}

export function buildClasses(db: ClusterDb) {
  const p = db.profile;
  const classes: Array<[string, string, boolean, string, Record<string, string>]> =
    p.platform === 'EKS'
      ? [
          [
            'gp3',
            'ebs.csi.aws.com',
            true,
            'Delete',
            { type: 'gp3', fsType: 'ext4', encrypted: 'true' },
          ],
          ['gp2', 'kubernetes.io/aws-ebs', false, 'Delete', { type: 'gp2', fsType: 'ext4' }],
          [
            'efs',
            'efs.csi.aws.com',
            false,
            'Retain',
            { provisioningMode: 'efs-ap', fileSystemId: `fs-0${hexId(db.rand, 16)}` },
          ],
        ]
      : p.platform === 'GKE'
        ? [
            ['standard-rwo', 'pd.csi.storage.gke.io', true, 'Delete', { type: 'pd-balanced' }],
            ['premium-rwo', 'pd.csi.storage.gke.io', false, 'Delete', { type: 'pd-ssd' }],
            ['standard', 'kubernetes.io/gce-pd', false, 'Delete', { type: 'pd-standard' }],
          ]
        : p.platform === 'AKS'
          ? [
              ['managed-csi', 'disk.csi.azure.com', true, 'Delete', { skuname: 'StandardSSD_LRS' }],
              [
                'managed-csi-premium',
                'disk.csi.azure.com',
                false,
                'Delete',
                { skuname: 'Premium_LRS' },
              ],
              ['azurefile-csi', 'file.csi.azure.com', false, 'Delete', { skuName: 'Standard_LRS' }],
            ]
          : [['standard', 'rancher.io/local-path', true, 'Delete', {}]];
  for (const [name, provisioner, isDefault, reclaim, parameters] of classes) {
    put(
      db,
      obj(
        'storage.k8s.io/v1',
        'StorageClass',
        meta({
          name,
          age: 300 * DAY,
          annotations: isDefault ? { 'storageclass.kubernetes.io/is-default-class': 'true' } : {},
        }),
        {
          provisioner,
          parameters,
          reclaimPolicy: reclaim,
          volumeBindingMode:
            p.platform === 'kind' ? 'WaitForFirstConsumer' : 'WaitForFirstConsumer',
          allowVolumeExpansion: p.platform !== 'kind',
        },
      ),
    );
  }
  const priorities: Array<[string, number, boolean, string]> = [
    [
      'system-cluster-critical',
      2000000000,
      false,
      'Used for system critical pods that must run in the cluster, but can be moved to another node if necessary.',
    ],
    [
      'system-node-critical',
      2000001000,
      false,
      'Used for system critical pods that must not be moved from their current node.',
    ],
    ['high-priority', 100000, false, 'Customer-facing services that must preempt batch work.'],
    ['batch-low', -10, false, 'Best-effort batch jobs.'],
  ];
  for (const [name, value, globalDefault, description] of priorities) {
    put(
      db,
      obj('scheduling.k8s.io/v1', 'PriorityClass', meta({ name, age: 300 * DAY }), {
        value,
        globalDefault,
        description,
        preemptionPolicy: 'PreemptLowerPriority',
      }),
    );
  }
  put(
    db,
    obj('node.k8s.io/v1', 'RuntimeClass', meta({ name: 'runc', age: 200 * DAY }), {
      handler: 'runc',
    }),
  );
  if (p.gpuNodes)
    put(
      db,
      obj('node.k8s.io/v1', 'RuntimeClass', meta({ name: 'nvidia', age: 90 * DAY }), {
        handler: 'nvidia',
        scheduling: { nodeSelector: { 'nvidia.com/gpu.present': 'true' } },
      }),
    );
  if (p.platform === 'GKE')
    put(
      db,
      obj('node.k8s.io/v1', 'RuntimeClass', meta({ name: 'gvisor', age: 120 * DAY }), {
        handler: 'gvisor',
        overhead: { podFixed: { cpu: '250m', memory: '64Mi' } },
      }),
    );
  put(
    db,
    obj(
      'networking.k8s.io/v1',
      'IngressClass',
      meta({
        name: 'nginx',
        age: 200 * DAY,
        labels: { 'app.kubernetes.io/name': 'ingress-nginx' },
        annotations: { 'ingressclass.kubernetes.io/is-default-class': 'true' },
      }),
      {
        spec: { controller: 'k8s.io/ingress-nginx' },
      },
    ),
  );
  if (p.platform === 'EKS')
    put(
      db,
      obj('networking.k8s.io/v1', 'IngressClass', meta({ name: 'alb', age: 180 * DAY }), {
        spec: { controller: 'ingress.k8s.aws/alb' },
      }),
    );
}

export function buildWebhooks(db: ClusterDb) {
  const hook = (
    name: string,
    service: string,
    namespace: string,
    path: string,
    rules: Array<Record<string, unknown>>,
  ) => ({
    name,
    admissionReviewVersions: ['v1'],
    clientConfig: {
      service: { name: service, namespace, path, port: 443 },
      caBundle: 'LS0tLS1CRUdJTi...',
    },
    failurePolicy: 'Fail',
    matchPolicy: 'Equivalent',
    sideEffects: 'None',
    timeoutSeconds: 10,
    rules,
    namespaceSelector: {},
    objectSelector: {},
  });
  const certRules = [
    {
      apiGroups: ['cert-manager.io', 'acme.cert-manager.io'],
      apiVersions: ['v1'],
      operations: ['CREATE', 'UPDATE'],
      resources: ['*/*'],
      scope: '*',
    },
  ];
  put(
    db,
    obj(
      'admissionregistration.k8s.io/v1',
      'MutatingWebhookConfiguration',
      meta({
        name: 'cert-manager-webhook',
        age: 150 * DAY,
        labels: { 'app.kubernetes.io/instance': 'cert-manager' },
      }),
      {
        webhooks: [
          {
            ...hook(
              'webhook.cert-manager.io',
              'cert-manager-webhook',
              'cert-manager',
              '/mutate',
              certRules,
            ),
            reinvocationPolicy: 'Never',
          },
        ],
      },
    ),
  );
  put(
    db,
    obj(
      'admissionregistration.k8s.io/v1',
      'ValidatingWebhookConfiguration',
      meta({
        name: 'cert-manager-webhook',
        age: 150 * DAY,
        labels: { 'app.kubernetes.io/instance': 'cert-manager' },
      }),
      {
        webhooks: [
          hook(
            'webhook.cert-manager.io',
            'cert-manager-webhook',
            'cert-manager',
            '/validate',
            certRules,
          ),
        ],
      },
    ),
  );
  put(
    db,
    obj(
      'admissionregistration.k8s.io/v1',
      'ValidatingWebhookConfiguration',
      meta({
        name: 'ingress-nginx-admission',
        age: 200 * DAY,
        labels: { 'app.kubernetes.io/component': 'admission-webhook' },
      }),
      {
        webhooks: [
          hook(
            'validate.nginx.ingress.kubernetes.io',
            'ingress-nginx-controller-admission',
            'ingress-nginx',
            '/networking/v1/ingresses',
            [
              {
                apiGroups: ['networking.k8s.io'],
                apiVersions: ['v1'],
                operations: ['CREATE', 'UPDATE'],
                resources: ['ingresses'],
                scope: '*',
              },
            ],
          ),
        ],
      },
    ),
  );
  if (db.profile.platform === 'EKS')
    put(
      db,
      obj(
        'admissionregistration.k8s.io/v1',
        'MutatingWebhookConfiguration',
        meta({ name: 'pod-identity-webhook', age: 300 * DAY }),
        {
          webhooks: [
            hook('iam-for-pods.amazonaws.com', 'pod-identity-webhook', 'kube-system', '/mutate', [
              {
                apiGroups: [''],
                apiVersions: ['v1'],
                operations: ['CREATE'],
                resources: ['pods'],
                scope: '*',
              },
            ]),
          ],
        },
      ),
    );
}

export function buildLeaderLeases(db: ClusterDb) {
  const leases: Array<[string, string]> = [
    ['kube-system', 'kube-controller-manager'],
    ['kube-system', 'kube-scheduler'],
    ['cert-manager', 'cert-manager-controller'],
    ['ingress-nginx', 'ingress-nginx-leader'],
  ];
  for (const [namespace, name] of leases) {
    put(
      db,
      obj('coordination.k8s.io/v1', 'Lease', meta({ name, namespace, age: 60 * DAY }), {
        spec: {
          holderIdentity: `${name}-${hexId(db.rand, 8)}_${crypto.randomUUID()}`,
          leaseDurationSeconds: 15,
          acquireTime: ago(between(db.rand, 1, 20) * DAY),
          renewTime: iso(Date.now() - between(db.rand, 1, 5) * 1000),
          leaseTransitions: between(db.rand, 1, 30),
        },
      }),
    );
  }
}
