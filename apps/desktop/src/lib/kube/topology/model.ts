import type { Gvk } from '@/types';
import type { StatusTone } from '../pods';

/**
 * Resource relationship graph (topology). Nodes are Kubernetes objects,
 * edges are typed relationships pointing from the referrer to the object
 * it references or owns (Deployment → ReplicaSet, Pod → ConfigMap,
 * RoleBinding → ServiceAccount). Everything here is plain data so the
 * builder, the view pipeline and the layout stay pure and deterministic.
 */

/** Relationship types. Arrows point from the referrer to the referent. */
export type EdgeKind =
  /** ownerReferences (Deployment → ReplicaSet → Pod, CronJob → Job). */
  | 'owns'
  /** Service selector → Pods. */
  | 'selects'
  /** Service → EndpointSlices. */
  | 'endpoints'
  /** Ingress / HTTPRoute / GRPCRoute → Service backends. */
  | 'routes'
  /** HTTPRoute / GRPCRoute → parent Gateway. */
  | 'parent'
  /** Ingress → IngressClass, PV / PVC → StorageClass. */
  | 'class'
  /** Ingress → TLS Secret. */
  | 'tls'
  /** Pod → ConfigMap / Secret volumes (incl. projected). */
  | 'mounts'
  /** Pod → ConfigMap / Secret through envFrom / valueFrom. */
  | 'env'
  /** Pod → imagePullSecrets. */
  | 'pull-secret'
  /** Pod → PersistentVolumeClaim. */
  | 'claims'
  /** PersistentVolumeClaim → PersistentVolume. */
  | 'bound'
  /** Pod → ServiceAccount. */
  | 'identity'
  /** RoleBinding / ClusterRoleBinding → ServiceAccount subject. */
  | 'binds'
  /** RoleBinding / ClusterRoleBinding → Role / ClusterRole. */
  | 'role-ref'
  /** Pod → Node. */
  | 'runs-on'
  /** HorizontalPodAutoscaler → scale target. */
  | 'scales'
  /** NetworkPolicy podSelector → Pods. */
  | 'policy'
  /** PodDisruptionBudget selector → Pods. */
  | 'budget';

/** Legend families: one colour and dash pattern each. */
export type EdgeFamily =
  'ownership' | 'traffic' | 'config' | 'storage' | 'access' | 'policy' | 'scaling' | 'scheduling';

export const EDGE_FAMILY: Record<EdgeKind, EdgeFamily> = {
  owns: 'ownership',
  selects: 'traffic',
  endpoints: 'traffic',
  routes: 'traffic',
  parent: 'traffic',
  class: 'traffic',
  tls: 'config',
  mounts: 'config',
  env: 'config',
  'pull-secret': 'config',
  claims: 'storage',
  bound: 'storage',
  identity: 'access',
  binds: 'access',
  'role-ref': 'access',
  'runs-on': 'scheduling',
  scales: 'scaling',
  policy: 'policy',
  budget: 'policy',
};

export const EDGE_FAMILIES: readonly EdgeFamily[] = [
  'ownership',
  'traffic',
  'config',
  'storage',
  'access',
  'policy',
  'scaling',
  'scheduling',
];

/**
 * Why a node is drawn without a live object behind it: `missing` when the
 * referenced kind is watched and synced but the object does not exist,
 * `unresolved` when the kind is not watched (no access, outside the scope).
 */
export type NodeFlag = 'missing' | 'unresolved' | 'no-endpoints';

export interface PodGroup {
  /** Node id of the controller the pods share (ReplicaSet, Job, StatefulSet…). */
  ownerId: string;
  count: number;
  tones: Partial<Record<StatusTone, number>>;
  members: string[];
}

export interface TopoNode {
  id: string;
  /** Kubernetes kind (`Pod`); an identifier, never translated. */
  kind: string;
  /** kubectl resource name (`pods`, `deployments.apps`) for icons and navigation. */
  kindKey: string;
  gvk: Gvk | null;
  namespace: string | null;
  name: string;
  /** Null for referenced objects that were not observed. */
  uid: string | null;
  /** Layout column, left to right (see `TIER`). */
  tier: number;
  /** Status tone, or null for kinds without a status (ConfigMaps, Roles…). */
  tone: StatusTone | null;
  /** Short status text taken from the object (`Running`, `3/3`, `Bound`). */
  status: string;
  flag?: NodeFlag;
  /** Controllers without pods and no desired replicas (old ReplicaSets). */
  inactive?: boolean;
  /** Bookkeeping objects (Helm release secrets, injected CA bundles): shown only when related. */
  quiet?: boolean;
  /** Collapsed pods of one controller. */
  group?: PodGroup;
  /** Objects folded together because the map exceeded its node budget. */
  aggregate?: { count: number };
}

export interface TopoEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface TopoGraph {
  nodes: ReadonlyMap<string, TopoNode>;
  edges: readonly TopoEdge[];
}

/** Layout columns. */
export const TIER = {
  entry: 0,
  route: 1,
  service: 2,
  workload: 3,
  controller: 4,
  pod: 5,
  config: 6,
  binding: 7,
  cluster: 8,
  node: 9,
} as const;

const TIER_BY_KIND: Record<string, number> = {
  GatewayClass: TIER.entry,
  Gateway: TIER.entry,
  IngressClass: TIER.entry,
  Ingress: TIER.route,
  HTTPRoute: TIER.route,
  GRPCRoute: TIER.route,
  Service: TIER.service,
  HorizontalPodAutoscaler: TIER.service,
  Deployment: TIER.workload,
  StatefulSet: TIER.workload,
  DaemonSet: TIER.workload,
  CronJob: TIER.workload,
  ReplicationController: TIER.workload,
  ReplicaSet: TIER.controller,
  Job: TIER.controller,
  EndpointSlice: TIER.controller,
  PodDisruptionBudget: TIER.controller,
  NetworkPolicy: TIER.controller,
  Pod: TIER.pod,
  ConfigMap: TIER.config,
  Secret: TIER.config,
  PersistentVolumeClaim: TIER.config,
  ServiceAccount: TIER.config,
  PersistentVolume: TIER.binding,
  RoleBinding: TIER.binding,
  ClusterRoleBinding: TIER.binding,
  StorageClass: TIER.cluster,
  Role: TIER.cluster,
  ClusterRole: TIER.cluster,
  Node: TIER.node,
};

/** Unknown kinds (custom resources) start next to the workloads; the builder refines them. */
export function tierOf(kind: string): number {
  return TIER_BY_KIND[kind] ?? TIER.workload;
}

/** Order of kinds inside a column and in the filter chips. */
export const KIND_ORDER: readonly string[] = [
  'Gateway',
  'IngressClass',
  'Ingress',
  'HTTPRoute',
  'GRPCRoute',
  'Service',
  'HorizontalPodAutoscaler',
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'CronJob',
  'ReplicationController',
  'ReplicaSet',
  'Job',
  'EndpointSlice',
  'PodDisruptionBudget',
  'NetworkPolicy',
  'Pod',
  'ConfigMap',
  'Secret',
  'PersistentVolumeClaim',
  'ServiceAccount',
  'PersistentVolume',
  'RoleBinding',
  'ClusterRoleBinding',
  'StorageClass',
  'Role',
  'ClusterRole',
  'Node',
];

export function kindRank(kind: string): number {
  const i = KIND_ORDER.indexOf(kind);
  return i < 0 ? KIND_ORDER.length : i;
}

/** Stable node id: `kindKey|namespace|name`. */
export function nodeId(kindKey: string, namespace: string | null | undefined, name: string) {
  return `${kindKey}|${namespace ?? ''}|${name}`;
}

export function groupId(ownerId: string) {
  return `group|${ownerId}`;
}

/** Deterministic node order: tier, kind, namespace, name. */
export function compareNodes(a: TopoNode, b: TopoNode): number {
  return (
    a.tier - b.tier ||
    kindRank(a.kind) - kindRank(b.kind) ||
    a.kind.localeCompare(b.kind) ||
    (a.namespace ?? '').localeCompare(b.namespace ?? '') ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}

const TONE_SEVERITY: Record<StatusTone, number> = {
  error: 4,
  warning: 3,
  info: 2,
  success: 1,
  muted: 0,
};

/** The most severe tone of a set (error > warning > info > success > muted). */
export function worstTone(tones: Iterable<StatusTone | null>): StatusTone | null {
  let worst: StatusTone | null = null;
  for (const t of tones) {
    if (t && (worst === null || TONE_SEVERITY[t] > TONE_SEVERITY[worst])) worst = t;
  }
  return worst;
}
