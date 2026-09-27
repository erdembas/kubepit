import * as i18n from '@/i18n/core';
import { ENVIRONMENTS, connState } from '@/lib/clusterMeta';
import type { ClusterDef, ClusterOverview, ClusterStatus, Section } from '@/types';

export type FleetTone = 'critical' | 'warning' | 'running' | 'idle';

export interface FleetStats {
  connected: number;
  connecting: number;
  offline: number;
  failing: number;
}

export interface FleetTotals {
  nodes: number;
  nodesReady: number;
  pods: number;
  podsRunning: number;
  podsFailed: number;
  podsPending: number;
  warnings: number;
  cpuUsage: number;
  cpuAllocatable: number;
  memUsage: number;
  memAllocatable: number;
  metricsClusters: number;
}

export interface HeroState {
  count?: number;
  label: string;
  tone: FleetTone;
}

export const TONE_CLASSES: Record<FleetTone, { dot: string; count: string; backdrop?: string }> = {
  critical: {
    dot: 'bg-status-error',
    count: 'text-status-error',
    backdrop: 'rgb(var(--status-error) / 0.08)',
  },
  warning: {
    dot: 'bg-status-starting',
    count: 'text-status-starting',
    backdrop: 'rgb(var(--status-starting) / 0.07)',
  },
  running: {
    dot: 'bg-status-running',
    count: 'text-status-running',
    backdrop: 'rgb(var(--accent) / 0.07)',
  },
  idle: { dot: 'bg-fg-dim/50', count: 'text-fg' },
};

export function fleetStats(clusters: ClusterDef[], statuses: Record<string, ClusterStatus>) {
  const stats: FleetStats = { connected: 0, connecting: 0, offline: 0, failing: 0 };
  for (const cluster of clusters) {
    const state = connState(statuses[cluster.id]);
    if (state === 'connected') stats.connected++;
    else if (state === 'connecting') stats.connecting++;
    else if (state === 'error') stats.failing++;
    else stats.offline++;
  }
  return stats;
}

export function fleetTotals(
  clusters: ClusterDef[],
  statuses: Record<string, ClusterStatus>,
  overviews: Record<string, ClusterOverview>,
): FleetTotals {
  const totals: FleetTotals = {
    nodes: 0,
    nodesReady: 0,
    pods: 0,
    podsRunning: 0,
    podsFailed: 0,
    podsPending: 0,
    warnings: 0,
    cpuUsage: 0,
    cpuAllocatable: 0,
    memUsage: 0,
    memAllocatable: 0,
    metricsClusters: 0,
  };
  for (const cluster of clusters) {
    const overview = overviews[cluster.id];
    if (!overview || statuses[cluster.id]?.state !== 'connected') continue;
    totals.nodes += overview.nodes.total;
    totals.nodesReady += overview.nodes.ready;
    totals.pods += overview.pods.total;
    totals.podsRunning += overview.pods.running;
    totals.podsFailed += overview.pods.failed;
    totals.podsPending += overview.pods.pending;
    totals.warnings += overview.warnings.length;
    if (overview.usage) {
      totals.metricsClusters++;
      totals.cpuUsage += overview.usage.cpu_millicores;
      totals.memUsage += overview.usage.memory_bytes;
      totals.cpuAllocatable += overview.allocatable.cpu_millicores;
      totals.memAllocatable += overview.allocatable.memory_bytes;
    }
  }
  return totals;
}

/** The dashboard headline answers "what needs my attention across the fleet?". */
export function heroState(stats: FleetStats, totals: FleetTotals): HeroState {
  if (stats.failing > 0)
    return {
      count: stats.failing,
      label: stats.failing === 1 ? i18n.t('cluster unreachable') : i18n.t('clusters unreachable'),
      tone: 'critical',
    };
  if (totals.podsFailed > 0)
    return {
      count: totals.podsFailed,
      label: totals.podsFailed === 1 ? i18n.t('pod failing') : i18n.t('pods failing'),
      tone: 'warning',
    };
  if (stats.connected > 0)
    return {
      count: stats.connected,
      label: stats.connected === 1 ? i18n.t('cluster connected') : i18n.t('clusters connected'),
      tone: 'running',
    };
  if (stats.connecting > 0) return { label: i18n.t('Connecting…'), tone: 'idle' };
  return { label: i18n.t('All quiet'), tone: 'idle' };
}

export type DashboardGroupBy = 'sections' | 'environment' | 'none';

export interface DashGroup {
  key: string;
  label: string;
  dotClass?: string;
  dotStyle?: React.CSSProperties;
  labelClass?: string;
  clusters: ClusterDef[];
}

export function groupClusters(
  clusters: ClusterDef[],
  groupBy: DashboardGroupBy,
  sections: Section[],
  clusterSection: Record<string, string>,
  sectionItemOrder: Record<string, string[]>,
  sectionColorOf: (section: Section) => string,
): DashGroup[] {
  if (groupBy === 'none')
    return [{ key: 'all', label: i18n.t('All clusters'), clusters: [...clusters] }];
  if (groupBy === 'environment') {
    const out: DashGroup[] = [];
    for (const env of ENVIRONMENTS) {
      const list = clusters.filter((c) => c.environment === env.key);
      if (list.length)
        out.push({
          key: env.key,
          label: env.label,
          dotClass: env.dot,
          labelClass: env.color,
          clusters: list,
        });
    }
    const rest = clusters.filter((c) => !c.environment);
    if (rest.length) out.push({ key: 'none', label: i18n.t('No environment'), clusters: rest });
    return out;
  }
  const valid = new Set(sections.map((s) => s.id));
  const order = (bucket: string, list: ClusterDef[]) => {
    const hint = sectionItemOrder[bucket] ?? [];
    return [...list].sort((a, b) => {
      const ia = hint.indexOf(`cluster:${a.id}`);
      const ib = hint.indexOf(`cluster:${b.id}`);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return a.name.localeCompare(b.name);
    });
  };
  const out: DashGroup[] = sections
    .map((section) => ({
      key: section.id,
      label: section.name,
      dotStyle: { backgroundColor: sectionColorOf(section) },
      labelStyle: undefined,
      clusters: order(
        section.id,
        clusters.filter((c) => clusterSection[c.id] === section.id),
      ),
    }))
    .filter((group) => group.clusters.length > 0);
  const unassigned = clusters.filter((c) => {
    const s = clusterSection[c.id];
    return !s || !valid.has(s);
  });
  if (unassigned.length)
    out.push({
      key: '__unassigned__',
      label: sections.length ? i18n.t('Unassigned') : i18n.t('All clusters'),
      dotClass: 'bg-fg-dim/50',
      clusters: order('__unassigned__', unassigned),
    });
  return out;
}
