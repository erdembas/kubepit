import * as i18n from '@/i18n';
import { connState, isLive } from '@/lib/clusterMeta';
import { ClusterRow } from './ClusterRow';
import { TreeGroupHeader } from './TreeGroupHeader';
import type { ClusterGroup } from './dnd';
import type { ClusterDef, ClusterStatus, SectionId } from '@/types';

interface GroupedClusterListProps {
  groups: ClusterGroup[];
  collapsedGroups: Set<string>;
  statuses: Record<string, ClusterStatus>;
  selectedClusterId: string | null;
  clusterSection: Record<string, SectionId>;
  onToggleGroup: (key: string) => void;
  onSelect: (id: string) => void;
  onEdit: (cluster: ClusterDef) => void;
  onDelete: (cluster: ClusterDef) => void;
}

/** Flat list grouped by a derived key (environment, status, tag). Order is not user-editable. */
export function GroupedClusterList({
  groups,
  collapsedGroups,
  statuses,
  selectedClusterId,
  clusterSection,
  onToggleGroup,
  onSelect,
  onEdit,
  onDelete,
}: GroupedClusterListProps) {
  i18n.useLocale();
  return (
    <>
      {groups.map((group) => {
        const collapsed = collapsedGroups.has(group.key);
        const running = group.clusters.filter((c) => isLive(connState(statuses[c.id]))).length;
        return (
          <section key={group.key} className="animate-slide-in mx-2 mb-1">
            <TreeGroupHeader
              label={group.label}
              dotClass={group.dot}
              collapsed={collapsed}
              onToggle={() => onToggleGroup(group.key)}
              total={group.clusters.length}
              running={running}
            />
            {!collapsed && (
              <ul className="border-border/50 ml-3.5 space-y-px border-l pb-1 pl-1">
                {group.clusters.map((cluster) => (
                  <li key={cluster.id}>
                    <ClusterRow
                      cluster={cluster}
                      status={statuses[cluster.id]}
                      selected={selectedClusterId === cluster.id}
                      currentSectionId={clusterSection[cluster.id] ?? null}
                      onSelect={() => onSelect(cluster.id)}
                      onEdit={() => onEdit(cluster)}
                      onDelete={() => onDelete(cluster)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </>
  );
}
