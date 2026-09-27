import { asArray, asObject, isObject } from '@/lib/kube/accessors';
import { cpuMillicores, memoryBytes } from '@/lib/kube/quantity';
import type {
  KubeObject,
  PromPoint,
  PromQuerySeries,
  PrometheusMetric,
  PrometheusService,
  PrometheusTarget,
} from '@/types';
import { list, type ClusterDb } from './db';
import { buildService } from './network';
import { hashString } from './util';

/**
 * A fake Prometheus for the demo clusters: which service each cluster
 * "runs", preset series synthesised from the fixture objects (daily and
 * weekly rhythm, slow waves, noise, bursts, memory sawtooth, crash-looping
 * restarts) and a tiny PromQL look-alike for the PromQL tab. Everything is
 * a deterministic function of time, so ranges agree across reloads.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

// -- Services -------------------------------------------------------------------

/** kube-prometheus-stack on the EU production cluster (prometheus-server elsewhere). */
export function buildPrometheusServices(db: ClusterDb) {
  if (db.id !== 'c-prod-eu') return;
  buildService(db, {
    namespace: 'monitoring',
    name: 'prometheus-operated',
    type: 'Headless',
    selector: { app: 'prometheus-server' },
    labels: { 'operated-prometheus': 'true' },
    ports: [{ name: 'web', port: 9090 }],
    age: 120 * DAY,
  });
}

interface Rule {
  kind: PrometheusService['kind'];
  score: number;
  prefix?: string;
  test: (name: string, labels: Record<string, string>) => boolean;
}

/** The backend's detection rules, simplified. */
const RULES: Rule[] = [
  {
    kind: 'prometheus-operator',
    score: 100,
    test: (n, l) => n === 'prometheus-operated' || l['operated-prometheus'] === 'true',
  },
  {
    kind: 'prometheus-operator',
    score: 95,
    test: (n) => n.endsWith('-kube-prometheus-prometheus'),
  },
  { kind: 'prometheus', score: 90, test: (n) => n === 'prometheus-server' },
  { kind: 'victoria-metrics', score: 80, test: (n) => n.startsWith('vmsingle-') },
  { kind: 'thanos', score: 70, test: (n) => n.includes('thanos-query') },
  {
    kind: 'victoria-metrics',
    score: 65,
    prefix: '/select/0/prometheus',
    test: (n) => n.startsWith('vmselect-'),
  },
  {
    kind: 'mimir',
    score: 60,
    prefix: '/prometheus',
    test: (n) => n.includes('mimir') && n.includes('query-frontend'),
  },
];

export function detectServices(db: ClusterDb): PrometheusService[] {
  const out: Array<PrometheusService & { score: number }> = [];
  for (const svc of list(db, 'services')) {
    const name = svc.metadata.name;
    if (/exporter|alertmanager|operator|grafana|kube-state-metrics/.test(name)) continue;
    const rule = RULES.find((r) => r.test(name, svc.metadata.labels ?? {}));
    const ports = asArray(asObject(svc.spec).ports).filter(isObject);
    const port = Number(ports[0]?.port ?? 0);
    if (!rule || !port) continue;
    out.push({
      kind: rule.kind,
      namespace: svc.metadata.namespace ?? 'default',
      service: name,
      port,
      scheme: 'http',
      path_prefix: rule.prefix ?? '',
      score: rule.score,
    });
  }
  return out
    .sort((a, b) => b.score - a.score || a.service.localeCompare(b.service))
    .map(({ score: _score, ...service }) => service);
}

// -- Time shapes --------------------------------------------------------------------

const unit = (seed: string, n: number) => hashString(`${seed}:${n}`) / 4294967296;

/** 0 at night, 1 in the early afternoon (UTC), a little lower on weekends. */
function busy(t: number): number {
  const phase = ((t % DAY) / DAY) * 2 * Math.PI;
  const day = 0.5 + 0.5 * Math.sin(phase - Math.PI / 2 - 0.9);
  const weekday = new Date(t).getUTCDay();
  return day * (weekday === 0 || weekday === 6 ? 0.7 : 1);
}

function cpuShape(seed: string, t: number, jitter: number): number {
  const phase = (hashString(seed) % 628) / 100;
  const slow = Math.sin(t / (41 * MIN) + phase) * 0.08;
  const noise = (unit(seed, Math.floor(t / (2 * MIN))) - 0.5) * 0.16 * jitter;
  const window = Math.floor(t / (12 * MIN));
  const burst = unit(`${seed}!`, window) > 0.94 ? 0.45 * jitter : 0;
  return Math.max(0.05, 0.62 + 0.5 * busy(t) + slow + noise + burst);
}

function memShape(seed: string, t: number): number {
  const h = hashString(seed);
  const period = (3 + (h % 9)) * HOUR;
  const saw = (((t + (h % period)) % period) / period - 0.5) * 0.1;
  const drift = Math.sin(t / (5 * HOUR) + (h % 628) / 100) * 0.03;
  const noise = (unit(`${seed}~`, Math.floor(t / (5 * MIN))) - 0.5) * 0.015;
  return 0.92 + 0.08 * busy(t) + saw + drift + noise;
}

// -- Objects → base values ------------------------------------------------------------

interface Base {
  seed: string;
  cpu: number;
  mem: number;
  cpuReq: number;
  cpuLim: number;
  memReq: number;
  memLim: number;
  restartsPerHour: number;
  created: number;
}

function containersOf(pod: KubeObject, container?: string) {
  return asArray(asObject(pod.spec).containers)
    .filter(isObject)
    .filter((c) => !container || c.name === container);
}

function podBase(pod: KubeObject, container?: string): Base {
  const seed = `${pod.metadata.namespace}/${pod.metadata.name}${container ? `/${container}` : ''}`;
  const r = (n: number) => unit(seed, n);
  let cpu = 0;
  let mem = 0;
  let cpuReq = 0;
  let cpuLim = 0;
  let memReq = 0;
  let memLim = 0;
  for (const c of containersOf(pod, container)) {
    const res = asObject(c.resources);
    const req = asObject(res.requests);
    const lim = asObject(res.limits);
    cpuReq += cpuMillicores(req.cpu);
    cpuLim += cpuMillicores(lim.cpu);
    memReq += memoryBytes(req.memory);
    memLim += memoryBytes(lim.memory);
    cpu += cpuMillicores(req.cpu) * (0.25 + r(1) * 0.55) || 15 + r(2) * 90;
    mem += memoryBytes(req.memory) * (0.55 + r(3) * 0.45) || (48 + r(4) * 380) * MiB;
  }
  const statuses = asArray(asObject(pod.status).containerStatuses).filter(isObject);
  const crashing = statuses.some(
    (s) => asObject(asObject(s.state).waiting).reason === 'CrashLoopBackOff',
  );
  const restarts = statuses.reduce((n, s) => n + Number(s.restartCount ?? 0), 0);
  const running = asObject(pod.status).phase === 'Running' || crashing;
  const created = Date.parse(pod.metadata.creationTimestamp ?? '');
  return {
    seed,
    cpu: running ? cpu : 0,
    mem: running ? mem : 0,
    cpuReq,
    cpuLim,
    memReq,
    memLim,
    restartsPerHour: crashing ? 12 : restarts > 0 ? 0.02 : 0,
    created: Number.isFinite(created) ? created : 0,
  };
}

function sumBases(seed: string, bases: Base[], extra: Partial<Base> = {}): Base {
  const total: Base = {
    seed,
    cpu: 0,
    mem: 0,
    cpuReq: 0,
    cpuLim: 0,
    memReq: 0,
    memLim: 0,
    restartsPerHour: 0,
    created: 0,
  };
  for (const b of bases) {
    total.cpu += b.cpu;
    total.mem += b.mem;
    total.cpuReq += b.cpuReq;
    total.cpuLim += b.cpuLim;
    total.memReq += b.memReq;
    total.memLim += b.memLim;
    total.restartsPerHour += b.restartsPerHour;
  }
  total.cpu += extra.cpu ?? 0;
  total.mem += extra.mem ?? 0;
  return total;
}

/** Pod-name regex of a workload, like the backend's presets. */
export function workloadPodPattern(kind: string, name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suffix =
    kind === 'Deployment' || kind === 'Rollout'
      ? '-[a-z0-9]+-[a-z0-9]+'
      : kind === 'StatefulSet'
        ? '-[0-9]+'
        : kind === 'CronJob'
          ? '-[0-9]+-[a-z0-9]+'
          : ['ReplicaSet', 'DaemonSet', 'Job', 'ReplicationController'].includes(kind)
            ? '-[a-z0-9]+'
            : '-.+';
  return new RegExp(`^${escaped}${suffix}$`);
}

function active(pod: KubeObject) {
  const phase = asObject(pod.status).phase;
  return phase === 'Running' || phase === 'Pending';
}

function podsOf(db: ClusterDb, target: PrometheusTarget): KubeObject[] {
  const pods = list(db, 'pods');
  switch (target.kind) {
    case 'cluster':
      return pods.filter(active);
    case 'node':
      return pods.filter((p) => asObject(p.spec).nodeName === target.name && active(p));
    case 'namespace':
      return pods.filter((p) => p.metadata.namespace === target.namespace && active(p));
    case 'workload': {
      const re = workloadPodPattern(target.workload_kind, target.name);
      return pods.filter(
        (p) => p.metadata.namespace === target.namespace && re.test(p.metadata.name),
      );
    }
    case 'pod':
    case 'container': {
      const name = target.kind === 'pod' ? target.name : target.pod;
      return pods.filter(
        (p) => p.metadata.namespace === target.namespace && p.metadata.name === name,
      );
    }
    case 'pvc':
      return [];
  }
}

function pvcOf(db: ClusterDb, namespace: string, name: string) {
  return list(db, 'persistentvolumeclaims').find(
    (p) => p.metadata.namespace === namespace && p.metadata.name === name,
  );
}

function pvcCapacity(pvc: KubeObject | undefined): number {
  const status = asObject(asObject(pvc?.status).capacity).storage;
  const spec = asObject(asObject(asObject(pvc?.spec).resources).requests).storage;
  return memoryBytes(status ?? spec) || 10 * GiB;
}

// -- Preset series -----------------------------------------------------------------

const NODE_OVERHEAD = { cpu: 180, mem: 900 * MiB };
const NODE_DISK = 100 * GiB;

/** Timestamps of a range query: `start` aligned down to `step`. */
export function evalTimes(start: number, end: number, stepSecs: number): number[] {
  const step = stepSecs * 1000;
  const out: number[] = [];
  for (let t = Math.floor(start / step) * step; t <= end; t += step) out.push(t);
  return out;
}

/** Synthetic points of `metric` for `target`; `null` when it does not apply. */
export function presetPoints(
  db: ClusterDb,
  target: PrometheusTarget,
  metric: PrometheusMetric,
  times: number[],
  windowSecs: number,
): PromPoint[] | null {
  if (target.kind === 'pvc') {
    if (metric !== 'volume_usage' && metric !== 'volume_capacity') return null;
    const pvc = pvcOf(db, target.namespace, target.name);
    const capacity = pvcCapacity(pvc);
    const seed = `${target.namespace}/${target.name}`;
    const fill = 0.3 + unit(seed, 7) * 0.45;
    return times.map((t) => {
      if (metric === 'volume_capacity') return [t, capacity];
      // Slow growth with a weekly compaction.
      const week = ((t % (7 * DAY)) / (7 * DAY)) * 0.12;
      return [
        t,
        capacity * Math.min(0.97, fill + week + (unit(seed, Math.floor(t / HOUR)) - 0.5) * 0.01),
      ];
    });
  }
  if (target.kind === 'container' && (metric === 'network_rx' || metric === 'network_tx'))
    return null;
  if (
    (target.kind === 'node' || target.kind === 'cluster') &&
    (metric === 'volume_usage' || metric === 'volume_capacity')
  )
    return null;
  if (target.kind !== 'node' && target.kind !== 'cluster' && metric === 'fs_capacity') return null;

  const pods = podsOf(db, target);
  const container = target.kind === 'container' ? target.container : undefined;
  const bases = pods.map((p) => podBase(p, container));
  const nodes =
    target.kind === 'cluster' ? list(db, 'nodes').length : target.kind === 'node' ? 1 : 0;
  const seed = `${db.id}/${JSON.stringify(target)}`;
  const base = sumBases(seed, bases, {
    cpu: NODE_OVERHEAD.cpu * nodes,
    mem: NODE_OVERHEAD.mem * nodes,
  });
  const perPod = target.kind === 'pod' || target.kind === 'container';
  const born = perPod ? (bases[0]?.created ?? 0) : 0;
  const jitter = perPod ? 1 : target.kind === 'workload' ? 0.6 : 0.3;
  const live = times.filter((t) => t >= born);
  if (perPod && !pods.length) return [];

  switch (metric) {
    case 'cpu_usage':
      return live.map((t) => [t, base.cpu * cpuShape(seed, t, jitter)]);
    case 'memory_usage':
      return live.map((t) => [t, base.mem * memShape(seed, t)]);
    case 'cpu_requests':
      return base.cpuReq ? live.map((t) => [t, base.cpuReq]) : [];
    case 'cpu_limits':
      return base.cpuLim ? live.map((t) => [t, base.cpuLim]) : [];
    case 'memory_requests':
      return base.memReq ? live.map((t) => [t, base.memReq]) : [];
    case 'memory_limits':
      return base.memLim ? live.map((t) => [t, base.memLim]) : [];
    case 'network_rx':
    case 'network_tx': {
      const factor = metric === 'network_rx' ? 2600 : 1500;
      return live.map((t) => [t, base.cpu * factor * cpuShape(`${seed}#net`, t, jitter)]);
    }
    case 'fs_usage': {
      if (nodes) {
        const fill = 0.35 + unit(seed, 3) * 0.3;
        return live.map((t) => [
          t,
          nodes * NODE_DISK * (fill + ((t % (3 * DAY)) / (3 * DAY)) * 0.06),
        ]);
      }
      const size = pods.length * (24 + unit(seed, 5) * 180) * MiB;
      return size ? live.map((t) => [t, size * memShape(`${seed}#fs`, t)]) : [];
    }
    case 'fs_capacity':
      return nodes ? live.map((t) => [t, nodes * NODE_DISK]) : [];
    case 'volume_usage':
    case 'volume_capacity': {
      const claims = pods.flatMap((p) =>
        asArray(asObject(p.spec).volumes)
          .filter(isObject)
          .map((v) => String(asObject(v.persistentVolumeClaim).claimName ?? ''))
          .filter(Boolean)
          .map((claim) => pvcOf(db, p.metadata.namespace ?? '', claim)),
      );
      const all =
        target.kind === 'namespace'
          ? list(db, 'persistentvolumeclaims').filter(
              (c) => c.metadata.namespace === target.namespace,
            )
          : claims;
      const capacity = all.reduce((s, c) => s + pvcCapacity(c), 0);
      if (!capacity) return [];
      if (metric === 'volume_capacity') return live.map((t) => [t, capacity]);
      const fill = 0.35 + unit(seed, 9) * 0.35;
      return live.map((t) => [t, capacity * (fill + ((t % (7 * DAY)) / (7 * DAY)) * 0.1)]);
    }
    case 'restarts':
      return live.map((t) => {
        const expected = (base.restartsPerHour * windowSecs) / 3600;
        const spike =
          base.restartsPerHour > 0 && unit(`${seed}^`, Math.floor(t / (20 * MIN))) > 0.97 ? 1 : 0;
        return [t, Math.round((expected + spike) * 10) / 10];
      });
  }
}

/** The PromQL the backend would send (simplified; shown and runnable in the PromQL tab). */
export function presetQuery(
  target: PrometheusTarget,
  metric: PrometheusMetric,
  windowSecs: number,
) {
  const w = `[${windowSecs}s]`;
  const sel = (() => {
    switch (target.kind) {
      case 'cluster':
        return '';
      case 'node':
        return `node="${target.name}"`;
      case 'namespace':
        return `namespace="${target.namespace}"`;
      case 'workload':
        return `namespace="${target.namespace}",pod=~"${workloadPodPattern(target.workload_kind, target.name).source.slice(1, -1).replace(/\\/g, '\\\\')}"`;
      case 'pod':
        return `namespace="${target.namespace}",pod="${target.name}"`;
      case 'container':
        return `namespace="${target.namespace}",pod="${target.pod}",container="${target.container}"`;
      case 'pvc':
        return `namespace="${target.namespace}",persistentvolumeclaim="${target.name}"`;
    }
  })();
  const c = ['container!=""', 'container!="POD"', sel].filter(Boolean).join(',');
  const s = sel ? `{${sel}}` : '';
  const node = target.kind === 'node' ? target.name : null;
  const onNode = node
    ? ` * on(instance, job) group_left(nodename) node_uname_info{nodename="${node}"}`
    : '';
  switch (metric) {
    case 'cpu_usage':
      return node || target.kind === 'cluster'
        ? `sum(rate(node_cpu_seconds_total{mode!~"idle|iowait|steal"}${w})${onNode}) * 1000`
        : `sum(rate(container_cpu_usage_seconds_total{${c}}${w})) * 1000`;
    case 'memory_usage':
      return node || target.kind === 'cluster'
        ? `sum((node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes)${onNode})`
        : `sum(container_memory_working_set_bytes{${c}})`;
    case 'cpu_requests':
    case 'cpu_limits':
    case 'memory_requests':
    case 'memory_limits': {
      const [resource, kind] = metric.split('_') as [string, string];
      const labels = [`resource="${resource}"`, sel].filter(Boolean).join(',');
      return `sum(kube_pod_container_resource_${kind}{${labels}})${resource === 'cpu' ? ' * 1000' : ''}`;
    }
    case 'network_rx':
    case 'network_tx': {
      const dir = metric === 'network_rx' ? 'receive' : 'transmit';
      return node || target.kind === 'cluster'
        ? `sum(rate(node_network_${dir}_bytes_total{device!~"lo|veth.*|cali.*"}${w})${onNode})`
        : `sum(rate(container_network_${dir}_bytes_total${s}${w}))`;
    }
    case 'fs_usage':
      return node || target.kind === 'cluster'
        ? `sum(node_filesystem_size_bytes{fstype=~"ext[234]|xfs"} - node_filesystem_avail_bytes{fstype=~"ext[234]|xfs"})`
        : `sum(container_fs_usage_bytes{${c}})`;
    case 'fs_capacity':
      return `sum(node_filesystem_size_bytes{fstype=~"ext[234]|xfs"})`;
    case 'volume_usage':
    case 'volume_capacity':
      return `sum(kubelet_volume_stats_${metric === 'volume_usage' ? 'used' : 'capacity'}_bytes${s})`;
    case 'restarts':
      return `sum(increase(kube_pod_container_status_restarts_total${node ? '' : s}${w}))`;
  }
}

export const ALL_METRICS: PrometheusMetric[] = [
  'cpu_usage',
  'cpu_requests',
  'cpu_limits',
  'memory_usage',
  'memory_requests',
  'memory_limits',
  'network_rx',
  'network_tx',
  'fs_usage',
  'fs_capacity',
  'volume_usage',
  'volume_capacity',
  'restarts',
];

// -- PromQL look-alike ------------------------------------------------------------------

/** Prometheus-style parse errors for unbalanced input. */
export function promqlSyntaxError(query: string): string | null {
  const stack: string[] = [];
  let quote: string | null = null;
  const pairs: Record<string, string> = { ')': '(', '}': '{', ']': '[' };
  for (let i = 0; i < query.length; i++) {
    const ch = query[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if ('({['.includes(ch)) stack.push(ch);
    else if (ch in pairs) {
      if (stack.pop() !== pairs[ch])
        return `bad_data: 1:${i + 1}: parse error: unexpected right ${ch === ')' ? 'parenthesis' : 'bracket'} '${ch}'`;
    }
  }
  if (quote) return `bad_data: 1:${query.length}: parse error: unterminated quoted string`;
  if (stack.length)
    return `bad_data: 1:${query.length + 1}: parse error: unclosed left ${stack.at(-1) === '(' ? 'parenthesis' : 'brace'}`;
  return null;
}

type Family =
  | 'cpu'
  | 'mem'
  | 'rx'
  | 'tx'
  | 'fs'
  | 'restarts'
  | 'requests'
  | 'limits'
  | 'info'
  | 'up'
  | 'node-cpu'
  | 'node-mem'
  | 'node-fs'
  | 'node-net'
  | 'volume';

const FAMILIES: Array<[RegExp, Family]> = [
  [/container_cpu_usage_seconds_total/, 'cpu'],
  [/container_memory_working_set_bytes|container_memory_usage_bytes/, 'mem'],
  [/container_network_receive_bytes_total/, 'rx'],
  [/container_network_transmit_bytes_total/, 'tx'],
  [/container_fs_usage_bytes/, 'fs'],
  [/kube_pod_container_status_restarts_total/, 'restarts'],
  [/kube_pod_container_resource_requests/, 'requests'],
  [/kube_pod_container_resource_limits/, 'limits'],
  [/kube_pod_info|kube_pod_status_phase|kube_pod_status_ready/, 'info'],
  [/node_cpu_seconds_total/, 'node-cpu'],
  [/node_memory_\w+/, 'node-mem'],
  [/node_filesystem_\w+/, 'node-fs'],
  [/node_network_\w+/, 'node-net'],
  [/kubelet_volume_stats_\w+/, 'volume'],
  [/\bup\b/, 'up'],
];

function matcher(query: string, label: string): ((v: string | undefined) => boolean) | null {
  const m = new RegExp(`\\b${label}\\s*(=~|!=|!~|=)\\s*"([^"]*)"`).exec(query);
  if (!m) return null;
  const [, op, raw] = m;
  const value = raw!.replace(/\\\\/g, '\\');
  if (op === '=') return (v) => v === value;
  if (op === '!=') return (v) => v !== value;
  const re = new RegExp(`^(?:${value})$`);
  return op === '=~' ? (v) => re.test(v ?? '') : (v) => !re.test(v ?? '');
}

interface Item {
  labels: Record<string, string>;
  value: (t: number) => number;
}

function podItems(db: ClusterDb, family: Family, query: string): Item[] {
  const pods = list(db, 'pods').filter(active);
  const resource = /resource\s*=\s*"memory"/.test(query) ? 'memory' : 'cpu';
  return pods.map((pod) => {
    const b = podBase(pod);
    const labels: Record<string, string> = {
      namespace: pod.metadata.namespace ?? '',
      pod: pod.metadata.name,
      node: String(asObject(pod.spec).nodeName ?? ''),
    };
    const seed = b.seed;
    const value = (t: number): number => {
      switch (family) {
        case 'cpu':
          return (b.cpu / 1000) * cpuShape(seed, t, 1);
        case 'mem':
          return b.mem * memShape(seed, t);
        case 'rx':
          return b.cpu * 2600 * cpuShape(`${seed}#net`, t, 1);
        case 'tx':
          return b.cpu * 1500 * cpuShape(`${seed}#net`, t, 1);
        case 'fs':
          return (24 + unit(seed, 5) * 180) * MiB;
        case 'restarts':
          return /increase|rate|delta/.test(query)
            ? b.restartsPerHour * (unit(`${seed}^`, Math.floor(t / (20 * MIN))) + 0.2)
            : Math.floor(b.restartsPerHour * ((t % (7 * DAY)) / HOUR));
        case 'requests':
          return resource === 'memory' ? b.memReq : b.cpuReq / 1000;
        case 'limits':
          return resource === 'memory' ? b.memLim : b.cpuLim / 1000;
        default:
          return 1;
      }
    };
    return {
      labels: family === 'requests' || family === 'limits' ? { ...labels, resource } : labels,
      value,
    };
  });
}

function nodeItems(db: ClusterDb, family: Family): Item[] {
  return list(db, 'nodes').map((node, i) => {
    const name = node.metadata.name;
    const seed = `${db.id}/${name}`;
    const pods = list(db, 'pods').filter((p) => asObject(p.spec).nodeName === name && active(p));
    const b = sumBases(
      seed,
      pods.map((p) => podBase(p)),
      NODE_OVERHEAD,
    );
    const labels = { instance: `10.0.${i}.${10 + i}:9100`, job: 'node-exporter', nodename: name };
    const value = (t: number): number => {
      switch (family) {
        case 'node-cpu':
          return (b.cpu / 1000) * cpuShape(seed, t, 0.6);
        case 'node-mem':
          return b.mem * memShape(seed, t);
        case 'node-fs':
          return NODE_DISK * (0.35 + unit(seed, 3) * 0.3);
        default:
          return b.cpu * 2600 * cpuShape(`${seed}#net`, t, 0.6);
      }
    };
    return { labels, value };
  });
}

function upItems(db: ClusterDb): Item[] {
  const jobs = [
    'apiserver',
    'kubelet',
    'node-exporter',
    'kube-state-metrics',
    'coredns',
    'prometheus',
  ];
  return jobs.flatMap((job, j) =>
    (job === 'kubelet' || job === 'node-exporter' ? list(db, 'nodes') : [null]).map((node, i) => ({
      labels: {
        __name__: 'up',
        job,
        instance: node
          ? `${node.metadata.name}:${job === 'kubelet' ? 10250 : 9100}`
          : `10.96.${j}.${i + 10}:443`,
      },
      value: (t: number) =>
        db.profile.notReady !== null &&
        node &&
        i === db.profile.notReady &&
        t > Date.now() - 2 * HOUR
          ? 0
          : 1,
    })),
  );
}

function volumeItems(db: ClusterDb, query: string): Item[] {
  const capacity = /capacity/.test(query);
  return list(db, 'persistentvolumeclaims').map((pvc) => {
    const seed = `${pvc.metadata.namespace}/${pvc.metadata.name}`;
    const size = pvcCapacity(pvc);
    return {
      labels: {
        namespace: pvc.metadata.namespace ?? '',
        persistentvolumeclaim: pvc.metadata.name,
      },
      value: () => (capacity ? size : size * (0.3 + unit(seed, 7) * 0.45)),
    };
  });
}

const GROUP_LABELS = [
  'namespace',
  'pod',
  'node',
  'container',
  'job',
  'instance',
  'nodename',
  'persistentvolumeclaim',
  'resource',
];

/** Evaluate `query` loosely over the fixtures: enough to make the PromQL tab feel real. */
export function evaluatePromql(db: ClusterDb, query: string, times: number[]): PromQuerySeries[] {
  const family = FAMILIES.find(([re]) => re.test(query))?.[1];
  if (!family) {
    // Plain numbers and vector(n): a constant.
    const n = Number(/^\s*(?:vector\s*\(\s*)?(-?[\d.]+(?:e[+-]?\d+)?)\s*\)?\s*$/i.exec(query)?.[1]);
    return Number.isFinite(n) ? [{ labels: {}, points: times.map((t) => [t, n]) }] : [];
  }
  let items =
    family === 'up'
      ? upItems(db)
      : family === 'volume'
        ? volumeItems(db, query)
        : family.startsWith('node-')
          ? nodeItems(db, family)
          : podItems(db, family, query);
  for (const label of GROUP_LABELS) {
    const test = matcher(query, label);
    if (test) items = items.filter((it) => test(it.labels[label]));
  }
  // `sum by (a, b)` / `sum(...) by (a)` / `topk(k, …)` / bare `sum(`.
  const by = /\bby\s*\(([^)]*)\)/.exec(query)?.[1];
  const aggregated = /\b(sum|avg|max|min|count)\s*(by\s*\([^)]*\)\s*)?\(/.test(query);
  let groups: Item[];
  if (by !== undefined || aggregated) {
    const keys = (by ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    const map = new Map<string, Item[]>();
    for (const it of items) {
      const labels = Object.fromEntries(keys.map((k) => [k, it.labels[k] ?? '']));
      const id = JSON.stringify(labels);
      map.set(id, [...(map.get(id) ?? []), it]);
    }
    const avg = /\bavg\b/.test(query);
    groups = [...map.entries()].map(([id, members]) => ({
      labels: JSON.parse(id) as Record<string, string>,
      value: (t: number) => {
        const total = members.reduce((s, m) => s + m.value(t), 0);
        return avg ? total / members.length : total;
      },
    }));
  } else {
    const named = !/\b(rate|irate|increase|delta|deriv)\s*\(/.test(query);
    groups = items.map((it) => ({
      ...it,
      labels: named ? { __name__: /[a-z_:]+/i.exec(query)?.[0] ?? '', ...it.labels } : it.labels,
    }));
  }
  const scale = Number(/\*\s*([\d.]+)\s*$/.exec(query)?.[1] ?? 1) || 1;
  let series: PromQuerySeries[] = groups
    .map((g) => ({
      labels: g.labels,
      points: times.map((t): PromPoint => [t, g.value(t) * scale]),
    }))
    .sort((a, b) => JSON.stringify(a.labels).localeCompare(JSON.stringify(b.labels)));
  const topk = /\btopk\s*\(\s*(\d+)/.exec(query);
  if (topk) {
    const last = (s: PromQuerySeries) => s.points.at(-1)?.[1] ?? 0;
    series = [...series].sort((a, b) => last(b) - last(a)).slice(0, Number(topk[1]));
  }
  return series;
}
