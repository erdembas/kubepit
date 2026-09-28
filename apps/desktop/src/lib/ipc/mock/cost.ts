import type {
  ClusterDef,
  ClusterStatus,
  ContainerResourceChange,
  CostQuery,
  CostReport,
  CostService,
  CostStatus,
  CostSummary,
  DryRunResult,
  KubeObject,
  PrometheusStatus,
  RightsizingReport,
  RightsizingRequest,
  RightsizingSource,
  Settings,
  WorkloadRef,
} from '@/types';
import { sleep } from './bus';
import {
  DEFAULT_SETTINGS,
  STRATEGIES,
  computeCosts,
  dailyTrend,
  defaultPricing,
  formatCpu,
  formatMemory,
  platformOf,
  workloadRecommendations,
  type UsageMap,
} from './fixtures/cost';
import { getDb, list } from './fixtures/db';
import { podMetrics } from './fixtures/discovery';
import { handlers, register, type MockArgs } from './registry';

/**
 * Demo cost insight: OpenCost detected on prod-eu-west-1 (allocations with
 * usage, network and idle, a daily trend), estimates from requests on the
 * other clusters — with Prometheus usage and a requests trend where the
 * demo runs Prometheus, the metrics-server snapshot on kind — and
 * right-sizing from synthetic usage histories.
 */

const OPENCOST: CostService = {
  kind: 'opencost',
  namespace: 'monitoring',
  service: 'opencost',
  port: 9003,
  scheme: 'http',
  path_prefix: '',
};

function clusterDef(id: string): ClusterDef {
  const cluster = ((handlers.cluster_list?.({}) as ClusterDef[] | undefined) ?? []).find(
    (c) => c.id === id,
  );
  if (!cluster) throw new Error(`cluster ${id} is not registered`);
  return cluster;
}

function connection(id: string): ClusterStatus {
  const status = (handlers.cluster_statuses?.({}) as Record<string, ClusterStatus> | undefined)?.[
    id
  ];
  if (status?.state !== 'connected')
    throw new Error(`cluster "${clusterDef(id).name}" is not connected`);
  return status;
}

async function prometheusAvailable(clusterId: string): Promise<boolean> {
  try {
    const st = (await handlers.prometheus_status?.({ clusterId, refresh: false })) as
      PrometheusStatus | undefined;
    return st?.state === 'available';
  } catch {
    return false;
  }
}

function hasOpencost(clusterId: string): boolean {
  return list(getDb(clusterId), 'services').some(
    (s) => s.metadata.name === OPENCOST.service && s.metadata.namespace === OPENCOST.namespace,
  );
}

async function status(clusterId: string): Promise<CostStatus> {
  const cluster = clusterDef(clusterId);
  const conn = connection(clusterId);
  const platform = platformOf(conn.platform);
  const pricing = cluster.cost?.pricing ?? defaultPricing(platform);
  const source = cluster.cost?.source ?? { mode: 'auto' };
  const base: CostStatus = {
    source: 'estimate',
    service: null,
    configured: source.mode !== 'auto',
    error: null,
    forbidden: false,
    candidates: [],
    platform,
    platform_label: conn.platform,
    pricing,
    pricing_custom: !!cluster.cost?.pricing,
    prometheus: await prometheusAvailable(clusterId),
    checked_at: Date.now(),
  };
  await sleep(120);
  if (source.mode === 'estimate') return base;
  if (source.mode === 'opencost' || source.mode === 'kubecost') {
    const service: CostService = {
      kind: source.mode,
      namespace: source.namespace,
      service: source.service,
      port: source.port,
      scheme: source.scheme,
      path_prefix: source.path_prefix,
    };
    const exists = list(getDb(clusterId), 'services').some(
      (s) => s.metadata.namespace === source.namespace && s.metadata.name === source.service,
    );
    return exists
      ? { ...base, source: source.mode, service }
      : {
          ...base,
          service,
          error: `no endpoints available for service "${source.service}"`,
        };
  }
  if (!hasOpencost(clusterId)) return base;
  return { ...base, source: 'opencost', service: OPENCOST, candidates: [OPENCOST] };
}

function usageOf(clusterId: string): UsageMap | null {
  const metrics = podMetrics(getDb(clusterId), null);
  if (!metrics.available) return null;
  return new Map(
    metrics.items.map((m) => [
      `${m.namespace}/${m.name}`,
      { cpu: m.cpu_millicores / 1000, mem: m.memory_bytes },
    ]),
  );
}

const reports = new Map<string, { at: number; report: CostReport }>();

async function report(clusterId: string, query: CostQuery): Promise<CostReport> {
  const cluster = clusterDef(clusterId);
  const conn = connection(clusterId);
  const label = query.aggregate === 'label' ? (query.label ?? '').trim() : null;
  if (query.aggregate === 'label' && !label)
    throw new Error('choose a label key to group costs by');
  const key = `${clusterId}|${conn.connected_at}|${JSON.stringify(cluster.cost ?? null)}|${query.window}|${query.aggregate}|${label ?? ''}`;
  const cached = reports.get(key);
  if (cached && !query.refresh && Date.now() - cached.at < 5 * 60_000) {
    await sleep(60);
    return cached.report;
  }
  const st = await status(clusterId);
  await sleep(250 + Math.random() * 250);
  const db = getDb(clusterId);
  const days = query.window === '30d' ? 30 : 7;
  const end = Date.now();
  const api = st.source !== 'estimate';
  const usage = usageOf(clusterId);
  const { totals, items } = computeCosts(db, st.pricing, query.aggregate, label, usage, api);
  const trend =
    api || st.prometheus
      ? dailyTrend(
          api ? totals.total : totals.allocated - totals.storage,
          days,
          `${clusterId}|${api}`,
        )
      : [];
  const result: CostReport = {
    status: st,
    window: query.window,
    aggregate: query.aggregate,
    label,
    currency: st.pricing.currency,
    start: end - days * 86_400_000,
    end,
    totals,
    items,
    trend,
    trend_basis: trend.length ? (api ? 'total' : 'requests') : 'none',
    usage: api ? 'cost-api' : usage ? (st.prometheus ? 'prometheus' : 'metrics-server') : 'none',
    notes: st.error ? [{ kind: 'api-failed', detail: st.error }] : [],
    computed_at: end,
  };
  reports.set(key, { at: end, report: result });
  return result;
}

async function rightsizing(clusterId: string, request: RightsizingRequest) {
  const cluster = clusterDef(clusterId);
  const conn = connection(clusterId);
  // Like the backend: the request's strategy, else the saved one, else automatic;
  // the request's settings, else the saved override, else the strategy's defaults.
  // An unknown saved strategy is ignored (automatic), an unknown requested one fails.
  const saved = (handlers.settings_get?.({}) as Settings | undefined)?.recommendations;
  const savedId = saved?.strategy?.trim();
  const savedKnown = STRATEGIES.some((s) => s.id === savedId) ? savedId : null;
  const requested = request.strategy?.trim() || savedKnown || null;
  const strategy = requested ?? STRATEGIES[0]!.id;
  const info = STRATEGIES.find((s) => s.id === strategy);
  if (!info) throw new Error(`unknown right-sizing strategy "${strategy}"`);
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(request.settings ?? saved?.overrides[strategy] ?? info.defaults),
  };
  settings.days = Math.min(30, Math.max(1, Math.round(settings.days)));
  const pricing = cluster.cost?.pricing ?? defaultPricing(platformOf(conn.platform));
  const prometheus = await prometheusAvailable(clusterId);
  const db = getDb(clusterId);
  const source: RightsizingSource = prometheus
    ? 'prometheus'
    : db.profile.metrics
      ? 'metrics-server'
      : 'none';
  await sleep(prometheus ? 500 + Math.random() * 400 : 200);
  const result: RightsizingReport = {
    source,
    window_secs: source === 'prometheus' ? settings.days * 86_400 : source === 'none' ? 0 : 3600,
    settings,
    currency: pricing.currency,
    pricing,
    workloads: workloadRecommendations(db, source, settings, pricing, {
      namespaces: request.namespaces ?? [],
      workload: request.workload ?? null,
    }),
    notes: source === 'none' ? [{ kind: 'no-usage', detail: null }] : [],
    strategy,
    strategies: STRATEGIES,
    computed_at: Date.now(),
    strategy_auto: requested == null,
    window_end: Date.now(),
  };
  return result;
}

const PLURAL: Record<string, string> = {
  Deployment: 'deployments',
  StatefulSet: 'statefulsets',
  DaemonSet: 'daemonsets',
};

/** The live object with `changes` merged into its containers by name. */
function patched(live: KubeObject, changes: ContainerResourceChange[]): KubeObject {
  const next = structuredClone(live);
  const spec = (next.spec as { template?: { spec?: { containers?: unknown[] } } }).template?.spec;
  const list = (spec?.containers ?? []) as Array<{
    name: string;
    resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  }>;
  for (const change of changes) {
    const c = list.find((x) => x.name === change.container);
    if (!c)
      throw new Error(`${live.kind} ${live.metadata.name} has no container "${change.container}"`);
    const resources = (c.resources ??= {});
    const requests = (resources.requests ??= {});
    const limits = (resources.limits ??= {});
    if (change.cpu_request != null) requests.cpu = formatCpu(change.cpu_request);
    if (change.memory_request != null) requests.memory = formatMemory(change.memory_request);
    if (change.cpu_limit != null) limits.cpu = formatCpu(change.cpu_limit);
    if (change.memory_limit != null) limits.memory = formatMemory(change.memory_limit);
  }
  next.metadata = {
    ...next.metadata,
    annotations: {
      ...next.metadata.annotations,
      'kubernetes.io/change-cause': `kubepit right-size ${live.kind.toLowerCase()}/${live.metadata.name}`,
    },
  };
  return next;
}

async function apply(
  clusterId: string,
  target: WorkloadRef,
  changes: ContainerResourceChange[],
  dryRun: boolean,
): Promise<DryRunResult> {
  const plural = PLURAL[target.kind];
  if (!plural) throw new Error('right-sizing supports Deployments, StatefulSets and DaemonSets');
  if (!changes.length) throw new Error('nothing to change');
  const cluster = clusterDef(clusterId);
  if (!dryRun && cluster.read_only)
    throw new Error(`cluster "${cluster.name}" is read-only: right-size is not allowed`);
  const gvk = { group: 'apps', version: 'v1', kind: target.kind, plural, namespaced: true };
  const live = handlers.resource_get!({
    clusterId,
    gvk,
    namespace: target.namespace,
    name: target.name,
  }) as KubeObject;
  const next = patched(live, changes);
  await sleep(dryRun ? 220 : 120);
  let result = next;
  if (!dryRun) {
    // A merge patch with the whole merged container list (the demo's patch
    // engine replaces arrays), through the regular patch path so rollouts start.
    result = (await handlers.resource_patch!({
      clusterId,
      gvk,
      namespace: target.namespace,
      name: target.name,
      patch: {
        metadata: { annotations: next.metadata.annotations },
        spec: {
          template: {
            spec: {
              containers: (next.spec as { template: { spec: { containers: unknown[] } } }).template
                .spec.containers,
            },
          },
        },
      },
      patchType: 'merge',
    })) as KubeObject;
  }
  return {
    api_version: 'apps/v1',
    kind: target.kind,
    name: target.name,
    namespace: target.namespace,
    operation: 'update',
    live,
    result,
    error: null,
  };
}

register({
  cost_status: ({ clusterId }: MockArgs) => status(clusterId),
  cost_report: ({ clusterId, query }: MockArgs) => report(clusterId, query as CostQuery),
  cost_summary: async ({ clusterId }: MockArgs) => {
    const r = await report(clusterId, { window: '7d', aggregate: 'namespace' });
    const summary: CostSummary = {
      source: r.status.source,
      currency: r.currency,
      total: r.totals.total,
      allocated: r.totals.allocated,
      idle: r.totals.idle,
      efficiency: r.totals.efficiency,
      computed_at: r.computed_at,
    };
    return summary;
  },
  rightsizing_report: ({ clusterId, request }: MockArgs) =>
    rightsizing(clusterId, request as RightsizingRequest),
  rightsizing_apply: ({ clusterId, target, changes, dryRun }: MockArgs) =>
    apply(clusterId, target as WorkloadRef, changes as ContainerResourceChange[], Boolean(dryRun)),
});
