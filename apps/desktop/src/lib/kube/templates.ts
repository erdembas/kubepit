import type { Gvk } from '@/types';
import { apiVersionOf, kindKey } from './catalog';

/**
 * Starter YAML for the "Create" editor, per kind. Unknown kinds (CRDs) get
 * a minimal apiVersion/kind/metadata skeleton. Kubernetes identifiers stay
 * untranslated.
 */

const TEMPLATES: Record<string, (ns: string) => string> = {
  pods: (ns) => `apiVersion: v1
kind: Pod
metadata:
  name: my-pod
  namespace: ${ns}
  labels:
    app: my-pod
spec:
  containers:
    - name: app
      image: nginx:1.27-alpine
      ports:
        - containerPort: 80
      resources:
        requests:
          cpu: 50m
          memory: 64Mi
        limits:
          memory: 128Mi
`,
  'deployments.apps': (ns) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: ${ns}
  labels:
    app: my-app
spec:
  replicas: 2
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: app
          image: nginx:1.27-alpine
          ports:
            - containerPort: 80
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              memory: 128Mi
`,
  'statefulsets.apps': (ns) => `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: my-db
  namespace: ${ns}
spec:
  serviceName: my-db
  replicas: 1
  selector:
    matchLabels:
      app: my-db
  template:
    metadata:
      labels:
        app: my-db
    spec:
      containers:
        - name: db
          image: postgres:16
          ports:
            - containerPort: 5432
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        resources:
          requests:
            storage: 1Gi
`,
  'daemonsets.apps': (ns) => `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: my-agent
  namespace: ${ns}
spec:
  selector:
    matchLabels:
      app: my-agent
  template:
    metadata:
      labels:
        app: my-agent
    spec:
      tolerations:
        - operator: Exists
      containers:
        - name: agent
          image: busybox:1.37
          command: ["sh", "-c", "while true; do sleep 3600; done"]
`,
  'jobs.batch': (ns) => `apiVersion: batch/v1
kind: Job
metadata:
  name: my-job
  namespace: ${ns}
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: job
          image: busybox:1.37
          command: ["sh", "-c", "echo hello from kubepit"]
`,
  'cronjobs.batch': (ns) => `apiVersion: batch/v1
kind: CronJob
metadata:
  name: my-cronjob
  namespace: ${ns}
spec:
  schedule: "*/15 * * * *"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: job
              image: busybox:1.37
              command: ["sh", "-c", "date"]
`,
  services: (ns) => `apiVersion: v1
kind: Service
metadata:
  name: my-service
  namespace: ${ns}
spec:
  type: ClusterIP
  selector:
    app: my-app
  ports:
    - name: http
      port: 80
      targetPort: 80
`,
  'ingresses.networking.k8s.io': (ns) => `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-ingress
  namespace: ${ns}
spec:
  ingressClassName: nginx
  rules:
    - host: my-app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-service
                port:
                  number: 80
`,
  configmaps: (ns) => `apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
  namespace: ${ns}
data:
  LOG_LEVEL: info
  app.properties: |
    feature.enabled=true
`,
  secrets: (ns) => `apiVersion: v1
kind: Secret
metadata:
  name: my-secret
  namespace: ${ns}
type: Opaque
stringData:
  username: admin
  password: change-me
`,
  persistentvolumeclaims: (ns) => `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-claim
  namespace: ${ns}
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
`,
  namespaces: () => `apiVersion: v1
kind: Namespace
metadata:
  name: my-namespace
`,
  serviceaccounts: (ns) => `apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-service-account
  namespace: ${ns}
`,
  'horizontalpodautoscalers.autoscaling': (ns) => `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: my-app
  namespace: ${ns}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
`,
};

export function templateFor(gvk: Gvk | null, namespace: string | null): string {
  const ns = namespace ?? 'default';
  if (!gvk) return TEMPLATES['deployments.apps']!(ns);
  const t = TEMPLATES[kindKey(gvk)];
  if (t) return t(ns);
  return `apiVersion: ${apiVersionOf(gvk)}
kind: ${gvk.kind}
metadata:
  name: my-${gvk.kind.toLowerCase()}
${gvk.namespaced ? `  namespace: ${ns}\n` : ''}spec: {}
`;
}
