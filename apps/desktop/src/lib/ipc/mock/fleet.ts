import { compileNameMatcher } from '@/lib/fleet/nameMatch';
import { kindKey } from '@/lib/kube/catalog';
import type {
  ClusterDef,
  ClusterStatus,
  FleetSearchEvent,
  FleetSearchQuery,
  KubeObject,
  MetricsHistoryQuery,
  MetricsPoint,
  MetricsSeries,
  Quantity,
} from '@/types';
import { sleep } from './bus';
import { getDb, list, type ClusterDb } from './fixtures/db';
import { apiResources, nodeMetrics, podMetrics } from './fixtures/discovery';
import { hashString } from './fixtures/util';
import { handlers, register, type MockArgs } from './registry';

/**
 * Demo fleet backend: metrics history and fleet search over the fixture
 * clusters. History is synthesised deterministically around the current
 * fixture usage (slow waves, noise, the odd burst, a memory sawtooth), so
 * charts look alive and agree across reloads. `kind-kubepit` only "samples"
 * since it was connected, which shows the collecting state; the others
 * pretend they have been connected for the whole hour.
 */

const STEP = 15_000;
const WINDOW = 60 * 60_000;

function statuses(): Record<string, ClusterStatus> {
  return (handlers.cluster_statuses?.({}) as Record<string, ClusterStatus> | undefined) ?? {};
}

function clusters(): ClusterDef[] {
  return (handlers.cluster_list?.({}) as ClusterDef[] | undefined) ?? [];
}

const unit = (seed: string, n: number) => hashString(`${seed}:${n}`) / 4294967296;

/** Multiplier around 1 for one series at tick `t`. */
function wave(seed: string, t: number, what: 'cpu' | 'mem'): number {
  const h = hashString(seed);
  const phase = (h % 628) / 100;
  if (what === 'cpu') {
    const slow = Math.sin(t / 38 + phase) * 0.11;
    const mid = Math.sin(t / 6.7 + phase * 2) * 0.05;
    const noise = (unit(seed, t) - 0.5) * 0.12;
    const window = Math.floor(t / 9);
    const burst = unit(`${seed}!`, window) > 0.9 ? 0.55 * Math.exp(-(t % 9) / 2.2) : 0;
    return Math.max(0.08, 1 + slow + mid + noise + burst);
  }
  const period = 36 + (h % 44);
  const saw = (((t + (h % period)) % period) / period - 0.5) * 0.09;
  const drift = Math.sin(t / 55 + phase) * 0.035;
  const noise = (unit(`${seed}~`, t) - 0.5) * 0.015;
  return 1 + saw + drift + noise;
}

function firstTick(clusterId: string, status: ClusterStatus | undefined, now: number) {
  const windowStart = Math.ceil((now - WINDOW) / STEP);
  if (clusterId === 'c-kind' && status?.connected_at)
    return Math.max(windowStart, Math.ceil(status.connected_at / STEP));
  return windowStart;
}

function curve(
  seed: string,
  base: Quantity,
  from: number,
  to: number,
): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  for (let t = from; t <= to; t++)
    out.set(t, [
      base.cpu_millicores * wave(seed, t, 'cpu'),
      base.memory_bytes * wave(seed, t, 'mem'),
    ]);
  return out;
}

function sumCurves(curves: Array<Map<number, [number, number]>>): MetricsPoint[] {
  const totals = new Map<number, [number, number]>();
  for (const c of curves)
    for (const [t, [cpu, mem]] of c) {
      const acc = totals.get(t) ?? [0, 0];
      totals.set(t, [acc[0] + cpu, acc[1] + mem]);
    }
  return [...totals.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, [cpu, mem]]) => ({ ts: t * STEP, cpu_millicores: cpu, memory_bytes: mem }));
}

function createdTick(obj: KubeObject | undefined) {
  const created = Date.parse(obj?.metadata.creationTimestamp ?? '');
  return Number.isFinite(created) ? Math.ceil(created / STEP) : -Infinity;
}

function history(db: ClusterDb, query: MetricsHistoryQuery, from: number, to: number) {
  if (query.scope === 'cluster') {
    const total = nodeMetrics(db).items.reduce(
      (s, m) => ({
        cpu_millicores: s.cpu_millicores + m.cpu_millicores,
        memory_bytes: s.memory_bytes + m.memory_bytes,
      }),
      { cpu_millicores: 0, memory_bytes: 0 },
    );
    return sumCurves([curve(db.id, total, from, to)]);
  }
  if (query.scope === 'nodes') {
    const wanted = new Set(query.names);
    return sumCurves(
      nodeMetrics(db)
        .items.filter((m) => wanted.has(m.name))
        .map((m) => curve(`${db.id}/${m.name}`, m, from, to)),
    );
  }
  const wanted = new Set(query.names);
  const pods = new Map(
    list(db, 'pods')
      .filter((p) => p.metadata.namespace === query.namespace)
      .map((p) => [p.metadata.name, p]),
  );
  return sumCurves(
    podMetrics(db, query.namespace)
      .items.filter((m) => wanted.has(m.name))
      .map((m) =>
        curve(
          `${db.id}/${m.namespace}/${m.name}`,
          m,
          Math.max(from, createdTick(pods.get(m.name))),
          to,
        ),
      ),
  );
}

function downsample(points: MetricsPoint[], bucket: number): MetricsPoint[] {
  const groups = new Map<number, MetricsPoint[]>();
  for (const p of points) {
    const key = Math.floor(p.ts / bucket);
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups.values()].map((g) => ({
    ts: g.reduce((s, p) => s + p.ts, 0) / g.length,
    cpu_millicores: g.reduce((s, p) => s + p.cpu_millicores, 0) / g.length,
    memory_bytes: g.reduce((s, p) => s + p.memory_bytes, 0) / g.length,
  }));
}

function seriesFor(clusterId: string, query: MetricsHistoryQuery): MetricsSeries {
  const status = statuses()[clusterId];
  const db = getDb(clusterId);
  if (!db.profile.metrics) return { interval_secs: 15, available: false, points: [] };
  if (status?.state !== 'connected') return { interval_secs: 15, available: true, points: [] };
  const now = Date.now();
  return {
    interval_secs: 15,
    available: true,
    points: history(db, query, firstTick(clusterId, status, now), Math.floor(now / STEP)),
  };
}

// ---------------------------------------------------------------------------
// Fleet search
// ---------------------------------------------------------------------------

function labelMatcher(selector: string | null) {
  const terms = (selector ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return (o: KubeObject) => {
    const labels = o.metadata.labels ?? {};
    return terms.every((term) => {
      const ne = term.split('!=');
      if (ne.length === 2) return labels[ne[0]!.trim()] !== ne[1]!.trim();
      const eq = term.split(/==?/);
      if (eq.length === 2) return labels[eq[0]!.trim()] === eq[1]!.trim();
      if (term.startsWith('!')) return !(term.slice(1) in labels);
      return term in labels;
    });
  };
}

const running = new Map<string, { cancelled: boolean }>();

function startSearch(query: FleetSearchQuery, emit: (e: FleetSearchEvent) => void): string {
  const matches = compileNameMatcher(query.text);
  if (!query.kinds.length) throw new Error('choose at least one kind to search');
  const id = crypto.randomUUID();
  const state = { cancelled: false };
  running.set(id, state);
  const base = (cluster_id: string | null, kind: FleetSearchEvent['kind']): FleetSearchEvent => ({
    search_id: id,
    cluster_id,
    kind,
    items: [],
    truncated: false,
    forbidden_kinds: [],
    error: null,
  });
  const send = (e: FleetSearchEvent) => {
    if (!state.cancelled) emit(e);
  };
  const ids = query.cluster_ids.length ? query.cluster_ids : clusters().map((c) => c.id);
  const labels = labelMatcher(query.label_selector);

  const searchCluster = async (clusterId: string) => {
    if (statuses()[clusterId]?.state !== 'connected') {
      await sleep(20);
      send({ ...base(clusterId, 'cluster-skipped'), error: 'not connected' });
      return;
    }
    const db = getDb(clusterId);
    const served = apiResources(db);
    // Far-away clusters answer later, like real API servers.
    const latency = 140 + (hashString(clusterId) % 380) + (clusterId === 'c-prod-us' ? 700 : 0);
    const forbidden: string[] = [];
    for (const gvk of query.kinds) {
      await sleep(latency / query.kinds.length + Math.random() * 60);
      if (state.cancelled) return;
      const info = served.find((r) => r.group === gvk.group && r.plural === gvk.plural);
      if (!info || (query.namespace && !info.namespaced)) continue;
      if (db.profile.forbidClusterSecrets && gvk.plural === 'secrets' && !gvk.group) {
        if (!query.namespace) {
          forbidden.push(gvk.kind);
          continue;
        }
      }
      const found = list(db, kindKey(gvk))
        .filter(
          (o) =>
            (!query.namespace || o.metadata.namespace === query.namespace) &&
            labels(o) &&
            matches(o.metadata.name),
        )
        .sort(
          (a, b) =>
            (a.metadata.namespace ?? '').localeCompare(b.metadata.namespace ?? '') ||
            a.metadata.name.localeCompare(b.metadata.name),
        );
      if (!found.length) continue;
      send({
        ...base(clusterId, 'results'),
        truncated: found.length > query.limit_per_kind,
        items: found.slice(0, query.limit_per_kind).map((o) => ({
          gvk: {
            group: info.group,
            version: info.version,
            kind: info.kind,
            plural: info.plural,
            namespaced: info.namespaced,
          },
          namespace: o.metadata.namespace ?? null,
          name: o.metadata.name,
          uid: o.metadata.uid,
          created: o.metadata.creationTimestamp ?? null,
          labels: { ...(o.metadata.labels ?? {}) },
        })),
      });
    }
    send({ ...base(clusterId, 'cluster-done'), forbidden_kinds: forbidden.sort() });
  };

  void Promise.all(ids.map(searchCluster)).then(() => {
    send(base(null, 'done'));
    running.delete(id);
  });
  return id;
}

register({
  metrics_history: async ({ clusterId, query }: MockArgs) => {
    await sleep(70);
    if (!clusters().some((c) => c.id === clusterId))
      throw new Error(`cluster ${clusterId} is not registered`);
    return seriesFor(clusterId, query as MetricsHistoryQuery);
  },
  metrics_history_fleet: async () => {
    await sleep(90);
    const out: Record<string, MetricsSeries> = {};
    for (const c of clusters()) {
      if (statuses()[c.id]?.state !== 'connected') continue;
      const series = seriesFor(c.id, { scope: 'cluster' });
      out[c.id] = { ...series, interval_secs: 60, points: downsample(series.points, 60_000) };
    }
    return out;
  },
  fleet_search: ({ query, onEvent }: MockArgs) =>
    startSearch(query as FleetSearchQuery, onEvent as (e: FleetSearchEvent) => void),
  fleet_search_cancel: ({ searchId }: MockArgs) => {
    const state = running.get(searchId);
    if (state) state.cancelled = true;
    running.delete(searchId);
  },
});
