import { asArray, asNumber, asObject, asString, isObject } from '../accessors';

/**
 * Readers for the Envoy admin API's JSON (`/server_info`, `/config_dump`,
 * `/clusters?format=json`, `/stats?format=json`, `/listeners?format=json`),
 * as returned by the `envoy_admin` command. They never throw: a body that
 * is not the expected JSON yields `null` and the raw text is shown instead.
 * Secrets in a config dump are listed by name only.
 */

function parse(body: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(body);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

/** `"86400s"` / `"1.5s"` → seconds. */
function seconds(v: unknown): number | null {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(asString(v));
  return m ? Number(m[1]) : typeof v === 'number' ? v : null;
}

export interface EnvoyServerInfo {
  version: string;
  state: string;
  uptimeSeconds: number | null;
  nodeId: string;
  cluster: string;
}

export function parseServerInfo(body: string): EnvoyServerInfo | null {
  const j = parse(body);
  if (!j || !('version' in j || 'state' in j)) return null;
  const opts = asObject(j.command_line_options);
  const node = asObject(j.node);
  return {
    version: asString(j.version),
    state: asString(j.state),
    uptimeSeconds: seconds(j.uptime_current_epoch),
    nodeId: asString(node.id) || asString(opts.service_node),
    cluster: asString(node.cluster) || asString(opts.service_cluster),
  };
}

function socketAddress(raw: unknown): string {
  const a = asObject(asObject(raw).socket_address);
  const host = asString(a.address);
  const port = a.port_value;
  if (!host && port === undefined) {
    const pipe = asString(asObject(asObject(raw).pipe).path);
    return pipe ? `unix:${pipe}` : '';
  }
  return port !== undefined ? `${host.includes(':') ? `[${host}]` : host}:${asNumber(port)}` : host;
}

export interface DumpListener {
  name: string;
  address: string;
  /** Filter chains with their SNI names and network filter names. */
  chains: Array<{ serverNames: string[]; filters: string[] }>;
  state: 'active' | 'warming' | 'draining' | 'static';
}

export interface DumpVirtualHost {
  routeConfig: string;
  name: string;
  domains: string[];
  routes: Array<{ name: string; match: string; action: string }>;
}

export interface DumpCluster {
  name: string;
  type: string;
  dynamic: boolean;
}

export interface ConfigDumpSummary {
  version: string;
  nodeId: string;
  listeners: DumpListener[];
  virtualHosts: DumpVirtualHost[];
  clusters: DumpCluster[];
  /** SDS secret names only (never their contents). */
  secrets: string[];
}

const typeOf = (c: Record<string, unknown>) => asString(c['@type']).split('.').pop() ?? '';

function listenerOf(raw: unknown, state: DumpListener['state']): DumpListener | null {
  const l = asObject(raw);
  if (!isObject(l.address) && !l.name) return null;
  return {
    name: asString(l.name),
    address: socketAddress(l.address),
    chains: asArray(l.filter_chains)
      .filter(isObject)
      .map((fc) => ({
        serverNames: asArray(asObject(fc.filter_chain_match).server_names).map((s) => asString(s)),
        filters: asArray(fc.filters)
          .filter(isObject)
          .map((f) => asString(f.name).replace(/^envoy\.filters\.network\./, '')),
      })),
    state,
  };
}

function matchText(m: Record<string, unknown>): string {
  if ('prefix' in m) return `prefix ${asString(m.prefix) || '/'}`;
  if ('path' in m) return `path ${asString(m.path)}`;
  if ('path_separated_prefix' in m) return `prefix ${asString(m.path_separated_prefix)}`;
  if (isObject(m.safe_regex)) return `regex ${asString(m.safe_regex.regex)}`;
  if (isObject(m.path_match_policy)) return 'path policy';
  if ('connect_matcher' in m) return 'CONNECT';
  return '';
}

function actionText(r: Record<string, unknown>): string {
  if (isObject(r.route)) {
    const route = r.route;
    if (route.cluster) return `→ ${asString(route.cluster)}`;
    if (isObject(route.weighted_clusters)) {
      const names = asArray(route.weighted_clusters.clusters)
        .filter(isObject)
        .map((c) => `${asString(c.name)} (${asNumber(c.weight)})`);
      return `→ ${names.join(', ')}`;
    }
    if (route.cluster_header) return `→ header ${asString(route.cluster_header)}`;
    return '→';
  }
  if (isObject(r.redirect)) return 'redirect';
  if (isObject(r.direct_response)) return `direct ${asNumber(r.direct_response.status)}`;
  return '';
}

export function summarizeConfigDump(body: string): ConfigDumpSummary | null {
  const j = parse(body);
  if (!j || !Array.isArray(j.configs)) return null;
  const out: ConfigDumpSummary = {
    version: '',
    nodeId: '',
    listeners: [],
    virtualHosts: [],
    clusters: [],
    secrets: [],
  };
  for (const c of asArray(j.configs).filter(isObject)) {
    switch (typeOf(c)) {
      case 'BootstrapConfigDump': {
        const node = asObject(asObject(c.bootstrap).node);
        out.nodeId = asString(node.id);
        const build = asObject(asObject(node.user_agent_build_version).version);
        if (build.major_number !== undefined)
          out.version = `${asNumber(build.major_number)}.${asNumber(build.minor_number)}.${asNumber(build.patch)}`;
        break;
      }
      case 'ListenersConfigDump': {
        for (const s of asArray(c.static_listeners).filter(isObject)) {
          const l = listenerOf(s.listener, 'static');
          if (l) out.listeners.push(l);
        }
        for (const d of asArray(c.dynamic_listeners).filter(isObject)) {
          const state = isObject(d.active_state)
            ? 'active'
            : isObject(d.warming_state)
              ? 'warming'
              : 'draining';
          const holder = asObject(d.active_state ?? d.warming_state ?? d.draining_state);
          const l = listenerOf(holder.listener, state);
          if (l) out.listeners.push({ ...l, name: l.name || asString(d.name) });
        }
        break;
      }
      case 'RoutesConfigDump': {
        const configs = [
          ...asArray(c.static_route_configs),
          ...asArray(c.dynamic_route_configs),
        ].filter(isObject);
        for (const rc of configs) {
          const config = asObject(rc.route_config);
          const routeConfig = asString(config.name);
          for (const vh of asArray(config.virtual_hosts).filter(isObject))
            out.virtualHosts.push({
              routeConfig,
              name: asString(vh.name),
              domains: asArray(vh.domains).map((d) => asString(d)),
              routes: asArray(vh.routes)
                .filter(isObject)
                .map((r) => ({
                  name: asString(r.name),
                  match: matchText(asObject(r.match)),
                  action: actionText(r),
                })),
            });
        }
        break;
      }
      case 'ClustersConfigDump': {
        for (const s of asArray(c.static_clusters).filter(isObject)) {
          const cl = asObject(s.cluster);
          out.clusters.push({
            name: asString(cl.name),
            type: asString(cl.type) || 'STATIC',
            dynamic: false,
          });
        }
        for (const d of [
          ...asArray(c.dynamic_active_clusters),
          ...asArray(c.dynamic_warming_clusters),
        ].filter(isObject)) {
          const cl = asObject(d.cluster);
          out.clusters.push({
            name: asString(cl.name),
            type: asString(cl.type) || 'EDS',
            dynamic: true,
          });
        }
        break;
      }
      case 'SecretsConfigDump': {
        for (const s of [
          ...asArray(c.static_secrets),
          ...asArray(c.dynamic_active_secrets),
          ...asArray(c.dynamic_warming_secrets),
        ].filter(isObject))
          if (s.name) out.secrets.push(asString(s.name));
        break;
      }
      default:
        break;
    }
  }
  out.listeners.sort((a, b) => a.name.localeCompare(b.name));
  out.clusters.sort((a, b) => a.name.localeCompare(b.name));
  out.secrets.sort();
  return out;
}

export interface ClusterHost {
  address: string;
  health: string;
  weight: number;
  /** `rq_total`, `rq_error`, `cx_active` from the host stats. */
  requests: number;
  errors: number;
  connections: number;
}

export interface ClusterStatus {
  name: string;
  hosts: ClusterHost[];
  healthy: number;
}

/** `eds_health_status` or the first failed active/outlier flag. */
function healthOf(raw: unknown): string {
  const h = asObject(raw);
  const eds = asString(h.eds_health_status);
  for (const flag of [
    'failed_active_health_check',
    'failed_outlier_check',
    'failed_active_degraded_check',
    'pending_dynamic_removal',
    'pending_active_hc',
  ])
    if (h[flag] === true) return flag.toUpperCase();
  return eds || 'HEALTHY';
}

export function parseClusters(body: string): ClusterStatus[] | null {
  const j = parse(body);
  if (!j || !Array.isArray(j.cluster_statuses)) return null;
  return asArray(j.cluster_statuses)
    .filter(isObject)
    .map((c) => {
      const hosts = asArray(c.host_statuses)
        .filter(isObject)
        .map((h) => {
          const stats = new Map(
            asArray(h.stats)
              .filter(isObject)
              .map((s) => [asString(s.name), asNumber(s.value)] as const),
          );
          return {
            address: socketAddress(h.address),
            health: healthOf(h.health_status),
            weight: asNumber(h.weight, 1),
            requests: stats.get('rq_total') ?? 0,
            errors: stats.get('rq_error') ?? 0,
            connections: stats.get('cx_active') ?? 0,
          };
        });
      return {
        name: asString(c.name),
        hosts,
        healthy: hosts.filter((h) => h.health === 'HEALTHY').length,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface EnvoyStat {
  name: string;
  value: number;
}

/** Counters and gauges of `/stats?format=json` (histograms are left out). */
export function parseStats(body: string): EnvoyStat[] | null {
  const j = parse(body);
  if (!j || !Array.isArray(j.stats)) return null;
  return asArray(j.stats)
    .filter(isObject)
    .filter((s) => typeof s.name === 'string' && 'value' in s)
    .map((s) => ({ name: asString(s.name), value: asNumber(s.value) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Stats whose name contains every whitespace-separated term of `query`. */
export function filterStats(stats: readonly EnvoyStat[], query: string): EnvoyStat[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...stats];
  return stats.filter((s) => terms.every((t) => s.name.toLowerCase().includes(t)));
}

export interface EnvoyStatHighlights {
  live: boolean | null;
  downstreamRequests: number;
  downstream5xx: number;
  downstreamActive: number;
  upstreamRequests: number;
  upstream5xx: number;
  clustersActive: number | null;
  listenersActive: number | null;
}

/**
 * HTTP connection managers that serve Envoy itself, not traffic: the admin
 * interface (this inspector's own requests) and Envoy Gateway's stats and
 * readiness listeners (Prometheus scrapes, kubelet probes).
 */
const OWN_LISTENER = /^http\.(admin|eg-[^.]+)\./;

/** A few headline numbers summed over the traffic connection managers and every cluster. */
export function statHighlights(stats: readonly EnvoyStat[]): EnvoyStatHighlights {
  const sum = (re: RegExp) =>
    stats.reduce(
      (acc, s) => (re.test(s.name) && !OWN_LISTENER.test(s.name) ? acc + s.value : acc),
      0,
    );
  const one = (name: string) => stats.find((s) => s.name === name)?.value ?? null;
  const live = one('server.state');
  return {
    // `server.state`: 0 = LIVE.
    live: live === null ? null : live === 0,
    downstreamRequests: sum(/^http\.[^.]+\.downstream_rq_total$/),
    downstream5xx: sum(/^http\.[^.]+\.downstream_rq_5xx$/),
    downstreamActive: sum(/^http\.[^.]+\.downstream_rq_active$/),
    upstreamRequests: sum(/^cluster\..+\.upstream_rq_total$/),
    upstream5xx: sum(/^cluster\..+\.upstream_rq_5xx$/),
    clustersActive: one('cluster_manager.active_clusters'),
    listenersActive: one('listener_manager.total_listeners_active'),
  };
}

/** Pretty-printed JSON, else the body as it came. */
export function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
