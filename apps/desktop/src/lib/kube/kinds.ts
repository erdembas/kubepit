import type { Gvk } from '@/types';

/** Built-in Kubernetes kinds the workbench lists (group, version, plural, scope, navigator section). */

export type NavSectionId =
  'cluster' | 'workloads' | 'config' | 'network' | 'storage' | 'access' | 'helm' | 'custom';

export interface KindDef extends Gvk {
  key: string;
  section: NavSectionId;
  /** Navigator label — the kind name, never translated. */
  title: string;
  shortNames: string[];
}

function def(
  group: string,
  version: string,
  kind: string,
  plural: string,
  namespaced: boolean,
  section: NavSectionId,
  title: string,
  shortNames: string[] = [],
): KindDef {
  return {
    group,
    version,
    kind,
    plural,
    namespaced,
    section,
    title,
    shortNames,
    key: group ? `${plural}.${group}` : plural,
  };
}

const RBAC = 'rbac.authorization.k8s.io';
const NET = 'networking.k8s.io';
const ADM = 'admissionregistration.k8s.io';

export const BUILTIN = {
  Node: def('', 'v1', 'Node', 'nodes', false, 'cluster', 'Nodes', ['no']),
  Namespace: def('', 'v1', 'Namespace', 'namespaces', false, 'cluster', 'Namespaces', ['ns']),
  Event: def('', 'v1', 'Event', 'events', true, 'cluster', 'Events', ['ev']),
  Pod: def('', 'v1', 'Pod', 'pods', true, 'workloads', 'Pods', ['po']),
  Deployment: def('apps', 'v1', 'Deployment', 'deployments', true, 'workloads', 'Deployments', [
    'deploy',
  ]),
  DaemonSet: def('apps', 'v1', 'DaemonSet', 'daemonsets', true, 'workloads', 'DaemonSets', ['ds']),
  StatefulSet: def('apps', 'v1', 'StatefulSet', 'statefulsets', true, 'workloads', 'StatefulSets', [
    'sts',
  ]),
  ReplicaSet: def('apps', 'v1', 'ReplicaSet', 'replicasets', true, 'workloads', 'ReplicaSets', [
    'rs',
  ]),
  ReplicationController: def(
    '',
    'v1',
    'ReplicationController',
    'replicationcontrollers',
    true,
    'workloads',
    'ReplicationControllers',
    ['rc'],
  ),
  Job: def('batch', 'v1', 'Job', 'jobs', true, 'workloads', 'Jobs'),
  CronJob: def('batch', 'v1', 'CronJob', 'cronjobs', true, 'workloads', 'CronJobs', ['cj']),
  ConfigMap: def('', 'v1', 'ConfigMap', 'configmaps', true, 'config', 'ConfigMaps', ['cm']),
  Secret: def('', 'v1', 'Secret', 'secrets', true, 'config', 'Secrets'),
  ResourceQuota: def(
    '',
    'v1',
    'ResourceQuota',
    'resourcequotas',
    true,
    'config',
    'ResourceQuotas',
    ['quota'],
  ),
  LimitRange: def('', 'v1', 'LimitRange', 'limitranges', true, 'config', 'LimitRanges', ['limits']),
  HorizontalPodAutoscaler: def(
    'autoscaling',
    'v2',
    'HorizontalPodAutoscaler',
    'horizontalpodautoscalers',
    true,
    'config',
    'HorizontalPodAutoscalers',
    ['hpa'],
  ),
  PodDisruptionBudget: def(
    'policy',
    'v1',
    'PodDisruptionBudget',
    'poddisruptionbudgets',
    true,
    'config',
    'PodDisruptionBudgets',
    ['pdb'],
  ),
  PriorityClass: def(
    'scheduling.k8s.io',
    'v1',
    'PriorityClass',
    'priorityclasses',
    false,
    'config',
    'PriorityClasses',
    ['pc'],
  ),
  RuntimeClass: def(
    'node.k8s.io',
    'v1',
    'RuntimeClass',
    'runtimeclasses',
    false,
    'config',
    'RuntimeClasses',
  ),
  Lease: def('coordination.k8s.io', 'v1', 'Lease', 'leases', true, 'config', 'Leases'),
  MutatingWebhookConfiguration: def(
    ADM,
    'v1',
    'MutatingWebhookConfiguration',
    'mutatingwebhookconfigurations',
    false,
    'config',
    'MutatingWebhooks',
  ),
  ValidatingWebhookConfiguration: def(
    ADM,
    'v1',
    'ValidatingWebhookConfiguration',
    'validatingwebhookconfigurations',
    false,
    'config',
    'ValidatingWebhooks',
  ),
  Service: def('', 'v1', 'Service', 'services', true, 'network', 'Services', ['svc']),
  Endpoints: def('', 'v1', 'Endpoints', 'endpoints', true, 'network', 'Endpoints', ['ep']),
  EndpointSlice: def(
    'discovery.k8s.io',
    'v1',
    'EndpointSlice',
    'endpointslices',
    true,
    'network',
    'EndpointSlices',
  ),
  Ingress: def(NET, 'v1', 'Ingress', 'ingresses', true, 'network', 'Ingresses', ['ing']),
  IngressClass: def(
    NET,
    'v1',
    'IngressClass',
    'ingressclasses',
    false,
    'network',
    'IngressClasses',
  ),
  NetworkPolicy: def(
    NET,
    'v1',
    'NetworkPolicy',
    'networkpolicies',
    true,
    'network',
    'NetworkPolicies',
    ['netpol'],
  ),
  PersistentVolumeClaim: def(
    '',
    'v1',
    'PersistentVolumeClaim',
    'persistentvolumeclaims',
    true,
    'storage',
    'PersistentVolumeClaims',
    ['pvc'],
  ),
  PersistentVolume: def(
    '',
    'v1',
    'PersistentVolume',
    'persistentvolumes',
    false,
    'storage',
    'PersistentVolumes',
    ['pv'],
  ),
  StorageClass: def(
    'storage.k8s.io',
    'v1',
    'StorageClass',
    'storageclasses',
    false,
    'storage',
    'StorageClasses',
    ['sc'],
  ),
  ServiceAccount: def(
    '',
    'v1',
    'ServiceAccount',
    'serviceaccounts',
    true,
    'access',
    'ServiceAccounts',
    ['sa'],
  ),
  ClusterRole: def(RBAC, 'v1', 'ClusterRole', 'clusterroles', false, 'access', 'ClusterRoles'),
  Role: def(RBAC, 'v1', 'Role', 'roles', true, 'access', 'Roles'),
  ClusterRoleBinding: def(
    RBAC,
    'v1',
    'ClusterRoleBinding',
    'clusterrolebindings',
    false,
    'access',
    'ClusterRoleBindings',
  ),
  RoleBinding: def(RBAC, 'v1', 'RoleBinding', 'rolebindings', true, 'access', 'RoleBindings'),
  CustomResourceDefinition: def(
    'apiextensions.k8s.io',
    'v1',
    'CustomResourceDefinition',
    'customresourcedefinitions',
    false,
    'custom',
    'Definitions',
    ['crd', 'crds'],
  ),
} as const satisfies Record<string, KindDef>;

export type BuiltinKind = keyof typeof BUILTIN;

export const BUILTIN_KINDS: readonly KindDef[] = Object.values(BUILTIN);
