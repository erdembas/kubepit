import type { ManifestHelmOptions } from '@/types';

/**
 * A fictional GitOps repository for the demo backend's "Manifests" tab:
 * plain manifests at the root (a new namespace and app, edits to objects
 * the demo clusters already run, one invalid Deployment, an Argo CD
 * Application that only some clusters serve), two Kustomize overlays and a
 * Helm chart. Any picked path renders as this project.
 */

export interface ProjectFile {
  path: string;
  text: string;
}

export const PLAIN_FILES: ProjectFile[] = [
  {
    path: 'namespace.yaml',
    text: `apiVersion: v1
kind: Namespace
metadata:
  name: storefront-v2
  labels:
    team: web
    istio-injection: enabled
`,
  },
  {
    path: 'storefront/api.yaml',
    text: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: storefront-api
  namespace: storefront-v2
  labels:
    app: storefront-api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: storefront-api
  template:
    metadata:
      labels:
        app: storefront-api
    spec:
      containers:
        - name: api
          image: ghcr.io/acme/storefront-api:1.4.0
          ports:
            - containerPort: 8080
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits: { memory: 512Mi }
---
apiVersion: v1
kind: Service
metadata:
  name: storefront-api
  namespace: storefront-v2
spec:
  selector:
    app: storefront-api
  ports:
    - name: http
      port: 80
      targetPort: 8080
`,
  },
  {
    path: 'storefront/worker.yaml',
    text: `# Broken on purpose: the selector does not match the template labels.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: storefront-worker
  namespace: storefront-v2
spec:
  replicas: 1
  selector:
    matchLabels:
      app: storefront-worker
  template:
    metadata:
      labels:
        app: worker
    spec:
      containers:
        - name: worker
          image: ghcr.io/acme/storefront-worker:1.4.0
`,
  },
  {
    path: 'checkout/payment-api-config.yaml',
    text: `apiVersion: v1
kind: ConfigMap
metadata:
  name: payment-api-config
  namespace: checkout
data:
  feature-flags: apple-pay=true,klarna=true,3ds2=true
  log-level: DEBUG
`,
  },
  {
    path: 'checkout/cart-service.yaml',
    text: `apiVersion: v1
kind: Service
metadata:
  name: cart-service
  namespace: checkout
spec:
  selector:
    app: cart-service
`,
  },
  {
    path: 'checkout/cart-service-pdb.yaml',
    text: `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: cart-service
  namespace: checkout
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: cart-service
`,
  },
  {
    path: 'argocd/storefront-app.yaml',
    text: `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: storefront
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/acme/shop-deploy
    path: overlays/prod
    targetRevision: main
  destination:
    server: https://kubernetes.default.svc
    namespace: storefront-v2
`,
  },
  {
    path: 'docs/ownership.yaml',
    text: `# Not a Kubernetes object: skipped with a warning.
owners:
  - team: web
    slack: "#storefront"
`,
  },
  {
    path: 'legacy/cron.yaml',
    text: `apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly-report
spec:
	schedule: "0 2 * * *"
`,
  },
];

export const NESTED = [
  { relative: 'charts/storefront', kind: 'helm' as const },
  { relative: 'overlays/prod', kind: 'kustomize' as const },
  { relative: 'overlays/staging', kind: 'kustomize' as const },
];

/** `kubectl kustomize overlays/<env>` output. */
export function overlayOutput(env: 'prod' | 'staging'): string {
  const replicas = env === 'prod' ? 4 : 1;
  const hash = env === 'prod' ? 'b7k9m4c2th' : 'f5g8d2kk7m';
  return `apiVersion: v1
kind: Namespace
metadata:
  labels:
    env: ${env}
    team: web
  name: storefront-v2
---
apiVersion: v1
data:
  API_BASE_URL: https://api.${env === 'prod' ? 'acme.com' : 'staging.acme.dev'}
  LOG_LEVEL: ${env === 'prod' ? 'info' : 'debug'}
kind: ConfigMap
metadata:
  labels:
    env: ${env}
  name: storefront-config-${hash}
  namespace: storefront-v2
---
apiVersion: v1
kind: Service
metadata:
  labels:
    env: ${env}
  name: storefront-api
  namespace: storefront-v2
spec:
  ports:
  - name: http
    port: 80
    targetPort: 8080
  selector:
    app: storefront-api
    env: ${env}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    env: ${env}
  name: storefront-api
  namespace: storefront-v2
spec:
  replicas: ${replicas}
  selector:
    matchLabels:
      app: storefront-api
      env: ${env}
  template:
    metadata:
      labels:
        app: storefront-api
        env: ${env}
    spec:
      containers:
      - envFrom:
        - configMapRef:
            name: storefront-config-${hash}
        image: ghcr.io/acme/storefront-api:${env === 'prod' ? '1.4.0' : '1.5.0-rc.1'}
        name: api
`;
}

export const CHART_VALUES_FILES = ['values.yaml', 'values-prod.yaml', 'values-staging.yaml'];

/** `helm template <release> charts/storefront` output. */
export function chartOutput(
  options: Required<Omit<ManifestHelmOptions, 'namespace'>> & {
    namespace: string;
  },
): string {
  const { release_name: release, namespace, values_files: values } = options;
  const prod = values.some((v) => v.includes('prod'));
  const staging = values.some((v) => v.includes('staging'));
  const replicas = prod ? 3 : 1;
  const tag = staging ? '1.5.0-rc.1' : '1.4.0';
  const labels = `    app.kubernetes.io/name: storefront
    app.kubernetes.io/instance: ${release}
    app.kubernetes.io/version: "${tag}"
    app.kubernetes.io/managed-by: Helm
    helm.sh/chart: storefront-0.4.2`;
  return `---
# Source: storefront/templates/serviceaccount.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${release}
  namespace: ${namespace}
  labels:
${labels}
---
# Source: storefront/templates/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${release}-config
  namespace: ${namespace}
  labels:
${labels}
data:
  LOG_LEVEL: ${prod ? 'info' : 'debug'}
---
# Source: storefront/templates/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: ${release}
  namespace: ${namespace}
  labels:
${labels}
spec:
  type: ClusterIP
  ports:
    - port: 80
      targetPort: http
      name: http
  selector:
    app.kubernetes.io/name: storefront
    app.kubernetes.io/instance: ${release}
---
# Source: storefront/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${release}
  namespace: ${namespace}
  labels:
${labels}
spec:
  replicas: ${replicas}
  selector:
    matchLabels:
      app.kubernetes.io/name: storefront
      app.kubernetes.io/instance: ${release}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: storefront
        app.kubernetes.io/instance: ${release}
    spec:
      serviceAccountName: ${release}
      containers:
        - name: storefront
          image: "ghcr.io/acme/storefront-api:${tag}"
          ports:
            - name: http
              containerPort: 8080
`;
}
