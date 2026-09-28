import {
  cidrRange,
  combineCoverage,
  coverageOf,
  declaredTargets,
  evaluatePair,
  isolatingPolicies,
  podAddresses,
  type PortTarget,
} from './engine';
import { formatRange, ipInRange, type IpRange } from './ip';
import type {
  Coverage,
  Direction,
  NpCluster,
  NpEndpoint,
  NpPod,
  NpPolicy,
  NpRule,
  NpService,
  NpWorkloadRef,
  PairResult,
} from './model';
import { externalEndpoints, podWorkloadKey, serviceBackends } from './query';

/**
 * Per-pod "who can reach me / whom can I reach", the namespace matrix
 * (workload × workload) and the protection list. Pairs are memoised per
 * equivalence class (namespace, labels, ports, ipBlock matches), so a
 * workload with many replicas costs one evaluation per peer class.
 */

export interface WorkloadGroup {
  key: string;
  namespace: string;
  workload: NpWorkloadRef;
  pods: NpPod[];
}

export function workloadGroups(pods: readonly NpPod[]): WorkloadGroup[] {
  const map = new Map<string, WorkloadGroup>();
  for (const pod of pods) {
    const key = podWorkloadKey(pod);
    const group = map.get(key);
    if (group) group.pods.push(pod);
    else map.set(key, { key, namespace: pod.namespace, workload: pod.workload, pods: [pod] });
  }
  return [...map.values()].sort(
    (a, b) =>
      a.namespace.localeCompare(b.namespace) ||
      a.workload.name.localeCompare(b.workload.name) ||
      a.workload.kind.localeCompare(b.workload.kind),
  );
}

/** Distinct ipBlocks of the cluster (cidr + excepts). */
function ipBlocks(cluster: NpCluster): Array<{ cidr: IpRange; except: IpRange[] }> {
  const key = 'ipblocks';
  const cached = cluster.memo.get(key) as Array<{ cidr: IpRange; except: IpRange[] }> | undefined;
  if (cached) return cached;
  const seen = new Map<string, { cidr: IpRange; except: IpRange[] }>();
  for (const policy of cluster.policies) {
    for (const rule of [...policy.ingressRules, ...policy.egressRules]) {
      for (const peer of rule.peers ?? []) {
        if (peer.type !== 'ipBlock') continue;
        const id = `${peer.cidr}|${peer.except.join(',')}`;
        const cidr = cidrRange(peer.cidr);
        if (!cidr || seen.has(id)) continue;
        seen.set(id, {
          cidr,
          except: peer.except.map((e) => cidrRange(e)).filter((r): r is IpRange => !!r),
        });
      }
    }
  }
  const list = [...seen.values()];
  cluster.memo.set(key, list);
  return list;
}

/** Pods with the same class key behave identically as sources and destinations. */
function classKey(cluster: NpCluster, pod: NpPod): string {
  const key = `class|${pod.id}`;
  const cached = cluster.memo.get(key) as string | undefined;
  if (cached) return cached;
  const labels = Object.entries(pod.labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  const ports = pod.ports.map((p) => `${p.name}/${p.protocol}/${p.port}`).join(',');
  const addresses = podAddresses(pod);
  const sig = ipBlocks(cluster)
    .map((b) =>
      addresses.some((ip) => ipInRange(ip, b.cidr) && !b.except.some((e) => ipInRange(ip, e)))
        ? '1'
        : '0',
    )
    .join('');
  const value = `${pod.namespace}|${labels}|${ports}|${pod.hostNetwork ? 'H' : ''}|${sig}`;
  cluster.memo.set(key, value);
  return value;
}

/** evaluatePair with a class memo (host-network and loopback pairs are evaluated directly). */
export function pairFor(cluster: NpCluster, src: NpPod, dst: NpPod): PairResult {
  const a: NpEndpoint = { type: 'pod', pod: src };
  const b: NpEndpoint = { type: 'pod', pod: dst };
  if (src.id === dst.id || src.hostNetwork || dst.hostNetwork) return evaluatePair(cluster, a, b);
  const key = `pair|${classKey(cluster, src)}>${classKey(cluster, dst)}`;
  const cached = cluster.memo.get(key) as PairResult | undefined;
  if (cached) return { ...cached, source: a, destination: b };
  const result = evaluatePair(cluster, a, b);
  cluster.memo.set(key, result);
  return result;
}

/** Targets of a destination pod: the asked port, else its declared ports (null: any port). */
export function targetsFor(dst: NpPod, port: PortTarget | null): readonly PortTarget[] | null {
  return port ? [port] : declaredTargets(dst);
}

export interface PeerReach {
  group: WorkloadGroup;
  coverage: Coverage;
  /** Pod pairs evaluated / allowed (all or some ports). */
  pairs: number;
  reachable: number;
}

export interface ExternalReach {
  coverage: Coverage;
  /** When only some addresses are allowed: the allowed CIDRs… */
  ranges: string[];
  /** …and the denied ones (show whichever list is shorter). */
  except: string[];
}

export interface DirectionSummary {
  direction: Direction;
  state: 'isolated' | 'not-isolated' | 'host-network';
  policies: readonly NpPolicy[];
  rules: Array<{ policy: NpPolicy; rule: NpRule }>;
  /** Workloads (the pod's own replicas included) by what they can reach. */
  peers: PeerReach[];
  external: ExternalReach;
}

export interface DnsReach {
  service: NpService;
  coverage: Coverage;
  pods: number;
}

export interface ReachSummary {
  pod: NpPod;
  ingress: DirectionSummary;
  egress: DirectionSummary;
  dns: DnsReach | null;
}

function nodeSingletons(cluster: NpCluster): Set<string> {
  const out = new Set<string>();
  for (const ip of cluster.nodeIPs.values()) {
    const r = cidrRange(ip);
    if (r) out.add(`${r.v}|${r.start}`);
  }
  return out;
}

/** Every address of [start, end] is a node IP (left out of external pieces). */
function onlyNodes(v: 4 | 6, start: bigint, end: bigint, nodes: Set<string>): boolean {
  if (end - start + 1n > BigInt(nodes.size)) return false;
  for (let a = start; a <= end; a++) if (!nodes.has(`${v}|${a}`)) return false;
  return true;
}

/** Merge ranges; gaps made only of node IPs are bridged. */
function mergeRanges(ranges: IpRange[], nodes: Set<string>): IpRange[] {
  const sorted = [...ranges].sort((a, b) =>
    a.v !== b.v ? a.v - b.v : a.start < b.start ? -1 : a.start > b.start ? 1 : 0,
  );
  const out: IpRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    const touches =
      !!last &&
      last.v === r.v &&
      (r.start <= last.end + 1n || onlyNodes(r.v, last.end + 1n, r.start - 1n, nodes));
    if (last && touches)
      out[out.length - 1] = { ...last, end: r.end > last.end ? r.end : last.end };
    else out.push({ ...r });
  }
  return out;
}

function externalReach(
  cluster: NpCluster,
  pod: NpPod,
  direction: Direction,
  port: PortTarget | null,
): ExternalReach {
  const families: Array<4 | 6> = [
    ...(pod.ips.some((ip) => !ip.includes(':')) || !pod.ips.length ? [4 as const] : []),
    ...(pod.ips.some((ip) => ip.includes(':')) ? [6 as const] : []),
  ];
  const results: Array<{ range: IpRange; coverage: Coverage }> = [];
  for (const v of families) {
    for (const ep of externalEndpoints(cluster, v === 4 ? '0.0.0.0/0' : '::/0') ?? []) {
      if (ep.type !== 'ip') continue;
      const self: NpEndpoint = { type: 'pod', pod };
      const result =
        direction === 'ingress' ? evaluatePair(cluster, ep, self) : evaluatePair(cluster, self, ep);
      const targets = direction === 'ingress' ? targetsFor(pod, port) : port ? [port] : null;
      results.push({ range: ep.range, coverage: coverageOf(result.ports, targets) });
    }
  }
  const coverage = combineCoverage(results.map((r) => r.coverage));
  if (coverage !== 'some') return { coverage, ranges: [], except: [] };
  const nodes = nodeSingletons(cluster);
  const merged = (keep: (c: Coverage) => boolean) =>
    mergeRanges(
      results.filter((r) => keep(r.coverage)).map((r) => r.range),
      nodes,
    )
      .flatMap(rangeToCidrs)
      .map(formatRange);
  return { coverage, ranges: merged((c) => c !== 'none'), except: merged((c) => c === 'none') };
}

/** Split an arbitrary range into CIDR blocks for display. */
export function rangeToCidrs(range: IpRange): IpRange[] {
  const out: IpRange[] = [];
  const bits = range.v === 4 ? 32n : 128n;
  let start = range.start;
  while (start <= range.end) {
    let size = 0n;
    while (
      size < bits &&
      (start & ((1n << (size + 1n)) - 1n)) === 0n &&
      start + (1n << (size + 1n)) - 1n <= range.end
    )
      size++;
    out.push({ v: range.v, start, end: start + (1n << size) - 1n });
    start += 1n << size;
  }
  return out;
}

function directionSummary(
  cluster: NpCluster,
  pod: NpPod,
  direction: Direction,
  port: PortTarget | null,
): DirectionSummary {
  const policies = isolatingPolicies(cluster, pod, direction);
  const state = pod.hostNetwork ? 'host-network' : policies.length ? 'isolated' : 'not-isolated';
  const rules = policies.flatMap((policy) =>
    (direction === 'ingress' ? policy.ingressRules : policy.egressRules).map((rule) => ({
      policy,
      rule,
    })),
  );
  const peers: PeerReach[] = [];
  const own = podWorkloadKey(pod);
  for (const group of workloadGroups(cluster.pods.filter((p) => !p.template))) {
    let pairs = 0;
    let reachable = 0;
    const coverages: Coverage[] = [];
    for (const other of group.pods) {
      if (other.id === pod.id) continue;
      const src = direction === 'ingress' ? other : pod;
      const dst = direction === 'ingress' ? pod : other;
      const result = pairFor(cluster, src, dst);
      const c = coverageOf(result.ports, targetsFor(dst, port));
      coverages.push(c);
      pairs++;
      if (c !== 'none') reachable++;
    }
    if (!pairs) continue;
    peers.push({ group, coverage: combineCoverage(coverages), pairs, reachable });
  }
  // The pod's own replicas first, then its namespace, then the rest.
  const rank = (p: PeerReach) =>
    p.group.key === own ? 0 : p.group.namespace === pod.namespace ? 1 : 2;
  peers.sort((a, b) => rank(a) - rank(b));
  return {
    direction,
    state,
    policies,
    rules,
    peers,
    external: externalReach(cluster, pod, direction, port),
  };
}

/** kube-dns / CoreDNS Service in kube-system. */
export function dnsService(cluster: NpCluster): NpService | null {
  const candidates = cluster.services.filter(
    (s) =>
      s.namespace === 'kube-system' &&
      ['kube-dns', 'coredns', 'rke2-coredns-rke2-coredns'].includes(s.name),
  );
  return candidates.find((s) => s.name === 'kube-dns') ?? candidates[0] ?? null;
}

function dnsReach(cluster: NpCluster, pod: NpPod): DnsReach | null {
  const service = dnsService(cluster);
  if (!service) return null;
  const backends = serviceBackends(cluster, service);
  if (!backends.length) return null;
  const coverages = backends.map((dst) =>
    coverageOf(pairFor(cluster, pod, dst).ports, [{ protocol: 'UDP', port: 53 }]),
  );
  return { service, coverage: combineCoverage(coverages), pods: backends.length };
}

export function reachSummary(
  cluster: NpCluster,
  pod: NpPod,
  port: PortTarget | null = null,
): ReachSummary {
  return {
    pod,
    ingress: directionSummary(cluster, pod, 'ingress', port),
    egress: directionSummary(cluster, pod, 'egress', port),
    dns: pod.namespace === 'kube-system' ? null : dnsReach(cluster, pod),
  };
}

export interface MatrixCell {
  coverage: Coverage;
  pairs: number;
  reachable: number;
}

export interface NamespaceMatrix {
  namespace: string;
  groups: WorkloadGroup[];
  /** cells[row = source][column = destination]. */
  cells: MatrixCell[][];
  /** From outside the cluster (0.0.0.0/0) into each destination column. */
  fromExternal: MatrixCell[];
  /** From each source row to outside the cluster. */
  toExternal: MatrixCell[];
}

function cell(coverages: Coverage[]): MatrixCell {
  return {
    coverage: combineCoverage(coverages),
    pairs: coverages.length,
    reachable: coverages.filter((c) => c !== 'none').length,
  };
}

const MATRIX_PAIR_BUDGET = 40_000;

export function namespaceMatrix(
  cluster: NpCluster,
  namespace: string,
  port: PortTarget | null,
): NamespaceMatrix {
  const groups = workloadGroups(
    (cluster.podsByNamespace.get(namespace) ?? []).filter((p) => !p.template),
  );
  // Large workloads are sampled so the grid stays interactive.
  const per = Math.max(
    1,
    Math.floor(Math.sqrt(MATRIX_PAIR_BUDGET / Math.max(1, groups.length * groups.length))),
  );
  const pick = (g: WorkloadGroup) => (g.pods.length > per ? g.pods.slice(0, per) : g.pods);
  const cells = groups.map((from) =>
    groups.map((to) => {
      const coverages: Coverage[] = [];
      for (const src of pick(from))
        for (const dst of pick(to)) {
          if (src.id === dst.id) continue;
          coverages.push(coverageOf(pairFor(cluster, src, dst).ports, targetsFor(dst, port)));
        }
      // A single-pod workload against itself: loopback is always allowed.
      if (!coverages.length) coverages.push('all');
      return cell(coverages);
    }),
  );
  const external = (group: WorkloadGroup, direction: Direction) =>
    cell(pick(group).map((pod) => externalReach(cluster, pod, direction, port).coverage));
  return {
    namespace,
    groups,
    cells,
    fromExternal: groups.map((g) => external(g, 'ingress')),
    toExternal: groups.map((g) => external(g, 'egress')),
  };
}

export interface Protection {
  group: WorkloadGroup;
  ingress: 'host-network' | 'open' | 'isolated' | 'deny-all';
  egress: 'host-network' | 'open' | 'isolated' | 'deny-all';
  ingressPolicies: readonly NpPolicy[];
  egressPolicies: readonly NpPolicy[];
}

function protectionState(
  pod: NpPod,
  policies: readonly NpPolicy[],
  direction: Direction,
): Protection['ingress'] {
  if (pod.hostNetwork) return 'host-network';
  if (!policies.length) return 'open';
  const rules = policies.flatMap((p) => (direction === 'ingress' ? p.ingressRules : p.egressRules));
  return rules.length ? 'isolated' : 'deny-all';
}

/** Isolation per workload of the given namespaces (all when empty). */
export function protectionList(cluster: NpCluster, namespaces: readonly string[]): Protection[] {
  const pods = cluster.pods.filter(
    (p) => !p.template && (!namespaces.length || namespaces.includes(p.namespace)),
  );
  return workloadGroups(pods).map((group) => {
    const pod = group.pods[0]!;
    const ingressPolicies = isolatingPolicies(cluster, pod, 'ingress');
    const egressPolicies = isolatingPolicies(cluster, pod, 'egress');
    return {
      group,
      ingress: protectionState(pod, ingressPolicies, 'ingress'),
      egress: protectionState(pod, egressPolicies, 'egress'),
      ingressPolicies,
      egressPolicies,
    };
  });
}
