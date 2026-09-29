import * as i18n from '@/i18n/core';
import type { ClusterDef, ClusterOverview, ClusterStatus } from '@/types';

/** `v1.31.2-gke.1066000` → `v1.31.2`; anything unparsable is kept as is. */
export function shortVersion(version: string | null | undefined): string | null {
  if (!version) return null;
  return version.replace(/^v?(\d+\.\d+\.\d+).*/, 'v$1');
}

export interface ClusterUsage {
  /** Percent of allocatable CPU in use, 0–100 (null when nothing is allocatable). */
  cpu: number | null;
  /** Percent of allocatable memory in use, 0–100. */
  memory: number | null;
}

/** Live CPU and memory use of a cluster; null without metrics-server. */
export function clusterUsage(overview: ClusterOverview | undefined): ClusterUsage | null {
  if (!overview?.usage) return null;
  const pct = (used: number, cap: number) =>
    cap > 0 ? Math.min(100, Math.max(0, (used / cap) * 100)) : null;
  return {
    cpu: pct(overview.usage.cpu_millicores, overview.allocatable.cpu_millicores),
    memory: pct(overview.usage.memory_bytes, overview.allocatable.memory_bytes),
  };
}

/**
 * Second line of an explorer row, in the order a Kubernetes user scans it:
 * distribution, server version and node readiness once connected, the
 * kubeconfig context before that (unless the row name already shows it).
 */
export function clusterDetail(
  cluster: Pick<ClusterDef, 'name' | 'context'>,
  status: ClusterStatus | undefined,
  overview: ClusterOverview | undefined,
): string[] {
  if (status?.state === 'connected') {
    const parts: string[] = [];
    const platform = status.platform ?? overview?.platform;
    const version = shortVersion(status.version ?? overview?.version);
    if (platform) parts.push(platform);
    if (version) parts.push(version);
    if (overview && overview.nodes.total > 0)
      parts.push(
        i18n.plural('{ready}/{count} node', '{ready}/{count} nodes', overview.nodes.total, {
          ready: i18n.number(overview.nodes.ready),
        }),
      );
    if (parts.length) return parts;
  }
  return cluster.context && cluster.context !== cluster.name ? [cluster.context] : [];
}
