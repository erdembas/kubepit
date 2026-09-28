import type {
  ClusterDef,
  ClusterStatus,
  LokiLine,
  LokiQuery,
  LokiQueryResult,
  LokiService,
  LokiStatus,
  PromPoint,
} from '@/types';
import { sleep } from './bus';
import { getDb, list } from './fixtures/db';
import {
  LOKI_LABELS,
  allStreams,
  detectLokiServices,
  eventsInMinute,
  minuteLines,
  parseLogQuery,
  parseVolumeQuery,
  selectStreams,
  type Stream,
} from './fixtures/loki';
import { handlers, register, type MockArgs } from './registry';

/**
 * Demo Loki: the grafana/loki gateway on prod-eu-west-1, the single binary
 * on the other cloud clusters (unreachable on dev, whose Loki pod is still
 * starting), nothing on the local ones. Streams and lines come from
 * `fixtures/loki.ts`; errors and limits mirror the backend.
 */

const MIN = 60_000;
const MAX_LIMIT = 5_000;
/** Minutes × streams generated per query at most (keeps the preview snappy). */
const SCAN_BUDGET = 40_000;

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

function blank(state: LokiStatus['state']): LokiStatus {
  return {
    state,
    service: null,
    source: null,
    error: null,
    candidates: [],
    checked_at: Date.now(),
  };
}

async function detect(cluster: ClusterDef): Promise<LokiStatus> {
  const config = cluster.loki ?? { mode: 'auto' };
  if (config.mode === 'off') return blank('off');
  const db = getDb(cluster.id);
  if (config.mode === 'service') {
    await sleep(120);
    const service: LokiService = {
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
    return exists
      ? { ...blank('available'), service, source: 'configured' }
      : {
          ...blank('unreachable'),
          service,
          source: 'configured',
          error: `services "${config.service}" not found`,
        };
  }
  await sleep(300);
  const candidates = detectLokiServices(db);
  if (!candidates.length) return blank('not-found');
  if (cluster.id === 'c-dev')
    return {
      ...blank('unreachable'),
      service: candidates[0]!,
      source: 'detected',
      candidates,
      error: `no endpoints available for service "${candidates[0]!.service}"`,
    };
  return { ...blank('available'), service: candidates[0]!, source: 'detected', candidates };
}

const cache = new Map<string, LokiStatus>();

async function status(clusterId: string, refresh: boolean): Promise<LokiStatus> {
  const cluster = clusterDef(clusterId);
  if (cluster.loki?.mode === 'off') return blank('off');
  const conn = connection(clusterId);
  if (conn?.state !== 'connected') throw new Error(`cluster "${cluster.name}" is not connected`);
  const key = `${clusterId}|${conn.connected_at}|${JSON.stringify(cluster.loki ?? null)}`;
  const cached = cache.get(key);
  if (cached && !refresh) {
    await sleep(20);
    return cached;
  }
  const result = await detect(cluster);
  cache.set(key, result);
  return result;
}

async function service(clusterId: string): Promise<LokiService> {
  const st = await status(clusterId, false);
  if (st.state === 'available' && st.service) return st.service;
  if (st.state === 'off') throw new Error('Loki is turned off for this cluster');
  if (st.state === 'unreachable' && st.service)
    throw new Error(
      `Loki at ${st.service.namespace}/${st.service.service} is not reachable: ${st.error}`,
    );
  throw new Error('no Loki was found on this cluster');
}

function rangeMs(start: string, end: string) {
  const valid = (v: string) => /^\d{1,19}$/.test(v);
  if (!valid(start)) throw new Error('the start time must be a nanosecond Unix timestamp');
  if (!valid(end)) throw new Error('the end time must be a nanosecond Unix timestamp');
  const s = Number(start.slice(0, -6) || '0');
  const e = Number(end.slice(0, -6) || '0');
  if (end.padStart(20, '0') <= start.padStart(20, '0'))
    throw new Error('the time range is empty (end must be after start)');
  return { s, e };
}

/** Lines of `streams` in [start, end) (ns strings), newest first, up to `limit`. */
function queryLines(
  streams: Stream[],
  test: (line: string) => boolean,
  start: string,
  end: string,
  limit: number,
  direction: LokiQuery['direction'],
) {
  const { s, e } = rangeMs(start, end);
  const lo = start.padStart(20, '0');
  const hi = end.padStart(20, '0');
  const firstMinute = Math.floor(s / MIN);
  const lastMinute = Math.floor((e - 1) / MIN);
  const out: Array<{ ns: string; stream: number; line: string }> = [];
  let budget = SCAN_BUDGET;
  const step = direction === 'backward' ? -1 : 1;
  for (
    let minute = direction === 'backward' ? lastMinute : firstMinute;
    minute >= firstMinute && minute <= lastMinute && out.length < limit && budget > 0;
    minute += step
  ) {
    const batch: Array<{ ns: string; stream: number; line: string }> = [];
    streams.forEach((stream, index) => {
      budget--;
      for (const l of minuteLines(stream, minute)) {
        const ns = l.ns.padStart(20, '0');
        if (ns < lo || ns >= hi || !test(l.line)) continue;
        batch.push({ ns: l.ns, stream: index, line: l.line });
      }
    });
    batch.sort((a, b) =>
      direction === 'backward'
        ? b.ns.localeCompare(a.ns) || a.stream - b.stream
        : a.ns.localeCompare(b.ns) || a.stream - b.stream,
    );
    for (const l of batch) {
      if (out.length >= limit) break;
      out.push(l);
    }
  }
  return out;
}

/** `sum(count_over_time(…))` per step: exact for short ranges, sampled beyond. */
function volume(
  streams: Stream[],
  test: (line: string) => boolean,
  filtered: boolean,
  s: number,
  e: number,
  step: number,
): PromPoint[] {
  const stepMs = step * 1000;
  const first = Math.floor(s / stepMs) * stepMs;
  const points: PromPoint[] = [];
  const minutes = (e - s) / MIN;
  // Share of lines that pass the filters, from a sample of minutes.
  const exact = filtered && minutes * streams.length <= SCAN_BUDGET;
  let ratio = 1;
  if (filtered && !exact) {
    let seen = 0;
    let passed = 0;
    const samples = 40;
    const sampled = streams.slice(0, 120);
    for (let i = 0; i < samples; i++) {
      const minute = Math.floor((s + ((e - s) * (i + 0.5)) / samples) / MIN);
      for (const stream of sampled)
        for (const l of minuteLines(stream, minute)) {
          seen++;
          if (test(l.line)) passed++;
        }
    }
    ratio = seen ? passed / seen : 0;
  }
  // Long ranges count a few minutes per bucket and scale (events are cheap, lines are not).
  const perBucket = 24;
  for (let t = first; t < e; t += stepMs) {
    let count = 0;
    const from = Math.max(Math.floor(t / MIN), Math.floor(s / MIN));
    const to = Math.floor((Math.min(t + stepMs, e) - 1) / MIN);
    const span = to - from + 1;
    const stride = exact ? 1 : Math.max(1, Math.floor(span / perBucket));
    for (let minute = from; minute <= to; minute += stride) {
      for (const stream of streams) {
        if (exact) {
          for (const l of minuteLines(stream, minute)) if (test(l.line)) count++;
        } else {
          const events = eventsInMinute(stream, minute);
          count += (stream.format === 'java' ? events * 1.3 : events) * stride;
        }
      }
    }
    points.push([t + stepMs, Math.round(exact ? count : count * ratio)]);
  }
  return points;
}

register({
  loki_status: ({ clusterId, refresh }: MockArgs) => status(clusterId, Boolean(refresh)),

  loki_labels: async ({ clusterId, start, end }: MockArgs) => {
    await service(clusterId);
    rangeMs(start, end);
    await sleep(60);
    return LOKI_LABELS;
  },

  loki_label_values: async ({ clusterId, label, start, end, query }: MockArgs) => {
    await service(clusterId);
    rangeMs(start, end);
    if (!/^[A-Za-z_]\w*$/.test(String(label)))
      throw new Error(`"${label}" is not a valid label name`);
    await sleep(80);
    let streams = allStreams(getDb(clusterId));
    if (query) streams = selectStreams(streams, parseLogQuery(String(query)).matchers);
    return [...new Set(streams.map((s) => s.labels[label]).filter((v): v is string => !!v))].sort();
  },

  loki_query_range: async ({ clusterId, query }: MockArgs): Promise<LokiQueryResult> => {
    const q = query as LokiQuery;
    const logql = q.query.trim();
    if (!logql) throw new Error('enter a LogQL query');
    const svc = await service(clusterId);
    const { s, e } = rangeMs(q.start, q.end);
    const limit = Math.min(Math.max(q.limit ?? 1_000, 1), MAX_LIMIT);
    const db = getDb(clusterId);
    const metric = parseVolumeQuery(logql);
    await sleep(120 + Math.random() * 180);
    if (metric) {
      const parsed = parseLogQuery(metric.inner);
      const streams = selectStreams(allStreams(db), parsed.matchers);
      const step = Math.max(q.step ?? metric.windowSecs, Math.ceil((e - s) / 1000 / 11_000));
      const filtered = /\|=|!=|\|~|!~|\|\s*\w+\s*[=!]/.test(
        metric.inner.slice(metric.inner.indexOf('}')),
      );
      return {
        service: svc,
        result_type: 'matrix',
        streams: [],
        lines: [],
        series: [{ labels: {}, points: volume(streams, parsed.test, filtered, s, e, step) }],
        limit,
        limit_reached: false,
        warnings: [],
      };
    }
    if (/^\s*[a-z_]+\s*\(/.test(logql))
      throw new Error(
        'Demo backend: only log queries and sum(count_over_time(…)) are supported in the browser preview.',
      );
    const parsed = parseLogQuery(logql);
    const selected = selectStreams(allStreams(db), parsed.matchers);
    const found = queryLines(selected, parsed.test, q.start, q.end, limit, q.direction);
    const used = [...new Set(found.map((l) => l.stream))];
    const index = new Map(used.map((stream, i) => [stream, i]));
    const lines: LokiLine[] = found.map((l) => ({
      stream: index.get(l.stream)!,
      ts: l.ns,
      line: l.line,
    }));
    return {
      service: svc,
      result_type: 'streams',
      streams: used.map((i) => selected[i]!.labels),
      lines,
      series: [],
      limit,
      limit_reached: lines.length >= limit,
      warnings: [],
    };
  },
});
