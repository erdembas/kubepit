import { matchesSelector } from '../selectors';
import { parseCidr, parseIp, rangeContains, rangeOverlaps, type IpRange } from './ip';
import type {
  Coverage,
  Direction,
  NpCluster,
  NpEndpoint,
  NpPeer,
  NpPod,
  NpPolicy,
  NpRule,
  PairResult,
  Protocol,
  RuleHit,
  SideResult,
} from './model';
import {
  ALL_PORTS,
  hasPort,
  intersectPorts,
  isAllPorts,
  isEmptyPorts,
  NO_PORTS,
  portSet,
  unionPorts,
  type PortRange,
  type PortSet,
} from './ports';

/**
 * NetworkPolicy semantics (networking.k8s.io/v1):
 *
 * - A pod is isolated for a direction only when a policy in its namespace
 *   selects it and lists that direction in `policyTypes` (defaulted from
 *   the rules when omitted). Unisolated directions allow everything.
 * - An isolated direction allows the union of the rules of every policy
 *   isolating it; a connection needs the source's egress and the
 *   destination's ingress to allow it.
 * - Within a peer `podSelector` and `namespaceSelector` are ANDed; peers
 *   of a rule, rules and policies are ORed. An omitted or empty `from` /
 *   `to` matches everyone, omitted or empty `ports` every port.
 * - Named ports resolve on the destination pod (name and protocol).
 * - Ingress from the pod's own node and a pod reaching itself are always
 *   allowed. Host-network pods are treated the way most plugins do: they
 *   are never isolated and match no pod selector; their traffic comes from
 *   the node IP.
 */

export interface PortTarget {
  protocol: Protocol;
  port: number;
}

function memo<T>(cluster: NpCluster, key: string, compute: () => T): T {
  if (cluster.memo.has(key)) return cluster.memo.get(key) as T;
  const value = compute();
  cluster.memo.set(key, value);
  return value;
}

export function namespaceLabels(cluster: NpCluster, namespace: string): Record<string, string> {
  return (cluster.namespaces.get(namespace)?.labels ?? {}) as Record<string, string>;
}

/** Policies of the pod's namespace whose podSelector selects it (any direction). */
export function selectingPolicies(cluster: NpCluster, pod: NpPod): readonly NpPolicy[] {
  return memo(cluster, `sel|${pod.id}`, () =>
    (cluster.policiesByNamespace.get(pod.namespace) ?? []).filter((p) =>
      matchesSelector(p.podSelector, pod.labels as Record<string, string>),
    ),
  );
}

/** Policies isolating the pod for a direction (ignores the host-network caveat). */
export function isolatingPolicies(
  cluster: NpCluster,
  pod: NpPod,
  direction: Direction,
): readonly NpPolicy[] {
  return selectingPolicies(cluster, pod).filter((p) =>
    direction === 'ingress' ? p.ingress : p.egress,
  );
}

/** Pods a policy's podSelector selects. */
export function selectedPods(cluster: NpCluster, policy: NpPolicy): NpPod[] {
  return (cluster.podsByNamespace.get(policy.namespace) ?? []).filter((p) =>
    matchesSelector(policy.podSelector, p.labels as Record<string, string>),
  );
}

const cidrs = new Map<string, IpRange | null>();

/** parseCidr with a cache: policies repeat the same few blocks. */
export function cidrRange(text: string): IpRange | null {
  let r = cidrs.get(text);
  if (r === undefined) {
    if (cidrs.size > 4096) cidrs.clear();
    r = parseCidr(text);
    cidrs.set(text, r);
  }
  return r;
}

function ipBlockMatchesRange(peer: { cidr: string; except: readonly string[] }, range: IpRange) {
  const cidr = cidrRange(peer.cidr);
  if (!cidr || !rangeContains(cidr, range)) return false;
  return !peer.except.some((e) => {
    const r = cidrRange(e);
    return !!r && rangeOverlaps(r, range);
  });
}

function ipBlockMatchesIp(peer: { cidr: string; except: readonly string[] }, ip: string) {
  const addr = parseIp(ip);
  if (!addr) return false;
  return ipBlockMatchesRange(peer, { v: addr.v, start: addr.n, end: addr.n });
}

/** Addresses a pod's traffic carries: its pod IPs, or the node IP for host-network pods. */
export function podAddresses(pod: NpPod): readonly string[] {
  if (pod.hostNetwork) return pod.hostIP ? [pod.hostIP] : pod.ips;
  return pod.ips;
}

export interface PeerMatch {
  match: boolean;
  /** An ipBlock matched an in-cluster pod IP (plugins differ here). */
  ipBlockOnPod?: boolean;
}

/** Does `peer` of a policy in `policyNamespace` match the endpoint? */
export function peerMatches(
  cluster: NpCluster,
  policyNamespace: string,
  peer: NpPeer,
  endpoint: NpEndpoint,
): PeerMatch {
  switch (peer.type) {
    case 'invalid':
      return { match: false };
    case 'pods': {
      if (endpoint.type !== 'pod' || endpoint.pod.hostNetwork) return { match: false };
      const pod = endpoint.pod;
      const nsOk = peer.namespaceSelector
        ? matchesSelector(peer.namespaceSelector, namespaceLabels(cluster, pod.namespace))
        : pod.namespace === policyNamespace;
      if (!nsOk) return { match: false };
      const podOk = peer.podSelector
        ? matchesSelector(peer.podSelector, pod.labels as Record<string, string>)
        : true;
      return { match: podOk };
    }
    case 'ipBlock': {
      if (endpoint.type === 'ip') return { match: ipBlockMatchesRange(peer, endpoint.range) };
      const hit = podAddresses(endpoint.pod).some((ip) => ipBlockMatchesIp(peer, ip));
      return hit ? { match: true, ipBlockOnPod: !endpoint.pod.hostNetwork } : { match: false };
    }
  }
}

/** Live pods a peer of a policy in `policyNamespace` matches (ipBlocks: pods whose IP falls inside). */
export function podsMatchingPeer(
  cluster: NpCluster,
  policyNamespace: string,
  peer: NpPeer,
): NpPod[] {
  return cluster.pods.filter(
    (pod) =>
      !pod.template && peerMatches(cluster, policyNamespace, peer, { type: 'pod', pod }).match,
  );
}

/** Resolve a named port on the destination pod (name and protocol must match). */
export function resolveNamedPort(
  pod: NpPod | null,
  name: string,
  protocol: Protocol,
): number | null {
  if (!pod || pod.hostNetwork) return null;
  return pod.ports.find((p) => p.name === name && p.protocol === protocol)?.port ?? null;
}

/** Ports a rule allows towards `destination` (named ports resolve on it). */
export function rulePorts(
  rule: NpRule,
  destination: NpPod | null,
): { ports: PortSet; unresolved: string[] } {
  if (rule.ports === null) return { ports: ALL_PORTS, unresolved: [] };
  const ranges: Partial<Record<Protocol, PortRange[]>> = {};
  const unresolved: string[] = [];
  const add = (protocol: Protocol, range: PortRange) => (ranges[protocol] ??= []).push(range);
  for (const spec of rule.ports) {
    if (spec.port === null) add(spec.protocol, [1, 65535]);
    else if (typeof spec.port === 'number')
      add(spec.protocol, [spec.port, spec.endPort ?? spec.port]);
    else {
      const port = resolveNamedPort(destination, spec.port, spec.protocol);
      if (port === null) unresolved.push(`${spec.protocol}/${spec.port}`);
      else add(spec.protocol, [port, port]);
    }
  }
  return { ports: portSet(ranges), unresolved };
}

function sameNode(pod: NpPod, other: NpEndpoint, cluster: NpCluster): boolean {
  const nodeIp = pod.hostIP ?? (pod.node ? cluster.nodeIPs.get(pod.node) : undefined);
  if (other.type === 'pod')
    return other.pod.hostNetwork && !!pod.node && other.pod.node === pod.node;
  if (!nodeIp) return false;
  const addr = parseIp(nodeIp);
  return (
    !!addr && other.range.v === addr.v && other.range.start === addr.n && other.range.end === addr.n
  );
}

function openSide(direction: Direction, state: SideResult['state']): SideResult {
  return {
    direction,
    state,
    policies: [],
    hits: [],
    peerMisses: [],
    ports: ALL_PORTS,
    unresolved: [],
  };
}

/**
 * One side of a connection: the policies of `subject` for `direction`
 * against the `other` endpoint. `destination` resolves named ports.
 */
export function evaluateSide(
  cluster: NpCluster,
  direction: Direction,
  subject: NpEndpoint,
  other: NpEndpoint,
  destination: NpPod | null,
): SideResult {
  if (subject.type === 'ip') return openSide(direction, 'external');
  const pod = subject.pod;
  if (pod.hostNetwork) return openSide(direction, 'host-network');
  if (other.type === 'pod' && other.pod.id === pod.id) return openSide(direction, 'loopback');
  const policies = isolatingPolicies(cluster, pod, direction);
  if (!policies.length) return openSide(direction, 'not-isolated');
  if (direction === 'ingress' && sameNode(pod, other, cluster)) {
    return { ...openSide(direction, 'node'), policies };
  }
  const hits: RuleHit[] = [];
  const peerMisses: Array<{ policy: NpPolicy; rule: number }> = [];
  const unresolved = new Set<string>();
  let ports: PortSet = NO_PORTS;
  for (const policy of policies) {
    const rules = direction === 'ingress' ? policy.ingressRules : policy.egressRules;
    for (const rule of rules) {
      let peer: number | null = null;
      let ipBlockOnPod = false;
      let matched = rule.peers === null;
      if (rule.peers) {
        for (let i = 0; i < rule.peers.length; i++) {
          const m = peerMatches(cluster, policy.namespace, rule.peers[i]!, other);
          if (m.match) {
            matched = true;
            peer = i;
            ipBlockOnPod = !!m.ipBlockOnPod;
            break;
          }
        }
      }
      if (!matched) {
        peerMisses.push({ policy, rule: rule.index });
        continue;
      }
      const allowed = rulePorts(rule, destination);
      for (const u of allowed.unresolved) unresolved.add(u);
      hits.push({
        policy,
        direction,
        rule: rule.index,
        peer,
        ports: allowed.ports,
        ...(ipBlockOnPod ? { ipBlockOnPod } : {}),
      });
      ports = unionPorts(ports, allowed.ports);
    }
  }
  return {
    direction,
    state: 'isolated',
    policies,
    hits,
    peerMisses,
    ports,
    unresolved: [...unresolved].sort(),
  };
}

/** A connection from `source` to `destination`: source egress ∩ destination ingress. */
export function evaluatePair(
  cluster: NpCluster,
  source: NpEndpoint,
  destination: NpEndpoint,
): PairResult {
  const dstPod = destination.type === 'pod' ? destination.pod : null;
  const egress = evaluateSide(cluster, 'egress', source, destination, dstPod);
  const ingress = evaluateSide(cluster, 'ingress', destination, source, dstPod);
  return {
    source,
    destination,
    egress,
    ingress,
    ports: intersectPorts(egress.ports, ingress.ports),
  };
}

/**
 * How much of `targets` a port set allows. `null` targets mean "any port":
 * every port is `all`, some ports `some`.
 */
export function coverageOf(ports: PortSet, targets: readonly PortTarget[] | null): Coverage {
  if (targets === null) return isAllPorts(ports) ? 'all' : isEmptyPorts(ports) ? 'none' : 'some';
  if (!targets.length) return 'none';
  const n = targets.filter((t) => hasPort(ports, t.protocol, t.port)).length;
  return n === targets.length ? 'all' : n === 0 ? 'none' : 'some';
}

/** Combine coverages of several pairs (all only when every one is all). */
export function combineCoverage(values: Iterable<Coverage>): Coverage {
  let all = true;
  let none = true;
  let any = false;
  for (const v of values) {
    any = true;
    if (v !== 'all') all = false;
    if (v !== 'none') none = false;
  }
  if (!any) return 'none';
  return all ? 'all' : none ? 'none' : 'some';
}

/** The ports a pod declares (null when it declares none). */
export function declaredTargets(pod: NpPod): PortTarget[] | null {
  if (!pod.ports.length) return null;
  const seen = new Set<string>();
  const out: PortTarget[] = [];
  for (const p of pod.ports) {
    const key = `${p.protocol}/${p.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ protocol: p.protocol, port: p.port });
  }
  return out;
}
