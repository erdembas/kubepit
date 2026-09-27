import type { OpenApiDocument, OpenApiGvk, OpenApiIndex, OpenApiSchema } from '@/types';
import type { ClusterDb } from './db';
import { apiResources } from './discovery';
import { hashString } from './util';

/**
 * A small handcrafted OpenAPI v3 subset for the demo backend, shaped like
 * a real API server's documents (definitions referenced through
 * `allOf: [{$ref}]`, `oneOf` unions for Quantity / IntOrString, `+enum`
 * values, list-map keys): core v1 Pod, Service, ConfigMap, Secret and
 * Namespace, apps/v1 Deployment, batch/v1 Job and CronJob, and the
 * cert-manager Certificate CRD. Every other served kind gets a minimal
 * schema (apiVersion, kind, metadata; the rest is preserve-unknown).
 * Descriptions are abridged.
 */

type S = OpenApiSchema;

const META = 'io.k8s.apimachinery.pkg.apis.meta.v1';
const CORE = 'io.k8s.api.core.v1';
const APPS = 'io.k8s.api.apps.v1';
const BATCH = 'io.k8s.api.batch.v1';

const ref = (name: string, description?: string, extra: S = {}): S => ({
  allOf: [{ $ref: `#/components/schemas/${name}` }],
  ...(description ? { description } : {}),
  ...extra,
});
const str = (description: string, extra: S = {}): S => ({ type: 'string', description, ...extra });
const int = (description: string, extra: S = {}): S => ({
  type: 'integer',
  format: 'int32',
  description,
  ...extra,
});
const bool = (description: string, extra: S = {}): S => ({
  type: 'boolean',
  description,
  ...extra,
});
const oneOf = (description: string, values: string[], extra: S = {}): S => ({
  type: 'string',
  enum: values,
  description,
  ...extra,
});
const strings = (description: string, extra: S = {}): S => ({
  type: 'array',
  items: { type: 'string', default: '' },
  description,
  ...extra,
});
const list = (description: string, item: string, extra: S = {}): S => ({
  type: 'array',
  items: ref(item, undefined, { default: {} }),
  description,
  ...extra,
});
const stringMap = (description: string): S => ({
  type: 'object',
  additionalProperties: { type: 'string', default: '' },
  description,
});
const obj = (description: string, properties: Record<string, S>, required?: string[]): S => ({
  type: 'object',
  description,
  properties,
  ...(required ? { required } : {}),
});
const kindOf = (group: string, version: string, kind: string): OpenApiGvk[] => [
  { group, version, kind },
];
const typeMeta = {
  apiVersion: str('APIVersion defines the versioned schema of this representation of an object.'),
  kind: str('Kind is a string value representing the REST resource this object represents.'),
};
const metadata = ref(`${META}.ObjectMeta`, 'Standard object metadata.', { default: {} });

const SHARED: Record<string, S> = {
  [`${META}.Time`]: {
    type: 'string',
    format: 'date-time',
    description: 'A timestamp in RFC 3339 form.',
  },
  'io.k8s.apimachinery.pkg.api.resource.Quantity': {
    description: 'A fixed-point representation of a number, such as 500m CPU or 128Mi of memory.',
    oneOf: [{ type: 'string' }, { type: 'number' }],
  },
  'io.k8s.apimachinery.pkg.util.intstr.IntOrString': {
    description: 'A value that can hold an int32 or a string.',
    format: 'int-or-string',
    oneOf: [{ type: 'integer' }, { type: 'string' }],
  },
  [`${META}.OwnerReference`]: obj(
    'Enough information to identify an owning object.',
    {
      apiVersion: str('API version of the referent.', { default: '' }),
      kind: str('Kind of the referent.', { default: '' }),
      name: str('Name of the referent.', { default: '' }),
      uid: str('UID of the referent.', { default: '' }),
      controller: bool('If true, this reference points to the managing controller.'),
      blockOwnerDeletion: bool(
        'If true, the owner cannot be deleted from the key-value store until this reference is removed.',
      ),
    },
    ['apiVersion', 'kind', 'name', 'uid'],
  ),
  [`${META}.ObjectMeta`]: obj('Metadata that all persisted resources must have.', {
    name: str('Name must be unique within a namespace.'),
    generateName: str('Optional prefix used by the server to generate a unique name.'),
    namespace: str('The namespace the object lives in. An empty namespace is "default".'),
    labels: stringMap('Map of string keys and values used to organize and select objects.'),
    annotations: stringMap('Unstructured key-value map for arbitrary metadata.'),
    uid: str('Unique id of this object, set by the server. Read-only.'),
    resourceVersion: str('Opaque value that represents the internal version of the object.'),
    generation: {
      type: 'integer',
      format: 'int64',
      description: 'Generation of the desired state.',
    },
    creationTimestamp: ref(`${META}.Time`, 'When the object was created. Read-only.'),
    deletionTimestamp: ref(`${META}.Time`, 'When the object will be deleted. Read-only.'),
    ownerReferences: list('Objects this object depends on.', `${META}.OwnerReference`, {
      'x-kubernetes-patch-merge-key': 'uid',
      'x-kubernetes-patch-strategy': 'merge',
      'x-kubernetes-list-type': 'map',
      'x-kubernetes-list-map-keys': ['uid'],
    }),
    finalizers: strings('Must be empty before the object is deleted from the registry.', {
      'x-kubernetes-list-type': 'set',
      'x-kubernetes-patch-strategy': 'merge',
    }),
  }),
  [`${META}.LabelSelectorRequirement`]: obj(
    'A selector requirement: a key, an operator and values.',
    {
      key: str('The label key the selector applies to.', { default: '' }),
      operator: str('One of In, NotIn, Exists and DoesNotExist.', { default: '' }),
      values: strings('Values for In and NotIn; empty for Exists and DoesNotExist.'),
    },
    ['key', 'operator'],
  ),
  [`${META}.LabelSelector`]: {
    ...obj('A label query over a set of resources. An empty selector matches everything.', {
      matchLabels: stringMap('Map of {key,value} pairs; each is an "In" requirement.'),
      matchExpressions: list(
        'A list of label selector requirements, ANDed.',
        `${META}.LabelSelectorRequirement`,
      ),
    }),
    'x-kubernetes-map-type': 'atomic',
  },
  [`${CORE}.LocalObjectReference`]: {
    ...obj('References an object in the same namespace.', {
      name: str('Name of the referent.', { default: '' }),
    }),
    'x-kubernetes-map-type': 'atomic',
  },
  [`${CORE}.ContainerPort`]: obj(
    'A network port in a single container.',
    {
      name: str('An IANA_SVC_NAME, unique within the pod; can be referred to by services.'),
      containerPort: int('Port number to expose on the pod IP address (0 < x < 65536).', {
        default: 0,
      }),
      hostPort: int('Port number to expose on the host. Most containers do not need this.'),
      protocol: oneOf('Protocol for the port. Defaults to "TCP".', ['SCTP', 'TCP', 'UDP'], {
        default: 'TCP',
      }),
      hostIP: str('Host IP to bind the external port to.'),
    },
    ['containerPort'],
  ),
  [`${CORE}.ConfigMapKeySelector`]: obj(
    'Selects a key from a ConfigMap.',
    {
      name: str('Name of the ConfigMap.', { default: '' }),
      key: str('The key to select.', { default: '' }),
      optional: bool('Whether the ConfigMap or its key must be defined.'),
    },
    ['key'],
  ),
  [`${CORE}.SecretKeySelector`]: obj(
    'Selects a key of a Secret.',
    {
      name: str('Name of the Secret.', { default: '' }),
      key: str('The key of the secret to select from.', { default: '' }),
      optional: bool('Whether the Secret or its key must be defined.'),
    },
    ['key'],
  ),
  [`${CORE}.ObjectFieldSelector`]: obj(
    'Selects a field of the pod.',
    {
      apiVersion: str('Version of the schema the FieldPath is written in terms of.'),
      fieldPath: str('Path of the field to select, e.g. metadata.name or status.podIP.', {
        default: '',
      }),
    },
    ['fieldPath'],
  ),
  [`${CORE}.EnvVarSource`]: obj('A source for the value of an EnvVar.', {
    configMapKeyRef: ref(`${CORE}.ConfigMapKeySelector`, 'Selects a key of a ConfigMap.'),
    secretKeyRef: ref(`${CORE}.SecretKeySelector`, 'Selects a key of a secret in the namespace.'),
    fieldRef: ref(`${CORE}.ObjectFieldSelector`, 'Selects a field of the pod.'),
  }),
  [`${CORE}.EnvVar`]: obj(
    'An environment variable present in a Container.',
    {
      name: str('Name of the environment variable.', { default: '' }),
      value: str('Variable value; $(VAR_NAME) references are expanded. Defaults to "".'),
      valueFrom: ref(`${CORE}.EnvVarSource`, "Source for the variable's value."),
    },
    ['name'],
  ),
  [`${CORE}.EnvFromSource`]: obj('A source to populate environment variables from.', {
    prefix: str('An optional identifier to prepend to each key.'),
    configMapRef: ref(`${CORE}.LocalObjectReference`, 'The ConfigMap to select from.'),
    secretRef: ref(`${CORE}.LocalObjectReference`, 'The Secret to select from.'),
  }),
  [`${CORE}.ResourceRequirements`]: obj('Compute resource requirements.', {
    limits: {
      type: 'object',
      additionalProperties: ref('io.k8s.apimachinery.pkg.api.resource.Quantity'),
      description: 'The maximum amount of compute resources allowed.',
    },
    requests: {
      type: 'object',
      additionalProperties: ref('io.k8s.apimachinery.pkg.api.resource.Quantity'),
      description: 'The minimum amount of compute resources required.',
    },
  }),
  [`${CORE}.VolumeMount`]: obj(
    'A mounting of a Volume within a container.',
    {
      name: str('Must match the name of a Volume.', { default: '' }),
      mountPath: str('Path within the container at which the volume should be mounted.', {
        default: '',
      }),
      subPath: str('Path within the volume to mount instead of its root.'),
      readOnly: bool('Mounted read-only if true.'),
    },
    ['name', 'mountPath'],
  ),
  [`${CORE}.ExecAction`]: obj('Runs a command in the container.', {
    command: strings('Command line to execute inside the container; not run in a shell.'),
  }),
  [`${CORE}.HTTPGetAction`]: obj(
    'An action based on HTTP GET requests.',
    {
      path: str('Path to access on the HTTP server.'),
      port: ref(
        'io.k8s.apimachinery.pkg.util.intstr.IntOrString',
        'Name or number of the port to access on the container.',
      ),
      host: str('Host name to connect to, defaults to the pod IP.'),
      scheme: oneOf('Scheme to use for connecting to the host.', ['HTTP', 'HTTPS'], {
        default: 'HTTP',
      }),
    },
    ['port'],
  ),
  [`${CORE}.TCPSocketAction`]: obj(
    'An action based on opening a socket.',
    {
      port: ref(
        'io.k8s.apimachinery.pkg.util.intstr.IntOrString',
        'Number or name of the port to access on the container.',
      ),
      host: str('Optional host name to connect to, defaults to the pod IP.'),
    },
    ['port'],
  ),
  [`${CORE}.Probe`]: obj('A health check performed against a container.', {
    exec: ref(`${CORE}.ExecAction`, 'Exec specifies a command to execute in the container.'),
    httpGet: ref(`${CORE}.HTTPGetAction`, 'HTTPGet specifies an HTTP GET request to perform.'),
    tcpSocket: ref(`${CORE}.TCPSocketAction`, 'TCPSocket specifies a connection to a TCP port.'),
    initialDelaySeconds: int('Seconds after the container started before probes are initiated.'),
    periodSeconds: int('How often (in seconds) to perform the probe. Default 10, minimum 1.'),
    timeoutSeconds: int('Seconds after which the probe times out. Default 1, minimum 1.'),
    successThreshold: int('Minimum consecutive successes to be considered successful.'),
    failureThreshold: int('Consecutive failures before the probe is considered failed.'),
  }),
  [`${CORE}.Capabilities`]: obj('POSIX capabilities to add or drop.', {
    add: strings('Added capabilities.', { 'x-kubernetes-list-type': 'atomic' }),
    drop: strings('Removed capabilities.', { 'x-kubernetes-list-type': 'atomic' }),
  }),
  [`${CORE}.SecurityContext`]: obj('Security options of a container.', {
    runAsUser: {
      type: 'integer',
      format: 'int64',
      description: 'The UID to run the entrypoint as.',
    },
    runAsGroup: {
      type: 'integer',
      format: 'int64',
      description: 'The GID to run the entrypoint as.',
    },
    runAsNonRoot: bool('The container must run as a non-root user.'),
    readOnlyRootFilesystem: bool('Whether the container has a read-only root filesystem.'),
    allowPrivilegeEscalation: bool('Whether a process can gain more privileges than its parent.'),
    privileged: bool('Run the container in privileged mode.'),
    capabilities: ref(`${CORE}.Capabilities`, 'The capabilities to add or drop.'),
  }),
  [`${CORE}.PodSecurityContext`]: obj('Pod-level security attributes.', {
    runAsUser: {
      type: 'integer',
      format: 'int64',
      description: 'The UID to run the entrypoint as.',
    },
    runAsGroup: {
      type: 'integer',
      format: 'int64',
      description: 'The GID to run the entrypoint as.',
    },
    runAsNonRoot: bool('Containers must run as a non-root user.'),
    fsGroup: { type: 'integer', format: 'int64', description: 'A supplemental group for volumes.' },
  }),
  [`${CORE}.Container`]: obj(
    'A single application container to run within a pod.',
    {
      name: str('Name of the container, unique within the pod (DNS_LABEL).', { default: '' }),
      image: str('Container image name.'),
      imagePullPolicy: oneOf(
        'Image pull policy. Defaults to Always for :latest tags, IfNotPresent otherwise.',
        ['Always', 'IfNotPresent', 'Never'],
      ),
      command: strings('Entrypoint array; not executed within a shell.', {
        'x-kubernetes-list-type': 'atomic',
      }),
      args: strings('Arguments to the entrypoint.', { 'x-kubernetes-list-type': 'atomic' }),
      workingDir: str("Container's working directory."),
      ports: list('Ports to expose from the container.', `${CORE}.ContainerPort`, {
        'x-kubernetes-list-type': 'map',
        'x-kubernetes-list-map-keys': ['containerPort', 'protocol'],
        'x-kubernetes-patch-merge-key': 'containerPort',
        'x-kubernetes-patch-strategy': 'merge',
      }),
      env: list('Environment variables to set in the container.', `${CORE}.EnvVar`, {
        'x-kubernetes-list-type': 'map',
        'x-kubernetes-list-map-keys': ['name'],
        'x-kubernetes-patch-merge-key': 'name',
        'x-kubernetes-patch-strategy': 'merge',
      }),
      envFrom: list('Sources to populate environment variables from.', `${CORE}.EnvFromSource`, {
        'x-kubernetes-list-type': 'atomic',
      }),
      resources: ref(
        `${CORE}.ResourceRequirements`,
        'Compute resources required by this container.',
        {
          default: {},
        },
      ),
      volumeMounts: list('Pod volumes to mount into the filesystem.', `${CORE}.VolumeMount`, {
        'x-kubernetes-list-type': 'map',
        'x-kubernetes-list-map-keys': ['mountPath'],
        'x-kubernetes-patch-merge-key': 'mountPath',
        'x-kubernetes-patch-strategy': 'merge',
      }),
      livenessProbe: ref(`${CORE}.Probe`, 'Periodic probe of liveness; restarts on failure.'),
      readinessProbe: ref(`${CORE}.Probe`, 'Periodic probe of readiness; removes from endpoints.'),
      startupProbe: ref(`${CORE}.Probe`, 'Probe that must succeed before other probes run.'),
      securityContext: ref(`${CORE}.SecurityContext`, 'Security options of the container.'),
      terminationMessagePolicy: oneOf('How the termination message is populated.', [
        'FallbackToLogsOnError',
        'File',
      ]),
      stdin: bool('Allocate a buffer for stdin in the container runtime.'),
      tty: bool('Allocate a TTY for the container.'),
    },
    ['name'],
  ),
  [`${CORE}.ConfigMapVolumeSource`]: obj('Populates a volume with a ConfigMap.', {
    name: str('Name of the ConfigMap.', { default: '' }),
    defaultMode: int('Mode bits used to set permissions on created files, 0000 to 0777.'),
    optional: bool('Whether the ConfigMap or its keys must be defined.'),
  }),
  [`${CORE}.SecretVolumeSource`]: obj('Populates a volume with a Secret.', {
    secretName: str('Name of the secret in the pod namespace.'),
    defaultMode: int('Mode bits used to set permissions on created files, 0000 to 0777.'),
    optional: bool('Whether the Secret or its keys must be defined.'),
  }),
  [`${CORE}.EmptyDirVolumeSource`]: obj('An empty directory that shares the pod lifetime.', {
    medium: str('Storage medium: "" (node default) or "Memory".'),
    sizeLimit: ref(
      'io.k8s.apimachinery.pkg.api.resource.Quantity',
      'Total amount of local storage.',
    ),
  }),
  [`${CORE}.PersistentVolumeClaimVolumeSource`]: obj(
    'References a PersistentVolumeClaim in the same namespace.',
    {
      claimName: str('Name of the PersistentVolumeClaim.', { default: '' }),
      readOnly: bool('Force the volume to be mounted read-only.'),
    },
    ['claimName'],
  ),
  [`${CORE}.HostPathVolumeSource`]: obj(
    'A host path mapped into a pod.',
    {
      path: str('Path of the directory on the host.', { default: '' }),
      type: oneOf('Type of the host path.', [
        '',
        'BlockDevice',
        'CharDevice',
        'Directory',
        'DirectoryOrCreate',
        'File',
        'FileOrCreate',
        'Socket',
      ]),
    },
    ['path'],
  ),
  [`${CORE}.Volume`]: obj(
    'A named volume in a pod that may be accessed by any container in the pod.',
    {
      name: str('Name of the volume (DNS_LABEL), unique within the pod.', { default: '' }),
      configMap: ref(`${CORE}.ConfigMapVolumeSource`, 'A ConfigMap that populates this volume.'),
      secret: ref(`${CORE}.SecretVolumeSource`, 'A Secret that populates this volume.'),
      emptyDir: ref(
        `${CORE}.EmptyDirVolumeSource`,
        'A temporary directory sharing the pod lifetime.',
      ),
      persistentVolumeClaim: ref(
        `${CORE}.PersistentVolumeClaimVolumeSource`,
        'A PersistentVolumeClaim in the same namespace.',
      ),
      hostPath: ref(`${CORE}.HostPathVolumeSource`, 'A file or directory on the host machine.'),
    },
    ['name'],
  ),
  [`${CORE}.Toleration`]: obj('Tolerates any taint that matches the triple <key,value,effect>.', {
    key: str('The taint key the toleration applies to. Empty matches all keys.'),
    operator: oneOf('Relationship between the key and the value.', ['Equal', 'Exists']),
    value: str('The taint value the toleration matches to.'),
    effect: oneOf('The taint effect to match. Empty matches all effects.', [
      'NoExecute',
      'NoSchedule',
      'PreferNoSchedule',
    ]),
    tolerationSeconds: {
      type: 'integer',
      format: 'int64',
      description: 'How long a NoExecute taint is tolerated before eviction.',
    },
  }),
  [`${CORE}.PodSpec`]: obj(
    'The specification of a pod.',
    {
      containers: list(
        'Containers belonging to the pod. There must be at least one.',
        `${CORE}.Container`,
        {
          'x-kubernetes-list-type': 'map',
          'x-kubernetes-list-map-keys': ['name'],
          'x-kubernetes-patch-merge-key': 'name',
          'x-kubernetes-patch-strategy': 'merge',
        },
      ),
      initContainers: list(
        'Containers run in order before the app containers start.',
        `${CORE}.Container`,
        {
          'x-kubernetes-list-type': 'map',
          'x-kubernetes-list-map-keys': ['name'],
        },
      ),
      volumes: list('Volumes that can be mounted by containers of the pod.', `${CORE}.Volume`, {
        'x-kubernetes-list-type': 'map',
        'x-kubernetes-list-map-keys': ['name'],
        'x-kubernetes-patch-merge-key': 'name',
        'x-kubernetes-patch-strategy': 'merge,retainKeys',
      }),
      restartPolicy: oneOf('Restart policy for all containers. Defaults to Always.', [
        'Always',
        'Never',
        'OnFailure',
      ]),
      terminationGracePeriodSeconds: {
        type: 'integer',
        format: 'int64',
        description: 'Seconds the pod needs to terminate gracefully. Defaults to 30.',
      },
      activeDeadlineSeconds: {
        type: 'integer',
        format: 'int64',
        description: 'Seconds the pod may be active before the system fails it.',
      },
      dnsPolicy: oneOf('DNS policy for the pod. Defaults to "ClusterFirst".', [
        'ClusterFirst',
        'ClusterFirstWithHostNet',
        'Default',
        'None',
      ]),
      nodeSelector: {
        ...stringMap('Labels a node must have for the pod to be scheduled on it.'),
        'x-kubernetes-map-type': 'atomic',
      },
      serviceAccountName: str('Name of the ServiceAccount used to run this pod.'),
      automountServiceAccountToken: bool('Whether a service account token is mounted.'),
      nodeName: str('Schedules the pod onto a specific node, bypassing the scheduler.'),
      hostNetwork: bool("Use the host's network namespace. Default false."),
      securityContext: ref(`${CORE}.PodSecurityContext`, 'Pod-level security attributes.'),
      imagePullSecrets: list(
        'Secrets used to pull any of the images.',
        `${CORE}.LocalObjectReference`,
        {
          'x-kubernetes-list-type': 'map',
          'x-kubernetes-list-map-keys': ['name'],
        },
      ),
      affinity: {
        type: 'object',
        description: "The pod's scheduling constraints.",
        'x-kubernetes-preserve-unknown-fields': true,
      },
      tolerations: list("The pod's tolerations.", `${CORE}.Toleration`, {
        'x-kubernetes-list-type': 'atomic',
      }),
      priorityClassName: str('The priority class of the pod.'),
      schedulerName: str('The scheduler that dispatches the pod.'),
    },
    ['containers'],
  ),
  [`${CORE}.PodTemplateSpec`]: obj('Describes the pods created from a template.', {
    metadata,
    spec: ref(`${CORE}.PodSpec`, 'Specification of the desired behavior of the pod.', {
      default: {},
    }),
  }),
};

const CORE_KINDS: Record<string, S> = {
  [`${CORE}.PodStatus`]: obj('The most recently observed status of the pod.', {
    phase: oneOf('The phase of a Pod in its lifecycle.', [
      'Failed',
      'Pending',
      'Running',
      'Succeeded',
      'Unknown',
    ]),
    podIP: str('IP address allocated to the pod.'),
    hostIP: str('IP address of the host the pod runs on.'),
    startTime: ref(`${META}.Time`, 'When the kubelet acknowledged the pod.'),
    conditions: {
      type: 'array',
      description: 'Current service state of the pod.',
      items: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
    },
  }),
  [`${CORE}.Pod`]: {
    ...obj('A collection of containers that can run on a host.', {
      ...typeMeta,
      metadata,
      spec: ref(`${CORE}.PodSpec`, 'Specification of the desired behavior of the pod.', {
        default: {},
      }),
      status: ref(`${CORE}.PodStatus`, 'Most recently observed status of the pod. Read-only.', {
        default: {},
      }),
    }),
    'x-kubernetes-group-version-kind': kindOf('', 'v1', 'Pod'),
  },
  [`${CORE}.ServicePort`]: obj(
    'A port the service exposes.',
    {
      name: str('Name of this port within the service (DNS_LABEL).'),
      protocol: oneOf('IP protocol for this port.', ['SCTP', 'TCP', 'UDP'], { default: 'TCP' }),
      port: int('The port that will be exposed by this service.', { default: 0 }),
      targetPort: ref(
        'io.k8s.apimachinery.pkg.util.intstr.IntOrString',
        'Number or name of the port to access on the pods targeted by the service.',
      ),
      nodePort: int('The port on each node for NodePort or LoadBalancer services.'),
      appProtocol: str('The application protocol for this port.'),
    },
    ['port'],
  ),
  [`${CORE}.ServiceSpec`]: obj('Attributes a user creates on a service.', {
    type: oneOf('How the Service is exposed. Defaults to ClusterIP.', [
      'ClusterIP',
      'ExternalName',
      'LoadBalancer',
      'NodePort',
    ]),
    selector: {
      ...stringMap('Route service traffic to pods with labels matching this selector.'),
      'x-kubernetes-map-type': 'atomic',
    },
    ports: list('The ports exposed by this service.', `${CORE}.ServicePort`, {
      'x-kubernetes-list-type': 'map',
      'x-kubernetes-list-map-keys': ['port', 'protocol'],
      'x-kubernetes-patch-merge-key': 'port',
      'x-kubernetes-patch-strategy': 'merge',
    }),
    clusterIP: str('The IP address of the service, usually assigned randomly.'),
    externalName: str('The DNS name returned for ExternalName services.'),
    sessionAffinity: oneOf('Enables client IP based session affinity.', ['ClientIP', 'None']),
    externalTrafficPolicy: oneOf('How external traffic is routed to node-local endpoints.', [
      'Cluster',
      'Local',
    ]),
    internalTrafficPolicy: oneOf('How cluster-internal traffic is routed.', ['Cluster', 'Local']),
    loadBalancerClass: str('The class of the load balancer implementation.'),
  }),
  [`${CORE}.Service`]: {
    ...obj('A named abstraction of a software service: a local port and a set of pods.', {
      ...typeMeta,
      metadata,
      spec: ref(`${CORE}.ServiceSpec`, 'Behavior of the service.', { default: {} }),
      status: {
        type: 'object',
        description: 'Most recently observed status of the service. Read-only.',
        'x-kubernetes-preserve-unknown-fields': true,
      },
    }),
    'x-kubernetes-group-version-kind': kindOf('', 'v1', 'Service'),
  },
  [`${CORE}.ConfigMap`]: {
    ...obj('Holds non-confidential configuration data for pods.', {
      ...typeMeta,
      metadata,
      data: stringMap('Configuration data; keys must be valid file names.'),
      binaryData: {
        type: 'object',
        additionalProperties: { type: 'string', format: 'byte' },
        description: 'Binary data, base64 encoded.',
      },
      immutable: bool('If true, the data cannot be updated.'),
    }),
    'x-kubernetes-group-version-kind': kindOf('', 'v1', 'ConfigMap'),
  },
  [`${CORE}.Secret`]: {
    ...obj('Holds secret data of a certain type.', {
      ...typeMeta,
      metadata,
      data: {
        type: 'object',
        additionalProperties: { type: 'string', format: 'byte' },
        description: 'Secret data, base64 encoded.',
      },
      stringData: stringMap('Write-only convenience: plain-text values merged into data.'),
      type: str('Used to facilitate programmatic handling of secret data.'),
      immutable: bool('If true, the data cannot be updated.'),
    }),
    'x-kubernetes-group-version-kind': kindOf('', 'v1', 'Secret'),
  },
  [`${CORE}.Namespace`]: {
    ...obj('Provides a scope for names.', {
      ...typeMeta,
      metadata,
      spec: obj('Attributes of the namespace.', {
        finalizers: strings('Opaque values that must be empty to permanently remove the object.'),
      }),
      status: obj('Status of the namespace. Read-only.', {
        phase: oneOf('The current lifecycle phase.', ['Active', 'Terminating']),
      }),
    }),
    'x-kubernetes-group-version-kind': kindOf('', 'v1', 'Namespace'),
  },
};

const APPS_KINDS: Record<string, S> = {
  [`${APPS}.RollingUpdateDeployment`]: obj('Controls a rolling update.', {
    maxUnavailable: ref(
      'io.k8s.apimachinery.pkg.util.intstr.IntOrString',
      'Maximum pods that can be unavailable during the update (number or percentage).',
    ),
    maxSurge: ref(
      'io.k8s.apimachinery.pkg.util.intstr.IntOrString',
      'Maximum pods that can be scheduled above the desired number (number or percentage).',
    ),
  }),
  [`${APPS}.DeploymentStrategy`]: obj('How to replace existing pods with new ones.', {
    type: oneOf('Type of deployment. Default is RollingUpdate.', ['Recreate', 'RollingUpdate']),
    rollingUpdate: ref(`${APPS}.RollingUpdateDeployment`, 'Rolling update config parameters.'),
  }),
  [`${APPS}.DeploymentSpec`]: obj(
    'The desired behavior of a Deployment.',
    {
      replicas: int('Number of desired pods. Defaults to 1.'),
      selector: ref(
        `${META}.LabelSelector`,
        'Label selector for pods; must match the template labels.',
      ),
      template: ref(
        `${CORE}.PodTemplateSpec`,
        'Template describing the pods that will be created.',
        {
          default: {},
        },
      ),
      strategy: ref(`${APPS}.DeploymentStrategy`, 'The strategy used to replace old pods.', {
        default: {},
        'x-kubernetes-patch-strategy': 'retainKeys',
      }),
      minReadySeconds: int('Seconds a new pod must be ready to be considered available.'),
      revisionHistoryLimit: int('Old ReplicaSets to retain for rollback. Defaults to 10.'),
      paused: bool('Indicates that the deployment is paused.'),
      progressDeadlineSeconds: int('Seconds before a stalled rollout is reported as failed.'),
    },
    ['selector', 'template'],
  ),
  [`${APPS}.DeploymentStatus`]: obj('The most recently observed status of the Deployment.', {
    observedGeneration: {
      type: 'integer',
      format: 'int64',
      description: 'The generation observed.',
    },
    replicas: int('Total number of non-terminated pods targeted by this deployment.'),
    updatedReplicas: int('Pods that have the desired template spec.'),
    readyReplicas: int('Pods with a Ready condition.'),
    availableReplicas: int('Pods available for at least minReadySeconds.'),
    unavailableReplicas: int('Pods still required for 100% availability.'),
  }),
  [`${APPS}.Deployment`]: {
    ...obj('Enables declarative updates for Pods and ReplicaSets.', {
      ...typeMeta,
      metadata,
      spec: ref(`${APPS}.DeploymentSpec`, 'Specification of the desired behavior.', {
        default: {},
      }),
      status: ref(`${APPS}.DeploymentStatus`, 'Most recently observed status.', { default: {} }),
    }),
    'x-kubernetes-group-version-kind': kindOf('apps', 'v1', 'Deployment'),
  },
};

const BATCH_KINDS: Record<string, S> = {
  [`${BATCH}.JobSpec`]: obj(
    'The description of a job.',
    {
      template: ref(
        `${CORE}.PodTemplateSpec`,
        'The pod that will be created when executing a job.',
        {
          default: {},
        },
      ),
      parallelism: int('Maximum number of pods running at any time.'),
      completions: int('Number of successfully finished pods the job should be run with.'),
      backoffLimit: int('Retries before marking the job failed. Defaults to 6.'),
      activeDeadlineSeconds: {
        type: 'integer',
        format: 'int64',
        description: 'Duration in seconds the job may be continuously active.',
      },
      ttlSecondsAfterFinished: int('Seconds after the job finished before it is deleted.'),
      completionMode: oneOf('How pod completions are tracked.', ['Indexed', 'NonIndexed']),
      suspend: bool('Suspend the job: no pods are created while true.'),
      selector: ref(`${META}.LabelSelector`, 'A label query over pods; usually generated.'),
    },
    ['template'],
  ),
  [`${BATCH}.JobStatus`]: obj('The current state of a Job.', {
    active: int('Number of pending and running pods.'),
    succeeded: int('Number of pods that reached the Succeeded phase.'),
    failed: int('Number of pods that reached the Failed phase.'),
    startTime: ref(`${META}.Time`, 'When the job controller started processing the job.'),
    completionTime: ref(`${META}.Time`, 'When the job was completed.'),
  }),
  [`${BATCH}.Job`]: {
    ...obj('The configuration of a single job.', {
      ...typeMeta,
      metadata,
      spec: ref(`${BATCH}.JobSpec`, 'Specification of the desired behavior of the job.', {
        default: {},
      }),
      status: ref(`${BATCH}.JobStatus`, 'Current status of the job.', { default: {} }),
    }),
    'x-kubernetes-group-version-kind': kindOf('batch', 'v1', 'Job'),
  },
  [`${BATCH}.JobTemplateSpec`]: obj('The Job that will be created from a CronJob.', {
    metadata,
    spec: ref(`${BATCH}.JobSpec`, 'Specification of the desired behavior of the job.', {
      default: {},
    }),
  }),
  [`${BATCH}.CronJobSpec`]: obj(
    'How the job runs and when it will actually run.',
    {
      schedule: str('The schedule in Cron format.', { default: '' }),
      timeZone: str('The time zone name for the schedule, e.g. Europe/Istanbul.'),
      jobTemplate: ref(`${BATCH}.JobTemplateSpec`, 'The job that will be created when executing.', {
        default: {},
      }),
      concurrencyPolicy: oneOf('How to treat concurrent executions of a job.', [
        'Allow',
        'Forbid',
        'Replace',
      ]),
      suspend: bool('Suspend subsequent executions. Defaults to false.'),
      startingDeadlineSeconds: {
        type: 'integer',
        format: 'int64',
        description: 'Deadline for starting a job that missed its scheduled time.',
      },
      successfulJobsHistoryLimit: int('Successful finished jobs to retain. Defaults to 3.'),
      failedJobsHistoryLimit: int('Failed finished jobs to retain. Defaults to 1.'),
    },
    ['schedule', 'jobTemplate'],
  ),
  [`${BATCH}.CronJob`]: {
    ...obj('The configuration of a single cron job.', {
      ...typeMeta,
      metadata,
      spec: ref(`${BATCH}.CronJobSpec`, 'Specification of the desired behavior of the cron job.', {
        default: {},
      }),
      status: {
        type: 'object',
        description: 'Current status of the cron job.',
        'x-kubernetes-preserve-unknown-fields': true,
      },
    }),
    'x-kubernetes-group-version-kind': kindOf('batch', 'v1', 'CronJob'),
  },
};

/** A CRD as the API server publishes it: one inline schema per kind. */
const CERT_MANAGER: Record<string, S> = {
  'io.cert-manager.v1.Certificate': {
    type: 'object',
    description:
      'A Certificate resource should be created to ensure an up to date and signed X.509 certificate is stored in the Kubernetes Secret resource named in spec.secretName.',
    required: ['spec'],
    properties: {
      ...typeMeta,
      metadata,
      spec: {
        type: 'object',
        description: 'Specification of the desired state of the Certificate resource.',
        required: ['issuerRef', 'secretName'],
        properties: {
          secretName: str(
            'Name of the Secret resource that will be automatically created and managed.',
          ),
          issuerRef: {
            type: 'object',
            description: 'Reference to the issuer responsible for issuing the certificate.',
            required: ['name'],
            properties: {
              name: str('Name of the resource being referred to.'),
              kind: str('Kind of the resource being referred to.'),
              group: str('Group of the resource being referred to.'),
            },
          },
          commonName: str('Requested common name (CN) of the certificate.'),
          dnsNames: strings('Requested DNS subject alternative names.'),
          ipAddresses: strings('Requested IP address subject alternative names.'),
          duration: str('Requested lifetime of the certificate, e.g. 2160h.'),
          renewBefore: str('How long before expiry the certificate should be renewed.'),
          isCA: bool('Requests a certificate valid for signing other certificates.'),
          usages: {
            type: 'array',
            description: 'Requested key usages and extended key usages.',
            items: {
              type: 'string',
              enum: [
                'signing',
                'digital signature',
                'key encipherment',
                'server auth',
                'client auth',
                'cert sign',
              ],
            },
          },
          privateKey: {
            type: 'object',
            description: 'Private key options.',
            properties: {
              algorithm: oneOf('Private key algorithm.', ['RSA', 'ECDSA', 'Ed25519']),
              size: { type: 'integer', description: 'Key bit size of the private key.' },
              encoding: oneOf('Private key cryptography standard.', ['PKCS1', 'PKCS8']),
              rotationPolicy: oneOf('Whether a new key is generated on re-issuance.', [
                'Never',
                'Always',
              ]),
            },
          },
          secretTemplate: {
            type: 'object',
            description: 'Labels and annotations copied to the target Secret.',
            properties: {
              labels: stringMap('Labels to add to the target Secret.'),
              annotations: stringMap('Annotations to add to the target Secret.'),
            },
          },
        },
        'x-kubernetes-validations': [
          {
            rule: '!has(self.renewBefore) || !has(self.duration) || self.renewBefore != self.duration',
            message: 'renewBefore must be shorter than duration',
          },
        ],
      },
      status: {
        type: 'object',
        description: 'Status of the Certificate. Read-only.',
        'x-kubernetes-preserve-unknown-fields': true,
      },
    },
    'x-kubernetes-group-version-kind': kindOf('cert-manager.io', 'v1', 'Certificate'),
  },
};

const HANDCRAFTED: Record<string, Record<string, S>> = {
  v1: CORE_KINDS,
  'apps/v1': APPS_KINDS,
  'batch/v1': BATCH_KINDS,
  'cert-manager.io/v1': CERT_MANAGER,
};

const kindsIn = (schemas: Record<string, S>) =>
  new Set(
    Object.values(schemas).flatMap((s) =>
      (s['x-kubernetes-group-version-kind'] ?? []).map((g) => g.kind),
    ),
  );

/** Every served group-version, handcrafted ones first. */
function groupVersions(db: ClusterDb): Map<string, { group: string; version: string }> {
  const out = new Map<string, { group: string; version: string }>();
  for (const apiVersion of Object.keys(HANDCRAFTED)) {
    const [group, version] = apiVersion.includes('/') ? apiVersion.split('/') : ['', apiVersion];
    out.set(apiVersion, { group: group!, version: version! });
  }
  for (const r of apiResources(db))
    if (!out.has(r.api_version)) out.set(r.api_version, { group: r.group, version: r.version });
  return out;
}

export function demoOpenApiIndex(db: ClusterDb): OpenApiIndex {
  const versions = [...groupVersions(db).entries()]
    .map(([apiVersion, { group, version }]) => ({
      group,
      version,
      api_version: apiVersion,
      path: group ? `apis/${group}/${version}` : `api/${version}`,
      hash: hashString(`demo-openapi|${apiVersion}|1`).toString(16).toUpperCase(),
    }))
    .sort(
      (a, b) =>
        Number(!!a.group) - Number(!!b.group) ||
        a.group.localeCompare(b.group) ||
        a.version.localeCompare(b.version),
    );
  return {
    hash: hashString(versions.map((v) => `${v.path}@${v.hash}`).join(',')).toString(16),
    group_versions: versions,
  };
}

export function demoOpenApiDocument(db: ClusterDb, apiVersion: string): OpenApiDocument | null {
  const gv = groupVersions(db).get(apiVersion);
  if (!gv) return null;
  const schemas: Record<string, S> = { ...SHARED, ...(HANDCRAFTED[apiVersion] ?? {}) };
  const described = kindsIn(schemas);
  const prefix = gv.group
    ? `io.k8s.demo.${gv.group}.${gv.version}`
    : `io.k8s.demo.core.${gv.version}`;
  for (const r of apiResources(db)) {
    if (r.api_version !== apiVersion || described.has(r.kind)) continue;
    described.add(r.kind);
    schemas[`${prefix}.${r.kind}`] = {
      type: 'object',
      description: `${r.kind} (${r.plural}). The demo backend describes only apiVersion, kind and metadata of this kind.`,
      properties: { ...typeMeta, metadata },
      'x-kubernetes-preserve-unknown-fields': true,
      'x-kubernetes-group-version-kind': kindOf(gv.group, gv.version, r.kind),
    };
  }
  return { components: { schemas } };
}
