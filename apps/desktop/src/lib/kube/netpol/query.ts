import { matchesSelector } from '../selectors';
import {
  cidrRange,
  combineCoverage,
  coverageOf,
  declaredTargets,
  evaluatePair,
  podAddresses,
  resolveNamedPort,
  type PortTarget,
} from './engine';
import { parseCidr, parseIp, splitRange, type IpRange } from './ip';
import type {
  Coverage,
  NpCluster,
  NpEndpoint,
  NpPod,
  NpService,
  NpServicePort,
  PairResult,
  Protocol,
} from './model';
import { portsKey } from './ports';

/**
 * "Can A talk to B?": resolves the picked source and destination into
 * endpoints, evaluates every pair and groups the pairs by explanation.
 */

export type NpSelection =
  | { type: 'pod'; namespace: string; name: string }
  | { type: 'workload'; namespace: string; kind: string; name: string }
  | { type: 'namespace'; name: string }
  | { type: 'service'; namespace: string; name: string }
  /** Outside the cluster: an address or a CIDR. */
  | { type: 'external'; cidr: string };

export interface SimQuery {
  source: NpSelection;
  destination: NpSelection;
  protocol: Protocol;
  /** Number or named port; null checks the destination's declared ports (or any port). */
  port: number | string | null;
}

export interface SimPair {
  result: PairResult;
  coverage: Coverage;
  /** Ports checked on the destination; null = any port. */
  targets: readonly PortTarget[] | null;
  /** The Service port the pair was reached through. */
  servicePort?: NpServicePort;
  /** The asked (named or Service) port does not exist on the destination pod. */
  noTargetPort?: boolean;
}

export interface SimGroup {
  signature: string;
  coverage: Coverage;
  count: number;
  example: SimPair;
}

export type SimProblem =
  | 'no-source'
  | 'no-destination'
  | 'invalid-cidr'
  | 'both-external'
  | 'no-selector'
  | 'no-service-port';

export interface SimResult {
  verdict: 'allowed' | 'partial' | 'denied' | 'unknown';
  problem: SimProblem | null;
  pairs: number;
  counts: Record<Coverage, number>;
  groups: SimGroup[];
  /** Pairs beyond the evaluation budget were sampled. */
  truncated: boolean;
  /** A picked address belongs to a pod: the pod was used instead. */
  resolvedIp: NpPod | null;
  flags: {
    hostNetwork: boolean;
    ipBlockOnPod: boolean;
    unresolved: string[];
    loopback: boolean;
  };
  /** Namespaces whose policies took part (for the unevaluated-policy caveat). */
  namespaces: string[];
}

const MAX_PAIRS = 20_000;

export function workloadKey(namespace: string, kind: string, name: string) {
  return `${namespace}|${kind}|${name}`;
}

export function podWorkloadKey(pod: NpPod) {
  return workloadKey(pod.namespace, pod.workload.kind, pod.workload.name);
}

export function findPod(cluster: NpCluster, namespace: string, name: string): NpPod | null {
  return cluster.podsByNamespace.get(namespace)?.find((p) => p.name === name) ?? null;
}

export function findService(cluster: NpCluster, namespace: string, name: string): NpService | null {
  return cluster.services.find((s) => s.namespace === namespace && s.name === name) ?? null;
}

/** Pods a Service routes to (its selector in its namespace). */
export function serviceBackends(cluster: NpCluster, svc: NpService): NpPod[] {
  if (!svc.selector) return [];
  const selector = { matchLabels: { ...svc.selector }, matchExpressions: [] };
  return (cluster.podsByNamespace.get(svc.namespace) ?? []).filter(
    (p) => !p.template && matchesSelector(selector, p.labels as Record<string, string>),
  );
}

/** Pods behind a pod / workload / namespace / Service selection. */
export function selectionPods(cluster: NpCluster, sel: NpSelection): NpPod[] {
  switch (sel.type) {
    case 'pod': {
      const pod = findPod(cluster, sel.namespace, sel.name);
      return pod ? [pod] : [];
    }
    case 'workload': {
      const pods = (cluster.podsByNamespace.get(sel.namespace) ?? []).filter(
        (p) => p.workload.kind === sel.kind && p.workload.name === sel.name,
      );
      // Prefer real pods over the workload's template.
      const live = pods.filter((p) => !p.template);
      return live.length ? live : pods;
    }
    case 'namespace':
      return (cluster.podsByNamespace.get(sel.name) ?? []).filter((p) => !p.template);
    case 'service': {
      const svc = findService(cluster, sel.namespace, sel.name);
      return svc ? serviceBackends(cluster, svc) : [];
    }
    case 'external':
      return [];
  }
}

/** Every ipBlock boundary and node address: pieces of a split range behave alike. */
function rangeCuts(cluster: NpCluster): IpRange[] {
  const key = 'cuts';
  const cached = cluster.memo.get(key) as IpRange[] | undefined;
  if (cached) return cached;
  const cuts: IpRange[] = [];
  for (const policy of cluster.policies) {
    for (const rule of [...policy.ingressRules, ...policy.egressRules]) {
      for (const peer of rule.peers ?? []) {
        if (peer.type !== 'ipBlock') continue;
        for (const c of [peer.cidr, ...peer.except]) {
          const r = cidrRange(c);
          if (r) cuts.push(r);
        }
      }
    }
  }
  for (const ip of cluster.nodeIPs.values()) {
    const r = parseCidr(ip);
    if (r) cuts.push(r);
  }
  cluster.memo.set(key, cuts);
  return cuts;
}

/**
 * External endpoints of a CIDR, split so every piece evaluates uniformly.
 * Node addresses inside a wider range are not "outside the cluster" and
 * are left out; a single address is always kept.
 */
export function externalEndpoints(cluster: NpCluster, cidr: string): NpEndpoint[] | null {
  const range = parseCidr(cidr);
  if (!range) return null;
  if (range.start === range.end) return [{ type: 'ip', range }];
  const nodes = new Set<string>();
  for (const ip of cluster.nodeIPs.values()) {
    const addr = parseIp(ip);
    if (addr) nodes.add(`${addr.v}|${addr.n}`);
  }
  return splitRange(range, rangeCuts(cluster))
    .filter((r) => !(r.start === r.end && nodes.has(`${r.v}|${r.start}`)))
    .map((r) => ({ type: 'ip' as const, range: r }));
}

/** The pod owning an address (host-network pods excluded: that address is the node's). */
export function podByIp(cluster: NpCluster, ip: string): NpPod | null {
  const addr = parseIp(ip);
  if (!addr) return null;
  for (const pod of cluster.pods) {
    if (pod.hostNetwork) continue;
    for (const pip of podAddresses(pod)) {
      const other = parseIp(pip);
      if (other && other.v === addr.v && other.n === addr.n) return pod;
    }
  }
  return null;
}

interface Destination {
  endpoint: NpEndpoint;
  targets: readonly PortTarget[] | null;
  servicePort?: NpServicePort;
  noTargetPort?: boolean;
}

function podTargets(
  pod: NpPod,
  protocol: Protocol,
  port: number | string | null,
): { targets: readonly PortTarget[] | null; missing: boolean } {
  if (port === null) return { targets: declaredTargets(pod), missing: false };
  if (typeof port === 'number') return { targets: [{ protocol, port }], missing: false };
  const resolved = resolveNamedPort(pod, port, protocol);
  return resolved === null
    ? { targets: [], missing: true }
    : { targets: [{ protocol, port: resolved }], missing: false };
}

function serviceDestinations(
  cluster: NpCluster,
  svc: NpService,
  protocol: Protocol,
  port: number | string | null,
): Destination[] | SimProblem {
  if (!svc.selector) return 'no-selector';
  const ports =
    port === null
      ? svc.ports
      : svc.ports.filter(
          (p) =>
            p.protocol === protocol &&
            (typeof port === 'number' ? p.port === port : p.name === port),
        );
  if (!ports.length) return 'no-service-port';
  const out: Destination[] = [];
  for (const pod of serviceBackends(cluster, svc)) {
    for (const sp of ports) {
      const target =
        typeof sp.targetPort === 'number'
          ? sp.targetPort
          : resolveNamedPort(pod, sp.targetPort, sp.protocol);
      out.push({
        endpoint: { type: 'pod', pod },
        targets: target === null ? [] : [{ protocol: sp.protocol, port: target }],
        servicePort: sp,
        ...(target === null ? { noTargetPort: true } : {}),
      });
    }
  }
  return out;
}

function pairSignature(pair: SimPair): string {
  const side = (s: PairResult['egress']) =>
    `${s.state}:${s.policies.map((p) => p.uid).join(',')}:${s.hits
      .map((h) => `${h.policy.uid}#${h.rule}#${h.peer ?? '*'}#${portsKey(h.ports)}`)
      .join(',')}`;
  return [
    pair.coverage,
    side(pair.result.egress),
    side(pair.result.ingress),
    pair.targets === null ? '*' : pair.targets.map((t) => `${t.protocol}/${t.port}`).join(','),
    pair.noTargetPort ? 'missing' : '',
  ].join('|');
}

function empty(problem: SimProblem | null, resolvedIp: NpPod | null = null): SimResult {
  return {
    verdict: 'unknown',
    problem,
    pairs: 0,
    counts: { all: 0, some: 0, none: 0 },
    groups: [],
    truncated: false,
    resolvedIp,
    flags: { hostNetwork: false, ipBlockOnPod: false, unresolved: [], loopback: false },
    namespaces: [],
  };
}

/** Evenly spaced sample of `n` items (deterministic). */
function sample<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  const out: T[] = [];
  const step = items.length / n;
  for (let i = 0; i < n; i++) out.push(items[Math.floor(i * step)]!);
  return out;
}

/** A single external address that is really a pod's IP. */
function asPodSelection(cluster: NpCluster, sel: NpSelection): NpPod | null {
  if (sel.type !== 'external') return null;
  const range = parseCidr(sel.cidr);
  if (!range || range.start !== range.end) return null;
  return podByIp(cluster, sel.cidr);
}

export function simulate(cluster: NpCluster, query: SimQuery): SimResult {
  let { source, destination } = query;
  const { protocol, port } = query;
  let resolvedIp: NpPod | null = null;
  const srcPod = asPodSelection(cluster, source);
  if (srcPod) {
    source = { type: 'pod', namespace: srcPod.namespace, name: srcPod.name };
    resolvedIp = srcPod;
  }
  const dstPod = asPodSelection(cluster, destination);
  if (dstPod) {
    destination = { type: 'pod', namespace: dstPod.namespace, name: dstPod.name };
    resolvedIp = dstPod;
  }
  if (source.type === 'external' && destination.type === 'external')
    return empty('both-external', resolvedIp);

  let sources: NpEndpoint[];
  if (source.type === 'external') {
    const eps = externalEndpoints(cluster, source.cidr);
    if (!eps) return empty('invalid-cidr', resolvedIp);
    sources = eps;
  } else {
    sources = selectionPods(cluster, source).map((pod) => ({ type: 'pod' as const, pod }));
    if (!sources.length) return empty('no-source', resolvedIp);
  }

  let destinations: Destination[];
  if (destination.type === 'external') {
    const eps = externalEndpoints(cluster, destination.cidr);
    if (!eps) return empty('invalid-cidr', resolvedIp);
    const targets: PortTarget[] | null =
      typeof port === 'number' ? [{ protocol, port }] : port === null ? null : [];
    destinations = eps.map((endpoint) => ({
      endpoint,
      targets,
      ...(typeof port === 'string' ? { noTargetPort: true } : {}),
    }));
  } else if (destination.type === 'service') {
    const svc = findService(cluster, destination.namespace, destination.name);
    if (!svc) return empty('no-destination', resolvedIp);
    const d = serviceDestinations(cluster, svc, protocol, port);
    if (typeof d === 'string') return empty(d, resolvedIp);
    destinations = d;
  } else {
    destinations = selectionPods(cluster, destination).map((pod) => {
      const t = podTargets(pod, protocol, port);
      return {
        endpoint: { type: 'pod' as const, pod },
        targets: t.targets,
        ...(t.missing ? { noTargetPort: true } : {}),
      };
    });
  }
  if (!destinations.length) return empty('no-destination', resolvedIp);

  const total = sources.length * destinations.length;
  const truncated = total > MAX_PAIRS;
  const perSide = Math.max(1, Math.floor(Math.sqrt(MAX_PAIRS)));
  const srcList = truncated && sources.length > perSide ? sample(sources, perSide) : sources;
  const dstList = truncated
    ? sample(destinations, Math.max(1, Math.floor(MAX_PAIRS / srcList.length)))
    : destinations;

  const groups = new Map<string, SimGroup>();
  const counts: Record<Coverage, number> = { all: 0, some: 0, none: 0 };
  const namespaces = new Set<string>();
  const unresolved = new Set<string>();
  const flags = { hostNetwork: false, ipBlockOnPod: false, loopback: false };
  let pairs = 0;
  for (const src of srcList) {
    if (src.type === 'pod') namespaces.add(src.pod.namespace);
    for (const dst of dstList) {
      if (dst.endpoint.type === 'pod') namespaces.add(dst.endpoint.pod.namespace);
      const result = evaluatePair(cluster, src, dst.endpoint);
      const coverage = dst.noTargetPort ? 'none' : coverageOf(result.ports, dst.targets);
      const pair: SimPair = {
        result,
        coverage,
        targets: dst.targets,
        ...(dst.servicePort ? { servicePort: dst.servicePort } : {}),
        ...(dst.noTargetPort ? { noTargetPort: true } : {}),
      };
      pairs++;
      counts[coverage]++;
      for (const side of [result.egress, result.ingress]) {
        if (side.state === 'host-network') flags.hostNetwork = true;
        if (side.state === 'loopback') flags.loopback = true;
        if (side.hits.some((h) => h.ipBlockOnPod)) flags.ipBlockOnPod = true;
        for (const u of side.unresolved) unresolved.add(u);
      }
      if (
        (src.type === 'pod' && src.pod.hostNetwork) ||
        (dst.endpoint.type === 'pod' && dst.endpoint.pod.hostNetwork)
      )
        flags.hostNetwork = true;
      const signature = pairSignature(pair);
      const group = groups.get(signature);
      if (group) group.count++;
      else groups.set(signature, { signature, coverage, count: 1, example: pair });
    }
  }
  const coverage = combineCoverage(
    (Object.keys(counts) as Coverage[]).flatMap((c) => (counts[c] ? [c] : [])),
  );
  const rank: Record<Coverage, number> = { none: 0, some: 1, all: 2 };
  return {
    verdict: coverage === 'all' ? 'allowed' : coverage === 'none' ? 'denied' : 'partial',
    problem: null,
    pairs,
    counts,
    groups: [...groups.values()].sort(
      (a, b) => rank[a.coverage] - rank[b.coverage] || b.count - a.count,
    ),
    truncated,
    resolvedIp,
    flags: { ...flags, unresolved: [...unresolved].sort() },
    namespaces: [...namespaces].sort(),
  };
}
