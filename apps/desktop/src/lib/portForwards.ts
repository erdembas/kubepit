import type { PortForward, PortForwardRequest, SavedPortForward } from '@/types';

/**
 * Pure helpers for port-forward lists: running forwards and saved
 * definitions merge into one row per forward (a saved definition that is
 * not running shows up as a stopped row).
 */

export interface ForwardRow {
  key: string;
  cluster_id: string;
  namespace: string;
  kind: 'pod' | 'service';
  name: string;
  remote_port: number;
  /** The running (or failed) forward, if any. */
  live: PortForward | null;
  /** Its saved definition, if any. */
  saved: SavedPortForward | null;
}

type Target = Pick<
  PortForwardRequest,
  'cluster_id' | 'namespace' | 'kind' | 'name' | 'remote_port'
>;

export function sameTarget(a: Target, b: Target): boolean {
  return (
    a.cluster_id === b.cluster_id &&
    a.namespace === b.namespace &&
    a.kind === b.kind &&
    a.name === b.name &&
    a.remote_port === b.remote_port
  );
}

/** Running forwards first (oldest first), then stopped saved ones by label/name. */
export function forwardRows(
  live: PortForward[],
  saved: SavedPortForward[],
  clusterId?: string,
): ForwardRow[] {
  const inCluster = <T extends { cluster_id: string }>(x: T) =>
    clusterId === undefined || x.cluster_id === clusterId;
  const byId = new Map(saved.map((s) => [s.id, s]));
  const running = new Set<string>();
  const rows: ForwardRow[] = live.filter(inCluster).map((f) => {
    const def = f.saved_id ? (byId.get(f.saved_id) ?? null) : null;
    if (def) running.add(def.id);
    return { ...targetOf(f), key: `live:${f.id}`, live: f, saved: def };
  });
  const stopped = saved
    .filter((s) => inCluster(s) && !running.has(s.id))
    .sort((a, b) => forwardTitle(a).localeCompare(forwardTitle(b)))
    .map((s) => ({ ...targetOf(s), key: `saved:${s.id}`, live: null, saved: s }));
  return [...rows, ...stopped];
}

function targetOf(x: Target) {
  return {
    cluster_id: x.cluster_id,
    namespace: x.namespace,
    kind: x.kind,
    name: x.name,
    remote_port: x.remote_port,
  };
}

/** The label of a saved forward, else `kind/name`. */
export function forwardTitle(x: { kind: string; name: string; label?: string | null }): string {
  return x.label?.trim() || `${x.kind}/${x.name}`;
}

export function forwardUrl(localPort: number): string {
  return `http://localhost:${localPort}`;
}

/** The local port a row uses or will use (null = picked when it starts). */
export function rowLocalPort(row: ForwardRow): number | null {
  if (row.live && row.live.local_port) return row.live.local_port;
  return row.saved?.local_port ?? null;
}

/** Valid TCP port typed by the user, or null. */
export function parsePort(value: string): number | null {
  const n = Number(value.trim());
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}
