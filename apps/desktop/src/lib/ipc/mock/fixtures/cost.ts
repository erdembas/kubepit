import { asArray, asObject, isObject } from '@/lib/kube/accessors';
import { cpuMillicores, memoryBytes } from '@/lib/kube/quantity';
import type {
  ContainerRecommendation,
  CostAggregate,
  HpaInfo,
  CostItem,
  CostPlatform,
  CostPricing,
  CostTotals,
  CostTrendPoint,
  KubeObject,
  RecommendationLens,
  RecommendationWarning,
  ResourceChange,
  ResourceValues,
  RightsizingConfidence,
  RightsizingSettings,
  RightsizingSource,
  RightsizingStrategyInfo,
  RightsizingVerdict,
  UsageEvidence,
  UsageStats,
  WorkloadRecommendation,
} from '@/types';
import { buildDeployment } from './builders';
import { list, ownedBy, type ClusterDb } from './db';
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

/**
 * The pod spec right-sizing reads and patches: `spec.template.spec`, or a
 * CronJob's `spec.jobTemplate.spec.template.spec` (like the backend's
 * `patch::template_path`). The live nested object, so it can be edited.
 */
export function podSpecOf(obj: KubeObject): Record<string, unknown> {
  const spec = asObject(obj.spec);
  const template =
    obj.kind === 'CronJob' ? asObject(asObject(spec.jobTemplate).spec).template : spec.template;
  return asObject(asObject(template).spec);
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
  min_hours: 24,
  min_coverage: 0.9,
  throttle_threshold_percent: 5,
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
    evidence: null,
  };
}

/** The backend's `workload-history` strategy (whole millicores / MiB, OOM floor, 72 h tiers). */
function workloadHistory(
  current: ResourceValues,
  usage: UsageStats | null,
  source: RightsizingSource,
  s: RightsizingSettings,
  evidence: UsageEvidence | null,
): StrategyOutput {
  if (!usage)
    return {
      recommended: { cpu_request: null, cpu_limit: null, memory_request: null, memory_limit: null },
      confidence: 'low',
      warnings: [warn('no-usage')],
    };
  const whole = (v: number) => Math.max(0, Math.ceil(v - 1e-9));
  const wholeMib = (b: number) => Math.max(0, Math.ceil(b / MiB - 1e-9)) * MiB;
  const oom = !!evidence?.oom_killed;
  const memoryBase =
    oom && current.memory_limit != null
      ? Math.max(usage.memory_max, current.memory_limit)
      : usage.memory_max;
  const cpu = settle(
    current.cpu_request,
    whole(Math.max(s.min_cpu_millicores, usage.cpu_p95 * (1 + s.cpu_headroom_percent / 100))),
    10,
    usage.cpu_p95,
  );
  const memory = settle(
    current.memory_request,
    wholeMib(Math.max(s.min_memory_bytes, memoryBase * (1 + s.memory_headroom_percent / 100))),
    16 * MiB,
    memoryBase,
  );
  const memoryLimit =
    current.memory_limit == null
      ? Math.max(memory, wholeMib(memoryBase * (1 + s.memory_limit_headroom_percent / 100)))
      : null;
  const confidence: RightsizingConfidence =
    source === 'prometheus' ? (usage.hours >= 72 ? 'high' : 'medium') : 'low';
  const warnings: RecommendationWarning[] = [];
  if (source !== 'prometheus') warnings.push(warn('metrics-server-only'));
  else if (confidence !== 'high') warnings.push(warn('short-history'));
  if (memoryLimit != null) warnings.push(warn('memory-limit-added'));
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

const CONFIDENCE_RANK: Record<RightsizingConfidence, number> = { low: 0, medium: 1, high: 2 };
const cap = (c: RightsizingConfidence, limit: RightsizingConfidence) =>
  CONFIDENCE_RANK[c] <= CONFIDENCE_RANK[limit] ? c : limit;

/** The backend's shared evidence step (`strategy::apply_evidence`): flags and caps, never values. */
function applyEvidence(
  out: StrategyOutput,
  current: ResourceValues,
  e: UsageEvidence | null,
  hpa: HpaInfo | null,
  s: RightsizingSettings,
): StrategyOutput {
  let confidence = out.confidence;
  const warnings = [...out.warnings];
  const flag = (code: string, limit: RightsizingConfidence, detail: string | null = null) => {
    warnings.push({ code, detail });
    confidence = cap(confidence, limit);
  };
  if (e) {
    if (e.identity === 'ambiguous') flag('identity-unclear', 'low');
    if (e.observed_hours < s.min_hours)
      flag('insufficient-history', 'low', String(Math.floor(Math.max(0, e.observed_hours))));
    const low = [e.cpu_coverage, e.memory_coverage].filter(
      (c): c is number => c != null && c < s.min_coverage,
    );
    if (low.length)
      flag('low-coverage', 'low', `${Math.floor(Math.max(0, Math.min(...low)) * 100)}%`);
    if (e.partial) flag('partial-data', 'medium');
  }
  if (hpa) {
    flag('hpa-target', 'medium', hpa.name);
    const targets = hpa.metrics.flatMap((m) => {
      if (m.target_utilization == null || m.resource === 'other') return [];
      const [before, after] =
        m.resource === 'cpu'
          ? [current.cpu_request, out.recommended.cpu_request]
          : [current.memory_request, out.recommended.memory_request];
      return changeOf(before, after) !== 'unchanged'
        ? [`${m.resource} ${m.target_utilization}%`]
        : [];
    });
    if (targets.length) flag('hpa-utilization', 'medium', targets.join(', '));
  }
  if (e) {
    if (e.oom_killed) flag('oom-killed', 'medium');
    if (e.throttle_ratio != null && e.throttle_ratio >= s.throttle_threshold_percent / 100)
      flag('cpu-throttled', 'medium', `${(e.throttle_ratio * 100).toFixed(1)}%`);
    if (e.identity === 'name-match') flag('identity-by-name', 'medium');
  }
  return { recommended: out.recommended, confidence, warnings };
}

/** What `recommendContainer` needs besides the usage (defaults: percentile-headroom, no evidence). */
export interface ContainerContext {
  strategy?: string;
  evidence?: UsageEvidence | null;
  hpa?: HpaInfo | null;
}

export function recommendContainer(
  name: string,
  current: ResourceValues,
  usage: UsageStats | null,
  source: RightsizingSource,
  s: RightsizingSettings,
  ctx: ContainerContext = {},
): ContainerRecommendation {
  const evidence = ctx.evidence ?? null;
  const out =
    ctx.strategy === 'workload-history'
      ? workloadHistory(current, usage, source, s, evidence)
      : percentileHeadroom(current, usage, source, s);
  const rec = finalize(
    name,
    current,
    usage,
    applyEvidence(out, current, evidence, ctx.hpa ?? null, s),
  );
  return { ...rec, evidence };
}

/** Settings every backend strategy reads (the last three feed the shared evidence step). */
const SETTINGS_KEYS = [
  'cpu_headroom_percent',
  'memory_headroom_percent',
  'memory_limit_headroom_percent',
  'days',
  'min_hours',
  'min_coverage',
  'throttle_threshold_percent',
];

/**
 * The backend's strategies: `percentile-headroom` (the default, its
 * percentile math) and `workload-history` (whole-unit rounding, the OOM
 * floor, 72-hour confidence tiers).
 */
export const STRATEGIES: RightsizingStrategyInfo[] = [
  {
    id: 'percentile-headroom',
    name: 'Percentile + headroom',
    defaults: DEFAULT_SETTINGS,
    settings_keys: SETTINGS_KEYS,
  },
  {
    id: 'workload-history',
    name: 'Workload history',
    defaults: { ...DEFAULT_SETTINGS, cpu_headroom_percent: 20, memory_headroom_percent: 20 },
    settings_keys: SETTINGS_KEYS,
  },
];

/** Like the backend's `strategy::resolve`: a named strategy as it is, else automatic. */
export function resolveStrategy(
  requested: string | null | undefined,
  ownerMetrics: boolean,
): { id: string; auto: boolean } {
  const id = requested?.trim();
  if (id) return { id, auto: false };
  return { id: ownerMetrics ? 'workload-history' : 'percentile-headroom', auto: true };
}

const changed = (c: ContainerRecommendation) =>
  [c.cpu, c.memory, c.memory_limit, c.cpu_limit].some((x) => x !== 'unchanged');

/**
 * Usage drifting slowly over the days (±12 %, per workload), so stored
 * scans of different times recommend a little differently.
 */
export function driftFactor(seed: string, at: number): number {
  const phase = unit(`${seed}#phase`) * 2 * Math.PI;
  const slow = Math.sin((at / (5 * DAY)) * 2 * Math.PI + phase) * 0.1;
  const daily = (unit(`${seed}#${Math.floor(at / DAY)}`) - 0.5) * 0.04;
  return 1 + slow + daily;
}

/**
 * Synthetic usage of one container: most templates are over-provisioned,
 * some run hot, the rest are about right.
 */
function syntheticUsage(
  seed: string,
  current: ResourceValues,
  hours: number,
  factor = 1,
): UsageStats | null {
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
  cpu *= factor;
  mem *= factor;
  if (current.memory_limit) mem = Math.min(mem, current.memory_limit * 0.99);
  if (!Number.isFinite(cpu) || !Number.isFinite(mem)) return null;
  return {
    cpu_p95: cpu,
    cpu_max: cpu * (1.3 + r2 * 0.8),
    memory_max: mem,
    hours,
    cpu_avg: cpu * (0.55 + r2 * 0.2),
    memory_avg: mem * (0.8 + r2 * 0.1),
  };
}

/** Like the backend's `math::cost_replicas`: a CronJob costs its largest duty cycle, else 1. */
function costReplicas(kind: string, replicas: number, list: ContainerRecommendation[]): number {
  if (kind !== 'CronJob') return replicas;
  const duties = list.flatMap((c) => (c.evidence?.duty != null ? [c.evidence.duty] : []));
  return duties.length ? Math.max(...duties) : 1;
}

/**
 * A CronJob's duty cycle: the demo's jobs run 15–45 % of the time (average
 * running pods), so a week of observed hours stays above `min_hours`.
 */
function cronDuty(seed: string): number {
  return Math.round((0.15 + unit(`${seed}#duty`) * 0.3) * 100) / 100;
}

/**
 * The folded evidence of one container: mostly clean, with a few gaps,
 * throttled and OOM-killed containers (deterministic per container).
 */
function demoEvidence(
  seed: string,
  hours: number,
  pods: number,
  duty: number | null,
  identity: UsageEvidence['identity'],
  partial: boolean,
): UsageEvidence {
  const gap = unit(`${seed}#gap`) < 0.05;
  const coverage = gap
    ? 0.55 + unit(`${seed}#cov`) * 0.3
    : Math.min(1, 0.95 + unit(`${seed}#cov`) * 0.06);
  const samples = Math.round(hours * 12 * coverage);
  const t = unit(`${seed}#thr`);
  return {
    observed_hours: hours,
    cpu_coverage: Math.round(coverage * 1000) / 1000,
    memory_coverage: Math.min(1, Math.round((coverage + 0.02) * 1000) / 1000),
    cpu_samples: samples,
    memory_samples: samples,
    pods,
    duty,
    throttle_ratio:
      t < 0.07
        ? Math.round((0.06 + unit(`${seed}#thr2`) * 0.12) * 1000) / 1000
        : t < 0.5
          ? Math.round(unit(`${seed}#thr2`) * 0.02 * 1000) / 1000
          : null,
    oom_killed: unit(`${seed}#oom`) < 0.035,
    partial,
    identity,
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
  // Like the backend: an OOM kill in the window makes it under-provisioned.
  if (list.some((c) => c.warnings.some((w) => w.code === 'oom-killed'))) return 'under';
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

/** The backend's `summary::lenses_of`, in declaration order. */
export function lensesOf(rec: WorkloadRecommendation): RecommendationLens[] {
  const any = (f: (c: ContainerRecommendation) => boolean) => rec.containers.some(f);
  const up = (c: ResourceChange) => c === 'increase' || c === 'set';
  const rules: Array<[RecommendationLens, boolean]> = [
    ['cpu-reduction', any((c) => c.cpu === 'decrease')],
    ['memory-reduction', any((c) => c.memory === 'decrease')],
    ['increase', any((c) => up(c.cpu) || up(c.memory))],
    [
      'request-unset',
      any((c) => c.current.cpu_request == null || c.current.memory_request == null),
    ],
    ['missing-data', rec.verdict === 'no-data' || any((c) => !c.usage)],
    ['needs-review', rec.changed && rec.confidence !== 'high'],
    ['limit-raised', any((c) => c.cpu_limit_raised || c.memory_limit_raised)],
  ];
  return rules.filter(([, on]) => on).map(([lens]) => lens);
}

const WORKLOAD_KEYS: Array<[string, string]> = [
  ['Deployment', 'deployments.apps'],
  ['StatefulSet', 'statefulsets.apps'],
  ['DaemonSet', 'daemonsets.apps'],
  ['CronJob', 'cronjobs.batch'],
];

/** Pod names stored per workload (like the backend's `MAX_POD_NAMES`). */
const MAX_POD_NAMES = 50;

/** How a demo collection went (the backend's pipeline facts); every field optional. */
export interface DemoPipeline {
  /** Strategy id (default percentile-headroom). */
  strategy: string;
  /** kube-state-metrics owner series resolved the pods (else matched by name). */
  ownerMetrics: boolean;
  /** Days of the collected window (default `settings.days`; re-evaluation keeps the stored one). */
  windowDays: number;
  /** Namespaces whose usage could not be queried: their workloads have no data. */
  failedNamespaces: string[];
  /** Namespaces whose batch was partial (`partial-data` flags). */
  partialNamespaces: string[];
  /** When the usage was collected (drift; default now). */
  at: number;
  /** HorizontalPodAutoscalers could be listed (default true). */
  hpas: boolean;
}

/** The HPA of a workload, like the backend's `hpa_target` (no metrics = 80 % CPU). */
function hpaIndex(db: ClusterDb): Map<string, HpaInfo> {
  const out = new Map<string, HpaInfo>();
  for (const h of list(db, 'horizontalpodautoscalers.autoscaling')) {
    const spec = asObject(h.spec);
    const target = asObject(spec.scaleTargetRef);
    const metrics = asArray(spec.metrics)
      .filter(isObject)
      .map((m) => {
        const resource = asObject(m.resource);
        const t = asObject(resource.target);
        const name = String(resource.name ?? '');
        return {
          resource: (m.type === 'Resource' && (name === 'cpu' || name === 'memory')
            ? name
            : 'other') as HpaInfo['metrics'][number]['resource'],
          target_utilization:
            m.type === 'Resource' && t.type === 'Utilization' && t.averageUtilization != null
              ? Number(t.averageUtilization)
              : null,
        };
      });
    out.set(`${h.metadata.namespace}/${String(target.kind)}/${String(target.name)}`, {
      name: h.metadata.name,
      min_replicas: spec.minReplicas != null ? Number(spec.minReplicas) : null,
      max_replicas: Number(spec.maxReplicas ?? 0),
      metrics: metrics.length ? metrics : [{ resource: 'cpu', target_utilization: 80 }],
    });
  }
  return out;
}

/** Pod names per `namespace/kind/name` (sorted). */
function podIndex(db: ClusterDb): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const pod of list(db, 'pods')) {
    const w = workloadOf(pod);
    if (!w) continue;
    const key = `${pod.metadata.namespace}/${w[0]}/${w[1]}`;
    const names = out.get(key) ?? [];
    names.push(pod.metadata.name);
    out.set(key, names);
  }
  for (const names of out.values()) names.sort();
  return out;
}

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
  pipeline: Partial<DemoPipeline> = {},
): WorkloadRecommendation[] {
  const strategy = pipeline.strategy ?? 'percentile-headroom';
  const ownerMetrics = pipeline.ownerMetrics ?? true;
  const failed = new Set(pipeline.failedNamespaces ?? []);
  const partial = new Set(pipeline.partialNamespaces ?? []);
  const at = pipeline.at ?? now;
  const hpas = pipeline.hpas === false ? new Map<string, HpaInfo>() : hpaIndex(db);
  const pods = podIndex(db);
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
          : kind === 'CronJob'
            ? 1
            : Number(spec.replicas ?? 1);
      const age = (at - Date.parse(w.metadata.creationTimestamp ?? '')) / 3_600_000;
      const windowDays = pipeline.windowDays ?? settings.days;
      const window = source === 'prometheus' ? windowDays * 24 : 1;
      const seed = `${db.id}/${ns}/${w.metadata.name}`;
      const prometheus = source === 'prometheus';
      // With Prometheus a CronJob's pods resolve through their Job (owner
      // metrics): observed hours only while they ran, its duty cycle.
      const duty = kind === 'CronJob' && prometheus ? cronDuty(seed) : null;
      const jobs = kind === 'CronJob' ? ownedBy(db, 'jobs.batch', w).length : 0;
      // A few workloads were created (or rolled out) within the window.
      const young = prometheus && unit(`${seed}#young`) < 0.02 ? 6 + unit(`${seed}#h`) * 14 : null;
      const hours =
        source === 'none' || failed.has(ns)
          ? 0
          : (young ??
            Math.max(0.25, Math.min(window, Number.isFinite(age) ? age : window)) * (duty ?? 1));
      const podNames = pods.get(`${ns}/${kind}/${w.metadata.name}`) ?? [];
      const identity: UsageEvidence['identity'] = !ownerMetrics
        ? 'name-match'
        : unit(`${seed}#ambiguous`) < 0.015
          ? 'ambiguous'
          : 'owner-metrics';
      const hpa = hpas.get(`${ns}/${kind}/${w.metadata.name}`) ?? null;
      const factor = driftFactor(seed, at);
      const recs = containers(podSpecOf(w)).map((c) => {
        const name = String(c.name ?? '');
        const current = resourcesOf(c);
        const usage =
          source === 'none' || failed.has(ns)
            ? null
            : syntheticUsage(`${seed}/${name}`, current, hours, factor);
        const evidence =
          prometheus && usage
            ? demoEvidence(
                `${seed}/${name}`,
                hours,
                Math.max(1, podNames.length || jobs || replicas),
                duty,
                identity,
                partial.has(ns),
              )
            : null;
        return recommendContainer(name, current, usage, source, settings, {
          strategy,
          evidence,
          hpa,
        });
      });
      // Like the backend: an ambiguous identity flags every container.
      if (identity === 'ambiguous' && prometheus) {
        for (const c of recs) {
          if (!c.warnings.some((x) => x.code === 'identity-unclear'))
            c.warnings.push(warn('identity-unclear'));
          c.confidence = 'low';
        }
      }
      const costReplicasOf = costReplicas(kind, replicas, recs);
      const current = monthlyRequests(recs, costReplicasOf, pricing, false);
      const next = monthlyRequests(recs, costReplicasOf, pricing, true);
      const coverage = recs.reduce((m, c) => Math.max(m, c.usage?.hours ?? 0), 0);
      const rec: WorkloadRecommendation = {
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
                worst == null || CONFIDENCE_RANK[c.confidence] < CONFIDENCE_RANK[worst]
                  ? c.confidence
                  : worst,
              null,
            ) ?? 'low',
        verdict: verdictOf(recs, current, next),
        coverage_hours: coverage,
        containers: recs,
        monthly_delta: next - current,
        monthly_current: current,
        changed: recs.some(changed),
        pods: prometheus ? podNames.slice(0, MAX_POD_NAMES) : [],
        pods_truncated: prometheus && podNames.length > MAX_POD_NAMES,
        hpa,
        lenses: [],
        cost_replicas: costReplicasOf,
      };
      rec.lenses = lensesOf(rec);
      out.push(rec);
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
