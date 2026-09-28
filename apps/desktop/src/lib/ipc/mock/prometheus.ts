import type {
  ClusterDef,
  ClusterStatus,
  PrometheusMetric,
  PrometheusMetricsResult,
  PrometheusRange,
  PrometheusService,
  PrometheusStatus,
  PrometheusTarget,
  PromQueryResult,
} from '@/types';
import { sleep } from './bus';
import { accessKey } from '@/lib/prometheusAccess';
import { find, getDb, list } from './fixtures/db';
import {
  ALL_METRICS,
  detectServices,
  evalTimes,
  evaluatePromql,
  presetPoints,
  presetQuery,
  promqlSyntaxError,
} from './fixtures/prometheus';
import { handlers, register, type MockArgs } from './registry';

/**
 * Demo Prometheus: detection over the fixture services (kube-prometheus-stack
 * on prod-eu-west-1, the prometheus chart on the other cloud clusters,
 * nothing on the local ones, so they show the metrics-server fallback),
 * synthetic preset series and a PromQL look-alike. Mirrors the backend's
 * step selection and error messages. `prometheus_access` is kept with the
 * cluster (`cluster_update` stores it) and keys the status like the backend;
 * credentials are "read" from the fixture Secret it references, and a
 * missing Secret or key makes the source unreachable with the backend's
 * message (the tunnel itself is not simulated).
 */

const NICE_STEPS = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
const MAX_SERIES = 200;

function autoStep(rangeSecs: number) {
  const raw = Math.max(15, Math.ceil(rangeSecs / 240));
  return NICE_STEPS.find((s) => s >= raw) ?? Math.ceil(raw / 86400) * 86400;
}

function rateWindow(step: number) {
  return Math.max(step + 30, 120);
}

function clusterDef(id: string): ClusterDef {
  const cluster = ((handlers.cluster_list?.({}) as ClusterDef[] | undefined) ?? []).find(
    (c) => c.id === id,
  );
  if (!cluster) throw new Error(`cluster ${id} is not registered`);
  return cluster;
}

function connection(id: string): ClusterStatus | undefined {
  return (handlers.cluster_statuses?.({}) as Record<string, ClusterStatus> | undefined)?.[id];
}

function blank(state: PrometheusStatus['state']): PrometheusStatus {
  return {
    state,
    service: null,
    source: null,
    error: null,
    candidates: [],
    checked_at: Date.now(),
  };
}

/** The backend's error for credentials it cannot read, or null. */
function credentialsProblem(cluster: ClusterDef): string | null {
  const auth = cluster.prometheus_access?.auth;
  if (!auth) return null;
  const secret = find(getDb(cluster.id), 'secrets', auth.namespace, auth.secret);
  if (!secret)
    return `could not read Secret ${auth.namespace}/${auth.secret}: secrets "${auth.secret}" not found`;
  const data = (secret.data ?? {}) as Record<string, string>;
  const keys = auth.type === 'bearer' ? [auth.token_key] : [auth.username_key, auth.password_key];
  const missing = keys.find((k) => !data[k]);
  return missing ? `Secret ${auth.namespace}/${auth.secret} has no key "${missing}"` : null;
}

async function detect(cluster: ClusterDef): Promise<PrometheusStatus> {
  const config = cluster.prometheus ?? { mode: 'auto' };
  if (config.mode === 'off') return blank('off');
  const db = getDb(cluster.id);
  const problem = credentialsProblem(cluster);
  if (config.mode === 'service') {
    await sleep(120);
    const service: PrometheusService = {
      kind: 'custom',
      namespace: config.namespace,
      service: config.service,
      port: config.port,
      scheme: config.scheme,
      path_prefix: config.path_prefix,
    };
    const exists = list(db, 'services').some(
      (s) => s.metadata.namespace === config.namespace && s.metadata.name === config.service,
    );
    if (exists && problem)
      return { ...blank('unreachable'), service, source: 'configured', error: problem };
    return exists
      ? { ...blank('available'), service, source: 'configured' }
      : {
          ...blank('unreachable'),
          service,
          source: 'configured',
          error: `services "${config.service}" not found`,
        };
  }
  await sleep(350);
  const candidates = detectServices(db);
  if (!candidates.length) return blank('not-found');
  if (problem)
    return {
      ...blank('unreachable'),
      service: candidates[0]!,
      source: 'detected',
      error: problem,
      candidates,
    };
  return { ...blank('available'), service: candidates[0]!, source: 'detected', candidates };
}

const cache = new Map<string, PrometheusStatus>();

async function status(clusterId: string, refresh: boolean): Promise<PrometheusStatus> {
  const cluster = clusterDef(clusterId);
  if (cluster.prometheus?.mode === 'off') return blank('off');
  const conn = connection(clusterId);
  if (conn?.state !== 'connected') throw new Error(`cluster "${cluster.name}" is not connected`);
  const key = `${clusterId}|${conn.connected_at}|${JSON.stringify(cluster.prometheus ?? null)}|${accessKey(cluster.prometheus_access)}`;
  const cached = cache.get(key);
  if (cached && !refresh) {
    await sleep(25);
    return cached;
  }
  const result = await detect(cluster);
  cache.set(key, result);
  return result;
}

async function service(clusterId: string): Promise<PrometheusService> {
  const st = await status(clusterId, false);
  if (st.state === 'available' && st.service) return st.service;
  if (st.state === 'off') throw new Error('Prometheus is turned off for this cluster');
  if (st.state === 'unreachable' && st.service)
    throw new Error(
      `Prometheus at ${st.service.namespace}/${st.service.service} is not reachable: ${st.error}`,
    );
  if (st.state === 'forbidden' && st.service)
    throw new Error(
      `Prometheus at ${st.service.namespace}/${st.service.service} needs get on services/proxy in namespace ${st.service.namespace}: ${st.error}`,
    );
  throw new Error('no Prometheus was found on this cluster');
}

function window(range: PrometheusRange) {
  if (!(range.end > range.start))
    throw new Error('the time range is empty (end must be after start)');
  const span = (range.end - range.start) / 1000;
  const step = Math.max(range.step ?? autoStep(span), Math.ceil(span / 11_000));
  return { step, times: evalTimes(range.start, range.end, step) };
}

register({
  prometheus_status: ({ clusterId, refresh }: MockArgs) => status(clusterId, Boolean(refresh)),

  prometheus_metrics: async ({ clusterId, target, metrics, range }: MockArgs) => {
    const svc = await service(clusterId);
    const { step, times } = window(range as PrometheusRange);
    await sleep(90 + Math.random() * 160);
    const rate = rateWindow(step);
    const db = getDb(clusterId);
    const wanted = [...new Set((metrics as PrometheusMetric[]).length ? metrics : ALL_METRICS)];
    const t = target as PrometheusTarget;
    const series = (wanted as PrometheusMetric[]).flatMap((metric) => {
      const points = presetPoints(db, t, metric, times, rate);
      return points === null
        ? []
        : [{ metric, query: presetQuery(t, metric, rate), points, error: null }];
    });
    const result: PrometheusMetricsResult = {
      service: svc,
      step_secs: step,
      rate_window_secs: rate,
      start: times[0] ?? (range as PrometheusRange).start,
      end: (range as PrometheusRange).end,
      series,
    };
    return result;
  },

  prometheus_query_range: async ({ clusterId, query, range }: MockArgs) => {
    const q = String(query ?? '').trim();
    if (!q) throw new Error('enter a PromQL expression');
    const svc = await service(clusterId);
    const { step, times } = window(range as PrometheusRange);
    await sleep(160 + Math.random() * 240);
    const syntax = promqlSyntaxError(q);
    if (syntax) throw new Error(syntax);
    const all = evaluatePromql(getDb(clusterId), q, times);
    const result: PromQueryResult = {
      service: svc,
      step_secs: step,
      start: times[0] ?? (range as PrometheusRange).start,
      end: (range as PrometheusRange).end,
      result_type: 'matrix',
      series: all.slice(0, MAX_SERIES),
      truncated: all.length > MAX_SERIES,
      warnings: [],
    };
    return result;
  },
});
