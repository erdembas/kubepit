import * as i18n from '@/i18n/core';
import { useMemo } from 'react';
import { ENVIRONMENTS, connState, isLive } from '@/lib/clusterMeta';
import type { SidebarGroupBy, SidebarStatusFilter } from '@/store/useAppStore';
import type { ClusterDef, ClusterStatus, Section, SectionId } from '@/types';
import { clusterSearchText, matchesWorkspaceSearch } from './sidebarSearch';
import { itemKey, UNASSIGNED, type ClusterGroup } from './dnd';
import type { SidebarItem } from './SectionBody';

interface UseSidebarRailModelArgs {
  clusters: ClusterDef[];
  statuses: Record<string, ClusterStatus>;
  environmentFilter: string[];
  tagFilter: string[];
  sidebarStatusFilter: SidebarStatusFilter;
  groupBy: SidebarGroupBy;
  search: string;
  sections: Section[];
  clusterSection: Record<string, SectionId>;
  sectionItemOrder: Record<string, string[]>;
}

export function useSidebarRailModel({
  clusters,
  statuses,
  environmentFilter,
  tagFilter,
  sidebarStatusFilter,
  groupBy,
  search,
  sections,
  clusterSection,
  sectionItemOrder,
}: UseSidebarRailModelArgs) {
  const filteredClusters = useMemo(() => {
    const q = search.trim().toLowerCase();
    return clusters.filter((cluster) => {
      const live = isLive(connState(statuses[cluster.id]));
      if (sidebarStatusFilter === 'connected' && !live) return false;
      if (sidebarStatusFilter === 'disconnected' && live) return false;
      if (
        environmentFilter.length > 0 &&
        !environmentFilter.includes(cluster.environment ?? 'none')
      )
        return false;
      if (tagFilter.length > 0 && !tagFilter.every((tag) => cluster.tags.includes(tag)))
        return false;
      if (
        q &&
        !matchesWorkspaceSearch(
          q,
          clusterSearchText(
            cluster,
            sections,
            clusterSection[cluster.id],
            statuses[cluster.id]?.server,
          ),
        )
      )
        return false;
      return true;
    });
  }, [
    clusters,
    statuses,
    sidebarStatusFilter,
    environmentFilter,
    tagFilter,
    search,
    sections,
    clusterSection,
  ]);

  const itemsBySection = useMemo(() => {
    const validIds = new Set(sections.map((s) => s.id));
    const buckets = new Map<SectionId, SidebarItem[]>();
    for (const cluster of filteredClusters) {
      const assigned = clusterSection[cluster.id];
      const bucket = assigned && validIds.has(assigned) ? assigned : UNASSIGNED;
      const list = buckets.get(bucket);
      const item: SidebarItem = { kind: 'cluster', ref: cluster };
      if (list) list.push(item);
      else buckets.set(bucket, [item]);
    }
    for (const [bucket, list] of buckets) {
      const hint = sectionItemOrder[bucket] ?? [];
      const indexFor = new Map<string, number>();
      hint.forEach((key, index) => indexFor.set(key, index));
      list.sort((a, b) => {
        const ia = indexFor.get(itemKey(a.kind, a.ref.id));
        const ib = indexFor.get(itemKey(b.kind, b.ref.id));
        if (ia != null && ib != null) return ia - ib;
        if (ia != null) return -1;
        if (ib != null) return 1;
        return a.ref.name.localeCompare(b.ref.name);
      });
    }
    return buckets;
  }, [filteredClusters, clusterSection, sections, sectionItemOrder]);

  const totalsBySection = useMemo(() => {
    const out = new Map<SectionId, { running: number; total: number }>();
    for (const [bucket, list] of itemsBySection) {
      const running = list.filter((item) => isLive(connState(statuses[item.ref.id]))).length;
      out.set(bucket, { running, total: list.length });
    }
    return out;
  }, [itemsBySection, statuses]);

  const flatGroups = useMemo<ClusterGroup[]>(() => {
    if (groupBy === 'none') return [];
    if (groupBy === 'status') return groupByStatus(filteredClusters, statuses);
    if (groupBy === 'tag') return groupByTag(filteredClusters);
    return groupByEnvironment(filteredClusters);
  }, [filteredClusters, statuses, groupBy]);

  const connectedCount = clusters.filter(
    (cluster) => connState(statuses[cluster.id]) === 'connected',
  ).length;
  const hiddenCount = clusters.length - filteredClusters.length;

  return {
    filteredClusters,
    itemsBySection,
    totalsBySection,
    flatGroups,
    connectedCount,
    hiddenCount,
  };
}

const byName = (a: ClusterDef, b: ClusterDef) => a.name.localeCompare(b.name);

function groupByStatus(clusters: ClusterDef[], statuses: Record<string, ClusterStatus>) {
  const connected: ClusterDef[] = [];
  const failed: ClusterDef[] = [];
  const idle: ClusterDef[] = [];
  for (const cluster of clusters) {
    const state = connState(statuses[cluster.id]);
    if (isLive(state)) connected.push(cluster);
    else if (state === 'error') failed.push(cluster);
    else idle.push(cluster);
  }
  const out: ClusterGroup[] = [];
  if (connected.length)
    out.push({
      key: 'connected',
      label: i18n.t('Connected'),
      dot: 'bg-status-running',
      color: 'text-status-running',
      clusters: connected.sort(byName),
    });
  if (failed.length)
    out.push({
      key: 'error',
      label: i18n.t('Error'),
      dot: 'bg-status-error',
      color: 'text-status-error',
      clusters: failed.sort(byName),
    });
  if (idle.length)
    out.push({
      key: 'disconnected',
      label: i18n.t('Disconnected'),
      dot: 'bg-fg-dim/50',
      color: 'text-fg-dim',
      clusters: idle.sort(byName),
    });
  return out;
}

function groupByEnvironment(clusters: ClusterDef[]) {
  const out: ClusterGroup[] = [];
  for (const env of ENVIRONMENTS) {
    const list = clusters.filter((c) => c.environment === env.key).sort(byName);
    if (list.length)
      out.push({ key: env.key, label: env.label, dot: env.dot, color: env.color, clusters: list });
  }
  const rest = clusters.filter((c) => !c.environment).sort(byName);
  if (rest.length) out.push({ key: 'none', label: i18n.t('No environment'), clusters: rest });
  return out;
}

function groupByTag(clusters: ClusterDef[]) {
  const byTag = new Map<string, ClusterDef[]>();
  const untagged: ClusterDef[] = [];
  for (const cluster of clusters) {
    if (cluster.tags.length === 0) untagged.push(cluster);
    for (const tag of cluster.tags) {
      const list = byTag.get(tag);
      if (list) list.push(cluster);
      else byTag.set(tag, [cluster]);
    }
  }
  const out: ClusterGroup[] = [...byTag.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, list]) => ({ key: `tag:${tag}`, label: `#${tag}`, clusters: list.sort(byName) }));
  if (untagged.length)
    out.push({ key: 'untagged', label: i18n.t('Untagged'), clusters: untagged.sort(byName) });
  return out;
}
