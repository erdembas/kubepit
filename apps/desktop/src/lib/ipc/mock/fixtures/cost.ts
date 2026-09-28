import { asArray, asObject, isObject } from '@/lib/kube/accessors';
import { cpuMillicores, memoryBytes } from '@/lib/kube/quantity';
import type {
  ContainerRecommendation,
  CostAggregate,
  CostItem,
  CostPlatform,
  CostPricing,
  CostTotals,
  CostTrendPoint,
  KubeObject,
  RecommendationWarning,
  ResourceChange,
  ResourceValues,
  RightsizingConfidence,
  RightsizingSettings,
  RightsizingSource,
  RightsizingStrategyInfo,
  RightsizingVerdict,
  UsageStats,
  WorkloadRecommendation,
} from '@/types';
import { buildDeployment } from './builders';
import { list, type ClusterDb } from './db';
import { buildService } from './network';
import { tpl } from './template';
import { DAY, hashString } from './util';

/**
 * Demo cost data: OpenCost on prod-eu-west-1 (its allocation numbers are
 * derived from the fixture objects with usage, network and idle), request
 * estimates everywhere else, and usage histories that make some workloads
 * over- and others under-provisioned. Mirrors the backend's math closely
 * enough for every screen; everything is a deterministic function of the
 * objects, so numbers are stable across reloads.
 */

const HOURS = 730;
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
export const IDLE = '__idle__';
export const UNALLOCATED = '__unallocated__';

/** OpenCost runs next to kube-prometheus-stack on the EU production cluster. */
export function buildCostServices(db: ClusterDb) {
  if (db.id !== 'c-prod-eu') return;
  buildDeployment(db, {
    namespace: 'monitoring',
    name: 'opencost',
    age: 60 * DAY,
    template: tpl('opencost', [
      {
        name: 'opencost',
        image: 'ghcr.io/opencost/opencost:1.113.0',
        ports: [{ name: 'http', port: 9003 }],
        cpu: ['10m', '1'],
        mem: ['64Mi', '1Gi'],
        probe: 'http',
        probePath: '/healthz',
      },
      {
        name: 'opencost-ui',
        image: 'ghcr.io/opencost/opencost-ui:1.113.0',
        ports: [{ name: 'http-ui', port: 9090 }],
        cpu: ['10m', '100m'],
        mem: ['32Mi', '128Mi'],
      },
    ]),
  });
  buildService(db, {
    namespace: 'monitoring',
    name: 'opencost',
    selector: { app: 'opencost' },
    labels: { 'app.kubernetes.io/name': 'opencost' },
    ports: [
      { name: 'http', port: 9003 },
      { name: 'http-ui', port: 9090 },
    ],
    age: 60 * DAY,
  });
}

// -- Prices -------------------------------------------------------------------

const PRICES: Record<CostPlatform, [number, number, number, number]> = {
  eks: [0.0316, 0.0042, 0.95, 0.08],
  gke: [0.0316, 0.0042, 0.95, 0.1],
  aks: [0.031, 0.0041, 0.9, 0.1],
  generic: [0.024, 0.003, 0.6, 0.05],
};

export function platformOf(label: string | null | undefined): CostPlatform {
  const l = (label ?? '').toLowerCase();
  return l === 'eks' || l === 'gke' || l === 'aks' ? l : 'generic';
}

export function defaultPricing(platform: CostPlatform): CostPricing {
  const [cpu, mem, gpu, storage] = PRICES[platform];
  return {
    currency: 'USD',
    cpu_hour: cpu,
    memory_gib_hour: mem,
    gpu_hour: gpu,
    storage_gib_month: storage,
    discount_percent: 0,
  };
}

const factor = (p: CostPricing) => Math.min(1, Math.max(0, 1 - p.discount_percent / 100));
export const cpuMonthly = (p: CostPricing, cores: number) =>
  Math.max(0, cores) * p.cpu_hour * HOURS * factor(p);
export const memMonthly = (p: CostPricing, bytes: number) =>
  (Math.max(0, bytes) / GiB) * p.memory_gib_hour * HOURS * factor(p);
const gpuMonthly = (p: CostPricing, gpus: number) =>
  Math.max(0, gpus) * (p.gpu_hour ?? 0) * HOURS * factor(p);
const storageMonthly = (p: CostPricing, bytes: number) =>
  (Math.max(0, bytes) / GiB) * (p.storage_gib_month ?? 0) * factor(p);

// -- Objects ------------------------------------------------------------------

const unit = (seed: string) => hashString(seed) / 4294967296;

function containers(spec: unknown) {
  return asArray(asObject(spec).containers).filter(isObject);
}

function resourcesOf(c: Record<string, unknown>): ResourceValues {
  const res = asObject(c.resources);
  const req = asObject(res.requests);
  const lim = asObject(res.limits);
  const opt = (n: number) => (n > 0 ? n : null);
  return {
    cpu_request: req.cpu != null ? opt(cpuMillicores(req.cpu)) : null,
    cpu_limit: lim.cpu != null ? opt(cpuMillicores(lim.cpu)) : null,
    memory_request: req.memory != null ? opt(memoryBytes(req.memory)) : null,
    memory_limit: lim.memory != null ? opt(memoryBytes(lim.memory)) : null,
  };
}

function podRequests(pod: KubeObject) {
  let cpu = 0;
  let mem = 0;
  let gpu = 0;
  for (const c of containers(pod.spec)) {
    const r = resourcesOf(c);
    cpu += (r.cpu_request ?? 0) / 1000;
    mem += r.memory_request ?? 0;
    const lim = asObject(asObject(c.resources).limits);
    gpu += Number(lim['nvidia.com/gpu'] ?? 0) || 0;
  }
  return { cpu, mem, gpu };
}

function active(pod: KubeObject) {
  const phase = asObject(pod.status).phase;
  return (phase === 'Running' || phase === 'Pending') && !pod.metadata.deletionTimestamp;
}

/** `[kind, name]` of the workload owning a pod (like the backend). */
export function workloadOf(pod: KubeObject): [string, string] | null {
  const owner = pod.metadata.ownerReferences?.find((r) => r.controller);
  if (!owner) return null;
  if (owner.kind === 'ReplicaSet') {
    const hash = pod.metadata.labels?.['pod-template-hash'];
    if (hash && owner.name.endsWith(`-${hash}`))
      return ['Deployment', owner.name.slice(0, -hash.length - 1)];
    return ['ReplicaSet', owner.name];
  }
  if (owner.kind === 'Job') {
    const m = /^(.+)-(\d{8,})$/.exec(owner.name);
    return m ? ['CronJob', m[1]!] : ['Job', owner.name];
  }
  return [owner.kind, owner.name];
}

function groupOf(
  pod: KubeObject,
  aggregate: CostAggregate,
  label: string | null,
): Pick<CostItem, 'key' | 'name' | 'namespace' | 'kind' | 'special'> {
  const ns = pod.metadata.namespace ?? '';
  if (aggregate === 'namespace')
    return { key: ns, name: ns, namespace: ns, kind: null, special: null };
  if (aggregate === 'workload') {
    const w = workloadOf(pod);
    return w
      ? { key: `${ns}/${w[0]}/${w[1]}`, name: w[1], namespace: ns, kind: w[0], special: null }
      : {
          key: `${ns}/${UNALLOCATED}`,
          name: UNALLOCATED,
          namespace: ns,
          kind: null,
          special: 'unallocated',
        };
  }
  const value = label ? pod.metadata.labels?.[label] : undefined;
  return value
    ? { key: value, name: value, namespace: null, kind: null, special: null }
    : { key: UNALLOCATED, name: UNALLOCATED, namespace: null, kind: null, special: 'unallocated' };
}

function blank(group: Pick<CostItem, 'key' | 'name' | 'namespace' | 'kind' | 'special'>): CostItem {
  return {
    ...group,
    pods: 0,
    cpu_request_cores: 0,
    cpu_usage_cores: null,
    memory_request_bytes: 0,
    memory_usage_bytes: null,
    gpus: 0,
    storage_bytes: 0,
    cpu_cost: 0,
    memory_cost: 0,
    gpu_cost: 0,
    storage_cost: 0,
    other_cost: 0,
    total_cost: 0,
    efficiency: null,
    special: group.special,
  };
}

export type UsageMap = Map<string, { cpu: number; mem: number }>;

export interface CostComputation {
  totals: CostTotals;
  items: CostItem[];
}

/**
 * Requests × prices (usage when higher and known), node capacity for idle,
 * claims per GiB-month. `withOther` adds OpenCost-style network / load
 * balancer costs.
 */
export function computeCosts(
  db: ClusterDb,
  pricing: CostPricing,
  aggregate: CostAggregate,
  label: string | null,
  usage: UsageMap | null,
  withOther = false,
): CostComputation {
  const rows = new Map<string, CostItem>();
  const claimOwner = new Map<string, string>();
  let allocatedCompute = 0;
  for (const pod of list(db, 'pods').filter(active)) {
    const ns = pod.metadata.namespace ?? '';
    const req = podRequests(pod);
    const u = usage?.get(`${ns}/${pod.metadata.name}`);
    const cpuCost = cpuMonthly(pricing, u ? Math.max(u.cpu, req.cpu) : req.cpu);
    const memCost = memMonthly(pricing, u ? Math.max(u.mem, req.mem) : req.mem);
    const gpuCost = gpuMonthly(pricing, req.gpu);
    allocatedCompute += cpuCost + memCost + gpuCost;
    const group = groupOf(pod, aggregate, label);
    for (const v of asArray(asObject(pod.spec).volumes).filter(isObject)) {
      const claim = asObject(v.persistentVolumeClaim).claimName;
      if (typeof claim === 'string' && !claimOwner.has(`${ns}/${claim}`))
        claimOwner.set(`${ns}/${claim}`, group.key);
    }
    let row = rows.get(group.key);
    if (!row) {
      row = blank(group);
      if (usage) {
        row.cpu_usage_cores = 0;
        row.memory_usage_bytes = 0;
      }
      rows.set(group.key, row);
    }
    row.pods++;
    row.cpu_request_cores += req.cpu;
    row.memory_request_bytes += req.mem;
    row.gpus += req.gpu;
    if (usage) {
      row.cpu_usage_cores = (row.cpu_usage_cores ?? 0) + (u?.cpu ?? 0);
      row.memory_usage_bytes = (row.memory_usage_bytes ?? 0) + (u?.mem ?? 0);
    }
    row.cpu_cost += cpuCost;
    row.memory_cost += memCost;
    row.gpu_cost += gpuCost;
    row.total_cost += cpuCost + memCost + gpuCost;
  }
  for (const pvc of list(db, 'persistentvolumeclaims')) {
    const ns = pvc.metadata.namespace ?? '';
    const bytes =
      memoryBytes(asObject(asObject(pvc.status).capacity).storage) ||
      memoryBytes(asObject(asObject(asObject(pvc.spec).resources).requests).storage);
    if (!bytes) continue;
    const owner = claimOwner.get(`${ns}/${pvc.metadata.name}`);
    const key =
      owner ??
      (aggregate === 'namespace'
        ? ns
        : aggregate === 'workload'
          ? `${ns}/${UNALLOCATED}`
          : UNALLOCATED);
    let row = rows.get(key);
    if (!row) {
      const special = aggregate === 'namespace' ? null : ('unallocated' as const);
      row = blank({
        key,
        name: special ? UNALLOCATED : ns,
        namespace: aggregate === 'label' ? null : ns,
        kind: null,
        special,
      });
      rows.set(key, row);
    }
    const cost = storageMonthly(pricing, bytes);
    row.storage_bytes += bytes;
    row.storage_cost += cost;
    row.total_cost += cost;
  }
  const items = [...rows.values()];
  for (const item of items) {
    if (withOther && !item.special) {
      const share = 0.015 + unit(`net:${item.key}`) * 0.05;
      item.other_cost = (item.cpu_cost + item.memory_cost) * share;
      item.total_cost += item.other_cost;
    }
    if (item.cpu_usage_cores != null && item.memory_usage_bytes != null) {
      const requested =
        cpuMonthly(pricing, item.cpu_request_cores) +
        memMonthly(pricing, item.memory_request_bytes);
      item.efficiency =
        requested > 0
          ? (cpuMonthly(pricing, item.cpu_usage_cores) +
              memMonthly(pricing, item.memory_usage_bytes)) /
            requested
          : null;
    }
  }
  // Idle: node capacity nobody requested.
  let capacity = 0;
  let cpuCap = 0;
  let memCap = 0;
  for (const node of list(db, 'nodes')) {
    const cap = asObject(asObject(node.status).capacity);
    const c = cpuMonthly(pricing, cpuMillicores(cap.cpu) / 1000);
    const m = memMonthly(pricing, memoryBytes(cap.memory));
    const g = gpuMonthly(pricing, Number(cap['nvidia.com/gpu'] ?? 0) || 0);
    cpuCap += c;
    memCap += m;
    capacity += c + m + g;
  }
  const idle = Math.max(0, capacity - allocatedCompute);
  if (idle > 0) {
    const idleRow = blank({ key: IDLE, name: IDLE, namespace: null, kind: null, special: 'idle' });
    idleRow.cpu_cost = capacity ? (idle * cpuCap) / capacity : 0;
    idleRow.memory_cost = capacity ? (idle * memCap) / capacity : 0;
    idleRow.gpu_cost = Math.max(0, idle - idleRow.cpu_cost - idleRow.memory_cost);
    idleRow.total_cost = idle;
    items.push(idleRow);
  }
  items.sort((a, b) => b.total_cost - a.total_cost || a.key.localeCompare(b.key));
  return { totals: totalsOf(items, true), items };
}

export function totalsOf(items: CostItem[], idleKnown: boolean): CostTotals {
  const t: CostTotals = {
    total: 0,
    allocated: 0,
    idle: null,
    cpu: 0,
    memory: 0,
    gpu: 0,
    storage: 0,
    other: 0,
    efficiency: null,
    cpu_efficiency: null,
    memory_efficiency: null,
  };
  let idle = 0;
  let cpuReq = 0;
  let cpuUse = 0;
  let memReq = 0;
  let memUse = 0;
  let effW = 0;
  let effSum = 0;
  let usage = false;
  for (const i of items) {
    t.total += i.total_cost;
    t.cpu += i.cpu_cost;
    t.memory += i.memory_cost;
    t.gpu += i.gpu_cost;
    t.storage += i.storage_cost;
    t.other += i.other_cost;
    if (i.special === 'idle') {
      idle += i.total_cost;
      continue;
    }
    if (i.cpu_usage_cores != null && i.memory_usage_bytes != null) {
      usage = true;
      cpuReq += i.cpu_request_cores;
      memReq += i.memory_request_bytes;
      cpuUse += i.cpu_usage_cores;
      memUse += i.memory_usage_bytes;
    }
    if (i.efficiency != null) {
      const w = i.cpu_cost + i.memory_cost;
      effW += w;
      effSum += i.efficiency * w;
    }
  }
  t.allocated = t.total - idle;
  t.idle = idleKnown ? idle : null;
  t.efficiency = effW > 0 ? effSum / effW : null;
  t.cpu_efficiency = usage && cpuReq > 0 ? cpuUse / cpuReq : null;
  t.memory_efficiency = usage && memReq > 0 ? memUse / memReq : null;
  return t;
}

/** Daily costs over `days` ending today: weekday rhythm, slow drift, noise. */
export function dailyTrend(
  monthly: number,
  days: number,
  seed: string,
  now = Date.now(),
): CostTrendPoint[] {
  const today = Math.floor(now / DAY) * DAY;
  const base = monthly / (HOURS / 24);
  const out: CostTrendPoint[] = [];
  for (let d = days - 1; d >= 0; d--) {
    const ts = today - d * DAY;
    const weekday = new Date(ts).getUTCDay();
    const weekend = weekday === 0 || weekday === 6 ? 0.93 : 1;
    const drift = 1 - d * 0.004;
    const noise = 1 + (unit(`${seed}:${ts}`) - 0.5) * 0.06;
    out.push({ ts, total: base * weekend * drift * noise });
  }
  return out;
}

// -- Right-sizing -------------------------------------------------------------

export const DEFAULT_SETTINGS: RightsizingSettings = {
  cpu_headroom_percent: 15,
  memory_headroom_percent: 20,
  memory_limit_headroom_percent: 40,
  min_cpu_millicores: 10,
  min_memory_bytes: 32 * MiB,
  days: 7,
};

function roundUp(value: number, step: number) {
  return Math.max(0, Math.ceil(value / step - 1e-9)) * step;
}
function roundCpu(m: number) {
  const v = Math.max(0, m);
  return roundUp(v, v <= 100 ? 5 : v <= 1000 ? 10 : v <= 4000 ? 50 : 100);
}
function roundMem(b: number) {
  const v = Math.max(0, b);
  return roundUp(
    v,
    v <= 256 * MiB ? 8 * MiB : v <= GiB ? 16 * MiB : v <= 4 * GiB ? 64 * MiB : 256 * MiB,
  );
}
function significant(current: number, next: number, absolute: number) {
  const delta = Math.abs(next - current);
  return delta >= absolute && (current <= 0 || delta / current >= 0.1);
}
function settle(current: number | null, next: number, absolute: number, floor: number): number {
  return current != null && current >= floor && !significant(current, next, absolute)
    ? current
    : next;
}
function changeOf(current: number | null, next: number | null): ResourceChange {
  if (next == null) return 'unchanged';
  if (current == null) return 'set';
  if (Math.abs(next - current) < 1e-6) return 'unchanged';
  return next > current ? 'increase' : 'decrease';
}

function confidenceOf(source: RightsizingSource, hours: number): RightsizingConfidence {
  if (source === 'prometheus' && hours >= 72) return 'high';
  if (source === 'prometheus' && hours >= 12) return 'medium';
  return 'low';
}

interface StrategyOutput {
  recommended: ResourceValues;
  confidence: RightsizingConfidence;
  warnings: RecommendationWarning[];
}

const warn = (code: string): RecommendationWarning => ({ code, detail: null });

/** The backend's default strategy ("percentile-headroom"). */
function percentileHeadroom(
  current: ResourceValues,
  usage: UsageStats | null,
  source: RightsizingSource,
  s: RightsizingSettings,
): StrategyOutput {
  const none: ResourceValues = {
    cpu_request: null,
    cpu_limit: null,
    memory_request: null,
    memory_limit: null,
  };
  if (!usage) return { recommended: none, confidence: 'low', warnings: [warn('no-usage')] };
  const cpu = settle(
    current.cpu_request,
    Math.max(
      roundCpu(usage.cpu_p95 * (1 + s.cpu_headroom_percent / 100)),
      roundCpu(s.min_cpu_millicores),
      roundCpu(usage.cpu_p95),
    ),
    10,
    usage.cpu_p95,
  );
  const memory = settle(
    current.memory_request,
    Math.max(
      roundMem(usage.memory_max * (1 + s.memory_headroom_percent / 100)),
      roundMem(s.min_memory_bytes),
      roundMem(usage.memory_max),
    ),
    16 * MiB,
    usage.memory_max,
  );
  const limit = Math.max(
    roundMem(usage.memory_max * (1 + s.memory_limit_headroom_percent / 100)),
    memory,
    roundMem(usage.memory_max),
  );
  // Proposed when missing, raised when too tight, never lowered (like the backend).
  const memoryLimit =
    current.memory_limit == null
      ? limit
      : memory <= current.memory_limit
        ? Math.max(
            current.memory_limit,
            settle(current.memory_limit, limit, 16 * MiB, usage.memory_max),
          )
        : null;
  const confidence = confidenceOf(source, usage.hours);
  const warnings: RecommendationWarning[] = [];
  if (source === 'metrics-server') warnings.push(warn('metrics-server-only'));
  else if (source === 'prometheus' && confidence !== 'high') warnings.push(warn('short-history'));
  if (current.memory_limit != null && usage.memory_max >= 0.9 * current.memory_limit)
    warnings.push(warn('memory-near-limit'));
  if (current.memory_limit == null) warnings.push(warn('memory-limit-added'));
  if (usage.cpu_max > 2 * cpu && usage.cpu_max > cpu + 250) warnings.push(warn('cpu-bursts'));
  return {
    recommended: {
      cpu_request: cpu,
      cpu_limit: null,
      memory_request: memory,
      memory_limit: memoryLimit,
    },
    confidence,
    warnings,
  };
}

/** Like the backend's `finalize`: keep what the strategy left, raise limits proportionally. */
function finalize(
  name: string,
  current: ResourceValues,
  usage: UsageStats | null,
  out: StrategyOutput,
): ContainerRecommendation {
  const rec: ResourceValues = {
    cpu_request: out.recommended.cpu_request ?? current.cpu_request,
    cpu_limit: out.recommended.cpu_limit ?? current.cpu_limit,
    memory_request: out.recommended.memory_request ?? current.memory_request,
    memory_limit: out.recommended.memory_limit ?? current.memory_limit,
  };
  const raise = (
    curReq: number | null,
    curLim: number | null,
    req: number | null,
    lim: number | null,
    round: (v: number) => number,
  ): number | null => {
    if (req == null || lim == null || req <= lim) return null;
    const base = curReq ?? curLim;
    const ratio = base && curLim ? Math.max(1, curLim / base) : 1;
    return Math.max(req, round(req * ratio));
  };
  const cpuLimit = raise(
    current.cpu_request,
    current.cpu_limit,
    rec.cpu_request,
    rec.cpu_limit,
    roundCpu,
  );
  const memLimit = raise(
    current.memory_request,
    current.memory_limit,
    rec.memory_request,
    rec.memory_limit,
    roundMem,
  );
  if (cpuLimit != null) rec.cpu_limit = cpuLimit;
  if (memLimit != null) rec.memory_limit = memLimit;
  const warnings = [...out.warnings];
  if (cpuLimit != null) warnings.push(warn('cpu-limit-raised'));
  if (memLimit != null) warnings.push(warn('memory-limit-raised'));
  return {
    name,
    current,
    recommended: rec,
    usage,
    cpu: changeOf(current.cpu_request, rec.cpu_request),
    memory: changeOf(current.memory_request, rec.memory_request),
    memory_limit: changeOf(current.memory_limit, rec.memory_limit),
    cpu_limit: changeOf(current.cpu_limit, rec.cpu_limit),
    confidence: out.confidence,
    warnings,
    cpu_limit_raised: cpuLimit != null,
    memory_limit_raised: memLimit != null,
  };
}

export function recommendContainer(
  name: string,
  current: ResourceValues,
  usage: UsageStats | null,
  source: RightsizingSource,
  s: RightsizingSettings,
): ContainerRecommendation {
  return finalize(name, current, usage, percentileHeadroom(current, usage, source, s));
}

export const STRATEGIES: RightsizingStrategyInfo[] = [
  { id: 'percentile-headroom', name: 'Percentile + headroom' },
];

const changed = (c: ContainerRecommendation) =>
  [c.cpu, c.memory, c.memory_limit, c.cpu_limit].some((x) => x !== 'unchanged');

/**
 * Synthetic usage of one container: most templates are over-provisioned,
 * some run hot, the rest are about right.
 */
function syntheticUsage(seed: string, current: ResourceValues, hours: number): UsageStats | null {
  const r = unit(seed);
  const r2 = unit(`${seed}#`);
  const cpuReq = current.cpu_request;
  const memReq = current.memory_request;
  let cpu: number;
  let mem: number;
  if (r < 0.45) {
    cpu = (cpuReq ?? 120) * (0.12 + r2 * 0.3);
    mem = (memReq ?? 256 * MiB) * (0.28 + r2 * 0.3);
  } else if (r < 0.65) {
    cpu = (cpuReq ?? 80) * (1.25 + r2 * 0.6);
    mem = (memReq ?? 128 * MiB) * (1.08 + r2 * 0.3);
    if (current.memory_limit) mem = Math.min(mem, current.memory_limit * 0.96);
  } else {
    cpu = (cpuReq ?? 60) * (0.8 + r2 * 0.1);
    mem = (memReq ?? 192 * MiB) * (0.78 + r2 * 0.06);
  }
  if (!Number.isFinite(cpu) || !Number.isFinite(mem)) return null;
  return {
    cpu_p95: cpu,
    cpu_max: cpu * (1.3 + r2 * 0.8),
    memory_max: mem,
    hours,
    cpu_avg: null,
    memory_avg: null,
  };
}

function monthlyRequests(
  list: ContainerRecommendation[],
  replicas: number,
  pricing: CostPricing,
  recommended: boolean,
) {
  return (
    list.reduce((sum, c) => {
      const v = recommended ? c.recommended : c.current;
      return (
        sum +
        cpuMonthly(pricing, (v.cpu_request ?? 0) / 1000) +
        memMonthly(pricing, v.memory_request ?? 0)
      );
    }, 0) * replicas
  );
}

function verdictOf(
  list: ContainerRecommendation[],
  current: number,
  next: number,
): RightsizingVerdict {
  if (list.every((c) => !c.usage)) return 'no-data';
  const under = list.some((c) => {
    const u = c.usage;
    if (!u) return false;
    return (
      (c.current.memory_request != null && u.memory_max > c.current.memory_request) ||
      (c.current.memory_limit != null && u.memory_max >= 0.9 * c.current.memory_limit) ||
      (c.current.cpu_request != null && u.cpu_p95 > c.current.cpu_request * 1.1) ||
      c.current.cpu_request == null ||
      c.current.memory_request == null
    );
  });
  if (under) return 'under';
  if (current > 0 && next <= current * 0.9) return 'over';
  return 'balanced';
}

const RANK: Record<RightsizingConfidence, number> = { low: 0, medium: 1, high: 2 };

const WORKLOAD_KEYS: Array<[string, string]> = [
  ['Deployment', 'deployments.apps'],
  ['StatefulSet', 'statefulsets.apps'],
  ['DaemonSet', 'daemonsets.apps'],
];

export function workloadRecommendations(
  db: ClusterDb,
  source: RightsizingSource,
  settings: RightsizingSettings,
  pricing: CostPricing,
  filter: {
    namespaces: string[];
    workload: { kind: string; namespace: string; name: string } | null;
  },
  now = Date.now(),
): WorkloadRecommendation[] {
  const out: WorkloadRecommendation[] = [];
  for (const [kind, key] of WORKLOAD_KEYS) {
    for (const w of list(db, key)) {
      const ns = w.metadata.namespace ?? '';
      if (filter.workload) {
        if (
          filter.workload.kind !== kind ||
          filter.workload.namespace !== ns ||
          filter.workload.name !== w.metadata.name
        )
          continue;
      } else if (filter.namespaces.length && !filter.namespaces.includes(ns)) continue;
      const spec = asObject(w.spec);
      const replicas =
        kind === 'DaemonSet'
          ? Number(asObject(w.status).desiredNumberScheduled ?? 0)
          : Number(spec.replicas ?? 1);
      const age = (now - Date.parse(w.metadata.creationTimestamp ?? '')) / 3_600_000;
      const window = source === 'prometheus' ? settings.days * 24 : 1;
      const hours =
        source === 'none'
          ? 0
          : Math.max(0.25, Math.min(window, Number.isFinite(age) ? age : window));
      const recs = containers(asObject(spec.template).spec).map((c) => {
        const name = String(c.name ?? '');
        const current = resourcesOf(c);
        const usage =
          source === 'none'
            ? null
            : syntheticUsage(`${db.id}/${ns}/${w.metadata.name}/${name}`, current, hours);
        return recommendContainer(name, current, usage, source, settings);
      });
      const current = monthlyRequests(recs, replicas, pricing, false);
      const next = monthlyRequests(recs, replicas, pricing, true);
      const coverage = recs.reduce((m, c) => Math.max(m, c.usage?.hours ?? 0), 0);
      out.push({
        kind,
        namespace: ns,
        name: w.metadata.name,
        uid: w.metadata.uid,
        replicas,
        confidence:
          recs
            .filter((c) => c.usage)
            .reduce<RightsizingConfidence | null>(
              (worst, c) =>
                worst == null || RANK[c.confidence] < RANK[worst] ? c.confidence : worst,
              null,
            ) ?? 'low',
        verdict: verdictOf(recs, current, next),
        coverage_hours: coverage,
        containers: recs,
        monthly_delta: next - current,
        monthly_current: current,
        changed: recs.some(changed),
      });
    }
  }
  out.sort(
    (a, b) =>
      Number(b.changed) - Number(a.changed) ||
      a.monthly_delta - b.monthly_delta ||
      a.namespace.localeCompare(b.namespace) ||
      a.name.localeCompare(b.name),
  );
  return out;
}

// -- Patches --------------------------------------------------------------------

export function formatCpu(millicores: number): string {
  const m = Math.ceil(Math.max(0, millicores));
  return m > 0 && m % 1000 === 0 ? String(m / 1000) : `${m}m`;
}

export function formatMemory(bytes: number): string {
  const b = Math.max(0, bytes);
  if (b >= GiB && Number.isInteger(b / GiB)) return `${b / GiB}Gi`;
  if (b >= MiB) return `${Math.ceil(b / MiB)}Mi`;
  if (b >= 1024) return `${Math.ceil(b / 1024)}Ki`;
  return String(Math.ceil(b));
}
