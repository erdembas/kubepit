import type { ApiResourceInfo, Gvk, KubeObject } from '@/types';
import { asArray, asObject, asString, isObject, spec } from '../accessors';
import { BUILTIN, kindKey, resolveRef, toGvk } from '../catalog';
import { matchesSelector, parseSelector, type LabelSelector } from '../selectors';
import {
  nodeId,
  tierOf,
  TIER,
  type EdgeKind,
  type TopoEdge,
  type TopoGraph,
  type TopoNode,
} from './model';
import { podSpecRefs } from './refs';
import { GATEWAY_GROUP } from './sources';
import { nodeStatus } from './status';

/**
 * Builds the full relationship graph of the observed objects: one node per
 * object, typed edges from owner references, selectors and name references.
 * Referenced objects that were not observed become placeholder nodes
 * (flag `missing` when their kind is watched and synced, `unresolved`
 * otherwise) so broken references stay visible.
 */

export interface TopologyList {
  gvk: Gvk;
  items: readonly KubeObject[];
  /** The list finished its initial sync without error (absence means "missing"). */
  synced: boolean;
}

export interface TopologyInput {
  lists: readonly TopologyList[];
  /** Namespaces the lists are scoped to ([] = all namespaces). */
  namespaces: readonly string[];
  apiResources: readonly ApiResourceInfo[] | null;
  /** Objects whose kind is not in `lists` (e.g. the details panel's own object). */
  extra?: ReadonlyArray<{ gvk: Gvk; obj: KubeObject }>;
}

interface RefTarget {
  gvk: Gvk;
  namespace: string | null;
  name: string;
}

type Selector = LabelSelector | 'all' | null;

/** metav1.LabelSelector where `{}` selects everything (PDB, NetworkPolicy). */
function selectorOrAll(raw: unknown): Selector {
  if (isObject(raw) && Object.keys(raw).length === 0) return 'all';
  const parsed = parseSelector(raw);
  if (!parsed) return null;
  return Object.keys(parsed.matchLabels).length || parsed.matchExpressions.length ? parsed : 'all';
}

const WORKLOAD_KINDS = new Set([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'ReplicationController',
  'Job',
  'CronJob',
]);

const QUIET_SECRET_TYPES = new Set(['helm.sh/release.v1', 'kubernetes.io/service-account-token']);
const QUIET_CONFIGMAPS = new Set(['kube-root-ca.crt', 'openshift-service-ca.crt']);

function isQuiet(obj: KubeObject): boolean {
  if (obj.kind === 'Secret') return QUIET_SECRET_TYPES.has(asString(obj.type));
  if (obj.kind === 'ConfigMap') return QUIET_CONFIGMAPS.has(obj.metadata.name);
  return false;
}

function podTemplateSpec(obj: KubeObject): unknown {
  if (obj.kind === 'CronJob')
    return asObject(asObject(asObject(spec(obj).jobTemplate).spec).template).spec;
  return asObject(spec(obj).template).spec;
}

export function buildTopology(input: TopologyInput): TopoGraph {
  const nodes = new Map<string, TopoNode>();
  const objects = new Map<string, KubeObject>();
  const byUid = new Map<string, string>();
  const syncedKinds = new Set<string>();
  const edges: TopoEdge[] = [];
  const edgeKeys = new Set<string>();
  const podsByNs = new Map<string, Array<{ id: string; labels: Record<string, string> }>>();
  const scope = new Set(input.namespaces);

  const addObject = (gvk: Gvk, obj: KubeObject) => {
    const key = kindKey(gvk);
    const id = nodeId(key, gvk.namespaced ? obj.metadata.namespace : null, obj.metadata.name);
    if (nodes.has(id)) return;
    const st = nodeStatus(obj);
    nodes.set(id, {
      id,
      kind: obj.kind || gvk.kind,
      kindKey: key,
      gvk,
      namespace: gvk.namespaced ? (obj.metadata.namespace ?? null) : null,
      name: obj.metadata.name,
      uid: obj.metadata.uid,
      tier: tierOf(obj.kind || gvk.kind),
      tone: st.tone,
      status: st.status,
      ...(isQuiet(obj) ? { quiet: true } : {}),
    });
    objects.set(id, obj);
    if (obj.metadata.uid) byUid.set(obj.metadata.uid, id);
    if ((obj.kind || gvk.kind) === 'Pod') {
      const ns = obj.metadata.namespace ?? '';
      const list = podsByNs.get(ns) ?? [];
      list.push({ id, labels: obj.metadata.labels ?? {} });
      podsByNs.set(ns, list);
    }
  };

  for (const list of input.lists) {
    if (list.synced) syncedKinds.add(kindKey(list.gvk));
    for (const obj of list.items) addObject(list.gvk, obj);
  }
  for (const { gvk, obj } of input.extra ?? []) addObject(gvk, obj);

  const inScope = (namespace: string | null) =>
    namespace === null || scope.size === 0 || scope.has(namespace);

  const addEdge = (from: string, to: string, kind: EdgeKind) => {
    if (from === to) return;
    const key = `${from}>${to}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ id: `${key}:${kind}`, from, to, kind });
  };

  /** Node id of a reference, creating a placeholder when it was not observed. */
  const target = (ref: RefTarget): string | null => {
    if (!ref.name) return null;
    const key = kindKey(ref.gvk);
    const namespace = ref.gvk.namespaced ? ref.namespace : null;
    const id = nodeId(key, namespace, ref.name);
    if (nodes.has(id)) return id;
    if (!inScope(namespace)) return null;
    nodes.set(id, {
      id,
      kind: ref.gvk.kind,
      kindKey: key,
      gvk: ref.gvk,
      namespace,
      name: ref.name,
      uid: null,
      tier: tierOf(ref.gvk.kind),
      tone: syncedKinds.has(key) ? 'error' : null,
      status: '',
      flag: syncedKinds.has(key) ? 'missing' : 'unresolved',
    });
    return id;
  };

  const link = (from: string, ref: RefTarget, kind: EdgeKind) => {
    const to = target(ref);
    if (to) addEdge(from, to, kind);
  };

  const builtin = (def: Gvk, namespace: string | null, name: string): RefTarget => ({
    gvk: toGvk(def),
    namespace,
    name,
  });

  const selectPods = (from: string, namespace: string, selector: Selector, kind: EdgeKind) => {
    if (!selector) return 0;
    let count = 0;
    for (const pod of podsByNs.get(namespace) ?? []) {
      if (selector === 'all' || matchesSelector(selector, pod.labels)) {
        addEdge(from, pod.id, kind);
        count++;
      }
    }
    return count;
  };

  const linkPodSpec = (
    from: string,
    namespace: string,
    podSpec: unknown,
    podName: string | null,
  ) => {
    for (const ref of podSpecRefs(podSpec, podName)) {
      const def =
        ref.kind === 'ConfigMap'
          ? BUILTIN.ConfigMap
          : ref.kind === 'Secret'
            ? BUILTIN.Secret
            : ref.kind === 'PersistentVolumeClaim'
              ? BUILTIN.PersistentVolumeClaim
              : ref.kind === 'ServiceAccount'
                ? BUILTIN.ServiceAccount
                : BUILTIN.Node;
      link(from, builtin(def, namespace, ref.name), ref.edge);
    }
  };

  const defaultIngressClass = [...nodes.values()].find(
    (n) =>
      n.kind === 'IngressClass' &&
      objects.get(n.id)?.metadata.annotations?.['ingressclass.kubernetes.io/is-default-class'] ===
        'true',
  );

  // Snapshot: relationship rules add placeholder nodes while iterating.
  const observed = [...objects.entries()];

  for (const [id, obj] of observed) {
    const ns = obj.metadata.namespace ?? '';
    const s = spec(obj);
    switch (obj.kind) {
      case 'Pod':
        linkPodSpec(id, ns, s, obj.metadata.name);
        break;
      case 'Service': {
        const node = nodes.get(id)!;
        if (asString(s.type) === 'ExternalName') break;
        const selector = parseSelector(s.selector);
        if (selector && selectPods(id, ns, selector, 'selects') === 0) {
          node.tone = 'warning';
          node.flag = 'no-endpoints';
        }
        break;
      }
      case 'EndpointSlice': {
        const service = obj.metadata.labels?.['kubernetes.io/service-name'];
        const serviceId = service ? nodeId(kindKey(BUILTIN.Service), ns, service) : null;
        if (serviceId && nodes.has(serviceId)) addEdge(serviceId, id, 'endpoints');
        break;
      }
      case 'Ingress': {
        const backends = [
          asObject(s.defaultBackend),
          ...asArray(s.rules)
            .filter(isObject)
            .flatMap((r) =>
              asArray(asObject(r.http).paths)
                .filter(isObject)
                .map((p) => asObject(p.backend)),
            ),
        ];
        for (const b of backends) {
          const name = asString(asObject(b.service).name) || asString(b.serviceName);
          if (name) link(id, builtin(BUILTIN.Service, ns, name), 'routes');
        }
        for (const t of asArray(s.tls).filter(isObject))
          link(id, builtin(BUILTIN.Secret, ns, asString(t.secretName)), 'tls');
        const className =
          asString(s.ingressClassName) ||
          obj.metadata.annotations?.['kubernetes.io/ingress.class'] ||
          '';
        if (className) link(id, builtin(BUILTIN.IngressClass, null, className), 'class');
        else if (defaultIngressClass) addEdge(id, defaultIngressClass.id, 'class');
        break;
      }
      case 'Gateway':
        for (const listener of asArray(s.listeners).filter(isObject)) {
          for (const ref of asArray(asObject(listener.tls).certificateRefs).filter(isObject)) {
            if (asString(ref.group) !== '' || (asString(ref.kind) || 'Secret') !== 'Secret')
              continue;
            link(
              id,
              builtin(BUILTIN.Secret, asString(ref.namespace) || ns, asString(ref.name)),
              'tls',
            );
          }
        }
        break;
      case 'HTTPRoute':
      case 'GRPCRoute': {
        const gateway = input.apiResources?.find(
          (r) => r.group === GATEWAY_GROUP && r.kind === 'Gateway',
        );
        for (const p of asArray(s.parentRefs).filter(isObject)) {
          const group = asString(p.group, GATEWAY_GROUP);
          const kind = asString(p.kind) || 'Gateway';
          if (group !== GATEWAY_GROUP || kind !== 'Gateway' || !gateway) continue;
          link(
            id,
            {
              gvk: { ...toGvk(gateway), kind: 'Gateway' },
              namespace: asString(p.namespace) || ns,
              name: asString(p.name),
            },
            'parent',
          );
        }
        for (const rule of asArray(s.rules).filter(isObject)) {
          for (const b of asArray(rule.backendRefs).filter(isObject)) {
            const group = asString(b.group);
            const kind = asString(b.kind) || 'Service';
            if (group !== '' || kind !== 'Service') continue;
            link(
              id,
              builtin(BUILTIN.Service, asString(b.namespace) || ns, asString(b.name)),
              'routes',
            );
          }
        }
        break;
      }
      case 'PersistentVolumeClaim': {
        const volume = asString(s.volumeName);
        if (volume) link(id, builtin(BUILTIN.PersistentVolume, null, volume), 'bound');
        else if (asString(s.storageClassName))
          link(id, builtin(BUILTIN.StorageClass, null, asString(s.storageClassName)), 'class');
        break;
      }
      case 'PersistentVolume': {
        const sc = asString(s.storageClassName);
        if (sc) link(id, builtin(BUILTIN.StorageClass, null, sc), 'class');
        break;
      }
      case 'RoleBinding':
      case 'ClusterRoleBinding': {
        for (const subject of asArray(obj.subjects).filter(isObject)) {
          if (asString(subject.kind) !== 'ServiceAccount') continue;
          const subjectNs = asString(subject.namespace) || (obj.kind === 'RoleBinding' ? ns : '');
          if (!subjectNs) continue;
          const saId = nodeId(kindKey(BUILTIN.ServiceAccount), subjectNs, asString(subject.name));
          // Bindings only point at subjects the map shows; foreign subjects stay out.
          if (nodes.has(saId) || (obj.kind === 'RoleBinding' && subjectNs === ns))
            link(id, builtin(BUILTIN.ServiceAccount, subjectNs, asString(subject.name)), 'binds');
        }
        const roleRef = asObject(obj.roleRef);
        const roleName = asString(roleRef.name);
        if (asString(roleRef.kind) === 'ClusterRole')
          link(id, builtin(BUILTIN.ClusterRole, null, roleName), 'role-ref');
        else if (asString(roleRef.kind) === 'Role')
          link(id, builtin(BUILTIN.Role, ns, roleName), 'role-ref');
        break;
      }
      case 'HorizontalPodAutoscaler': {
        const ref = asObject(s.scaleTargetRef);
        const gvk = resolveRef(asString(ref.apiVersion), asString(ref.kind), input.apiResources);
        if (gvk) link(id, { gvk, namespace: ns, name: asString(ref.name) }, 'scales');
        break;
      }
      case 'PodDisruptionBudget':
        selectPods(id, ns, selectorOrAll(s.selector), 'budget');
        break;
      case 'NetworkPolicy':
        selectPods(id, ns, selectorOrAll(s.podSelector), 'policy');
        break;
      default:
        break;
    }
  }

  // Owner references (any kind): owner → owned.
  for (const [id, obj] of observed) {
    for (const ref of obj.metadata.ownerReferences ?? []) {
      // Mirror pods are owned by their Node; `runs-on` already says so.
      if (ref.kind === 'Node') continue;
      const owner = byUid.get(ref.uid);
      if (owner) {
        addEdge(owner, id, 'owns');
        continue;
      }
      const gvk = resolveRef(ref.apiVersion, ref.kind, input.apiResources);
      if (!gvk) continue;
      const to = target({ gvk, namespace: obj.metadata.namespace ?? null, name: ref.name });
      if (to) addEdge(to, id, 'owns');
    }
  }

  // Controllers without pods: old ReplicaSets are inactive, idle workloads
  // keep the references of their pod template.
  const ownsOut = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== 'owns') continue;
    const list = ownsOut.get(e.from) ?? [];
    list.push(e.to);
    ownsOut.set(e.from, list);
  }
  const hasPods = (id: string, depth = 0): boolean =>
    depth < 4 &&
    (ownsOut.get(id) ?? []).some((c) => nodes.get(c)?.kind === 'Pod' || hasPods(c, depth + 1));
  const ownedByWorkload = (obj: KubeObject) =>
    (obj.metadata.ownerReferences ?? []).some((r) => WORKLOAD_KINDS.has(r.kind));

  for (const [id, obj] of observed) {
    if (!WORKLOAD_KINDS.has(obj.kind) || hasPods(id)) continue;
    const node = nodes.get(id)!;
    if (obj.kind === 'ReplicaSet' || obj.kind === 'ReplicationController') {
      const desired = spec(obj).replicas === undefined ? 1 : Number(spec(obj).replicas);
      if (desired === 0 && ownedByWorkload(obj)) {
        node.inactive = true;
        continue;
      }
    }
    // Owned controllers leave their template to the workload above them.
    if ((obj.kind === 'ReplicaSet' || obj.kind === 'Job') && ownedByWorkload(obj)) continue;
    linkPodSpec(id, obj.metadata.namespace ?? '', podTemplateSpec(obj), null);
  }

  // Custom owners sit one column left of what they own.
  const knownTier = (kind: string) => tierOf(kind) !== TIER.workload || WORKLOAD_KINDS.has(kind);
  for (const [id, children] of ownsOut) {
    const node = nodes.get(id);
    if (!node || knownTier(node.kind)) continue;
    const min = Math.min(...children.map((c) => nodes.get(c)?.tier ?? TIER.workload + 1));
    node.tier = Math.max(0, Math.min(TIER.workload, min - 1));
  }

  return { nodes, edges };
}
