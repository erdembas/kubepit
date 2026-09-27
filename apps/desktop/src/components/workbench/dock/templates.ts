/**
 * Starter manifests for the "Create resource" editor. The YAML is Kubernetes
 * content and stays English; namespaced objects omit `metadata.namespace`
 * so the editor's target namespace fills it on apply.
 */
export interface ResourceTemplate {
  id: string;
  /** Kind shown in the picker (not translated). */
  label: string;
  yaml: string;
}

export const RESOURCE_TEMPLATES: ResourceTemplate[] = [
  {
    id: 'pod',
    label: 'Pod',
    yaml: `apiVersion: v1
kind: Pod
metadata:
  name: my-pod
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
  },
  {
    id: 'deployment',
    label: 'Deployment',
    yaml: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
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
          readinessProbe:
            httpGet:
              path: /
              port: 80
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              memory: 256Mi
`,
  },
  {
    id: 'service',
    label: 'Service',
    yaml: `apiVersion: v1
kind: Service
metadata:
  name: my-app
spec:
  type: ClusterIP
  selector:
    app: my-app
  ports:
    - name: http
      port: 80
      targetPort: 80
      protocol: TCP
`,
  },
  {
    id: 'ingress',
    label: 'Ingress',
    yaml: `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app
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
                name: my-app
                port:
                  number: 80
`,
  },
  {
    id: 'configmap',
    label: 'ConfigMap',
    yaml: `apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
data:
  LOG_LEVEL: info
  app.properties: |
    feature.enabled=true
    cache.ttl=300
`,
  },
  {
    id: 'secret',
    label: 'Secret',
    yaml: `apiVersion: v1
kind: Secret
metadata:
  name: my-secret
type: Opaque
stringData:
  username: admin
  password: change-me
`,
  },
  {
    id: 'job',
    label: 'Job',
    yaml: `apiVersion: batch/v1
kind: Job
metadata:
  name: my-job
spec:
  backoffLimit: 3
  ttlSecondsAfterFinished: 3600
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: job
          image: busybox:1.36
          command: ["sh", "-c", "echo Hello from Kubernetes && sleep 5"]
`,
  },
  {
    id: 'cronjob',
    label: 'CronJob',
    yaml: `apiVersion: batch/v1
kind: CronJob
metadata:
  name: my-cronjob
spec:
  schedule: "*/15 * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: job
              image: busybox:1.36
              command: ["sh", "-c", "date; echo Hello from the cron job"]
`,
  },
  {
    id: 'pvc',
    label: 'PersistentVolumeClaim',
    yaml: `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-data
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
  # storageClassName: standard
`,
  },
  {
    id: 'namespace',
    label: 'Namespace',
    yaml: `apiVersion: v1
kind: Namespace
metadata:
  name: my-namespace
  labels:
    name: my-namespace
`,
  },
  {
    id: 'serviceaccount',
    label: 'ServiceAccount',
    yaml: `apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-service-account
automountServiceAccountToken: false
`,
  },
  {
    id: 'rbac',
    label: 'Role + RoleBinding',
    yaml: `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-reader
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: pod-reader
subjects:
  - kind: ServiceAccount
    name: my-service-account
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: pod-reader
`,
  },
];
