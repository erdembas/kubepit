import type { KubeObject } from '@/types';
import {
  asArray,
  asNumber,
  asObject,
  asString,
  asStringMap,
  controllerOf,
  isObject,
} from '../accessors';
import type { LabelSelector } from '../selectors';
import { parseCidr } from './ip';
import type {
  NpCluster,
  NpContainerPort,
  NpNamespace,
  NpPeer,
  NpPod,
  NpPolicy,
  NpPortSpec,
  NpRule,
  NpService,
  NpServicePort,
  NpWorkloadRef,
  Protocol,
} from './model';

/** Live objects → the engine's plain model. */

const NAME_LABEL = 'kubernetes.io/metadata.name';

export function parseProtocol(raw: unknown): Protocol | null {
  const p = asString(raw, 'TCP').toUpperCase();
  return p === 'TCP' || p === 'UDP' || p === 'SCTP' ? p : null;
}

/** A metav1.LabelSelector where `{}` selects everything. */
export function parseLabelSelector(raw: unknown): LabelSelector {
  const o = asObject(raw);
  return {
    matchLabels: asStringMap(o.matchLabels),
    matchExpressions: asArray(o.matchExpressions)
      .filter(isObject)
      .map((e) => ({
        key: asString(e.key),
        operator: asString(e.operator),
        values: asArray(e.values).map((v) => asString(v)),
      })),
  };
}

function containerPorts(containers: unknown): NpContainerPort[] {
  const out: NpContainerPort[] = [];
  for (const c of asArray(containers).filter(isObject)) {
    for (const p of asArray(c.ports).filter(isObject)) {
      const port = asNumber(p.containerPort);
      const protocol = parseProtocol(p.protocol);
      if (!port || !protocol) continue;
      out.push({ name: asString(p.name), port, protocol, container: asString(c.name) });
    }
  }
  return out;
}

/** Ports of a pod spec: app containers plus sidecars (init containers that keep running). */
export function podSpecPorts(podSpec: unknown): NpContainerPort[] {
  const s = asObject(podSpec);
  const sidecars = asArray(s.initContainers)
    .filter(isObject)
    .filter((c) => c.restartPolicy === 'Always');
  return [...containerPorts(s.containers), ...containerPorts(sidecars)];
}

/** The workload a pod belongs to, from its controller reference. */
export function podWorkload(pod: KubeObject): NpWorkloadRef {
  const owner = controllerOf(pod);
  if (!owner || owner.kind === 'Node') return { kind: 'Pod', name: pod.metadata.name };
  if (owner.kind === 'ReplicaSet') {
    const hash = pod.metadata.labels?.['pod-template-hash'];
    if (hash && owner.name.endsWith(`-${hash}`))
      return { kind: 'Deployment', name: owner.name.slice(0, -hash.length - 1) };
    return { kind: 'ReplicaSet', name: owner.name };
  }
  if (owner.kind === 'Job') {
    // CronJob jobs are named `<cronjob>-<scheduled minute>`.
    const m = /^(.+)-(\d{8,})$/.exec(owner.name);
    if (m) return { kind: 'CronJob', name: m[1]! };
  }
  return { kind: owner.kind, name: owner.name };
}

export function parsePod(pod: KubeObject): NpPod {
  const spec = asObject(pod.spec);
  const status = asObject(pod.status);
  const ips = asArray(status.podIPs)
    .filter(isObject)
    .map((p) => asString(p.ip))
    .filter(Boolean);
  const primary = asString(status.podIP);
  if (primary && !ips.includes(primary)) ips.unshift(primary);
  return {
    id: pod.metadata.uid,
    uid: pod.metadata.uid,
    namespace: pod.metadata.namespace ?? '',
    name: pod.metadata.name,
    labels: pod.metadata.labels ?? {},
    ips,
    hostIP: asString(status.hostIP) || null,
    node: asString(spec.nodeName) || null,
    hostNetwork: spec.hostNetwork === true,
    ports: podSpecPorts(spec),
    workload: podWorkload(pod),
    phase: asString(status.phase),
  };
}

/** Kinds whose pod template can stand in for pods that do not exist yet. */
export const TEMPLATE_KINDS = new Set([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'ReplicationController',
  'Job',
  'CronJob',
]);

/** A workload's pod template as a pod (no IP, no node): what its pods will look like. */
export function templatePod(obj: KubeObject): NpPod | null {
  if (!TEMPLATE_KINDS.has(obj.kind)) return null;
  const spec = asObject(obj.spec);
  const template =
    obj.kind === 'CronJob'
      ? asObject(asObject(asObject(spec.jobTemplate).spec).template)
      : asObject(spec.template);
  const podSpec = asObject(template.spec);
  const namespace = obj.metadata.namespace ?? '';
  return {
    id: `template|${obj.kind}|${namespace}|${obj.metadata.name}`,
    uid: null,
    namespace,
    name: obj.metadata.name,
    labels: asStringMap(asObject(template.metadata).labels),
    ips: [],
    hostIP: null,
    node: null,
    hostNetwork: podSpec.hostNetwork === true,
    ports: podSpecPorts(podSpec),
    workload: { kind: obj.kind, name: obj.metadata.name },
    phase: '',
    template: true,
  };
}

function parsePeer(raw: unknown): NpPeer {
  const o = asObject(raw);
  const hasPods = o.podSelector != null;
  const hasNs = o.namespaceSelector != null;
  const block = o.ipBlock != null ? asObject(o.ipBlock) : null;
  if (block) {
    if (hasPods || hasNs) return { type: 'invalid' };
    const cidr = asString(block.cidr);
    const except = asArray(block.except).map((e) => asString(e));
    if (!parseCidr(cidr) || except.some((e) => !parseCidr(e))) return { type: 'invalid' };
    return { type: 'ipBlock', cidr, except };
  }
  if (!hasPods && !hasNs) return { type: 'invalid' };
  return {
    type: 'pods',
    podSelector: hasPods ? parseLabelSelector(o.podSelector) : null,
    namespaceSelector: hasNs ? parseLabelSelector(o.namespaceSelector) : null,
  };
}

function parsePortSpec(raw: unknown): NpPortSpec | null {
  const o = asObject(raw);
  const protocol = parseProtocol(o.protocol);
  if (!protocol) return null;
  let port: number | string | null = null;
  if (typeof o.port === 'number') port = o.port;
  else if (typeof o.port === 'string' && o.port)
    port = /^\d+$/.test(o.port) ? Number(o.port) : o.port;
  if (typeof port === 'number' && (port < 1 || port > 65535)) return null;
  let endPort: number | null = null;
  if (typeof o.endPort === 'number') {
    // endPort needs a numeric port and must not be below it (API validation).
    if (typeof port !== 'number' || o.endPort < port || o.endPort > 65535) return null;
    endPort = o.endPort;
  }
  return { protocol, port, endPort };
}

function parseRules(raw: unknown, peerKey: 'from' | 'to'): NpRule[] {
  return asArray(raw).map((r, index) => {
    const o = asObject(r);
    const peers = asArray(o[peerKey]);
    const ports = asArray(o.ports);
    return {
      index,
      peers: peers.length ? peers.map(parsePeer) : null,
      // A list whose every entry is invalid matches no port at all.
      ports: ports.length
        ? ports.map(parsePortSpec).filter((p): p is NpPortSpec => p !== null)
        : null,
    };
  });
}

export function parsePolicy(obj: KubeObject): NpPolicy {
  const spec = asObject(obj.spec);
  const ingressRules = parseRules(spec.ingress, 'from');
  const egressRules = parseRules(spec.egress, 'to');
  const types = asArray(spec.policyTypes).map((t) => asString(t));
  // API defaulting: Ingress always, Egress when the policy has egress rules.
  const typesDefaulted = types.length === 0;
  return {
    uid: obj.metadata.uid,
    namespace: obj.metadata.namespace ?? '',
    name: obj.metadata.name,
    podSelector: parseLabelSelector(spec.podSelector),
    ingress: typesDefaulted ? true : types.includes('Ingress'),
    egress: typesDefaulted ? egressRules.length > 0 : types.includes('Egress'),
    typesDefaulted,
    ingressRules,
    egressRules,
  };
}

export function parseService(obj: KubeObject): NpService {
  const spec = asObject(obj.spec);
  const selector = asStringMap(spec.selector);
  const ports: NpServicePort[] = [];
  for (const p of asArray(spec.ports).filter(isObject)) {
    const port = asNumber(p.port);
    const protocol = parseProtocol(p.protocol);
    if (!port || !protocol) continue;
    const raw = p.targetPort;
    const targetPort =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw
          ? /^\d+$/.test(raw)
            ? Number(raw)
            : raw
          : port;
    ports.push({ name: asString(p.name), port, targetPort, protocol });
  }
  const ips = asArray(spec.clusterIPs).map((ip) => asString(ip));
  const primary = asString(spec.clusterIP);
  if (primary && !ips.includes(primary)) ips.unshift(primary);
  return {
    uid: obj.metadata.uid,
    namespace: obj.metadata.namespace ?? '',
    name: obj.metadata.name,
    type: asString(spec.type, 'ClusterIP'),
    selector: Object.keys(selector).length ? selector : null,
    ports,
    clusterIPs: ips.filter((ip) => ip && ip !== 'None'),
    externalName: asString(spec.externalName) || null,
  };
}

export function parseNamespace(obj: KubeObject): NpNamespace {
  return { name: obj.metadata.name, labels: obj.metadata.labels ?? {} };
}

function syntheticNamespace(name: string): NpNamespace {
  return { name, labels: { [NAME_LABEL]: name }, synthetic: true };
}

export interface NpInput {
  /** null: namespaces could not be listed (labels unknown). */
  namespaces: readonly KubeObject[] | null;
  pods: readonly KubeObject[];
  policies: readonly KubeObject[];
  services: readonly KubeObject[];
  /** Workload templates evaluated as pods (details of a workload without pods). */
  extraPods?: readonly NpPod[];
}

/** Terminated pods have no network; they never take part in traffic. */
function isLive(pod: KubeObject): boolean {
  const phase = asString(asObject(pod.status).phase);
  return phase !== 'Succeeded' && phase !== 'Failed';
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

/** The same snapshot plus some pods (workload templates); indexes are rebuilt, the memo is fresh. */
export function withPods(cluster: NpCluster, extra: readonly NpPod[]): NpCluster {
  if (!extra.length) return cluster;
  const pods = [...cluster.pods, ...extra];
  return {
    ...cluster,
    pods,
    podsById: new Map(pods.map((p) => [p.id, p])),
    podsByNamespace: groupBy(pods, (p) => p.namespace),
    memo: new Map(),
  };
}

export function buildCluster(input: NpInput): NpCluster {
  const pods = [...input.pods.filter(isLive).map(parsePod), ...(input.extraPods ?? [])].sort(
    (a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name),
  );
  const policies = input.policies
    .map(parsePolicy)
    .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
  const services = input.services.map(parseService);
  const namespaces = new Map<string, NpNamespace>();
  for (const ns of input.namespaces ?? []) namespaces.set(ns.metadata.name, parseNamespace(ns));
  let synthetic = input.namespaces === null;
  for (const name of [
    ...pods.map((p) => p.namespace),
    ...policies.map((p) => p.namespace),
    ...services.map((s) => s.namespace),
  ]) {
    if (!name || namespaces.has(name)) continue;
    namespaces.set(name, syntheticNamespace(name));
    synthetic = true;
  }
  const nodeIPs = new Map<string, string>();
  for (const p of pods)
    if (p.node && p.hostIP && !nodeIPs.has(p.node)) nodeIPs.set(p.node, p.hostIP);
  return {
    namespaces,
    pods,
    policies,
    services,
    podsById: new Map(pods.map((p) => [p.id, p])),
    podsByNamespace: groupBy(pods, (p) => p.namespace),
    policiesByNamespace: groupBy(policies, (p) => p.namespace),
    nodeIPs,
    namespacesSynthetic: synthetic,
    memo: new Map(),
  };
}
