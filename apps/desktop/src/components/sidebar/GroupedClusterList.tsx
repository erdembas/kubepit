import * as i18n from '@/i18n';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { ClusterRow } from './ClusterRow';
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
        return (
          <section key={group.key} className="animate-slide-in">
            <header
              onClick={() => onToggleGroup(group.key)}
              className="hover:bg-surface-overlay/40 sticky top-0 z-10 flex cursor-pointer items-center gap-2 bg-transparent py-1 pr-4 pl-3 backdrop-blur-[2px]"
            >
              <ChevronDown
                className={cn(
                  'text-fg-dim h-3 w-3 transition-transform',
                  collapsed && '-rotate-90',
                )}
              />
              {group.dot && (
                <span className={cn('h-1.5 w-1.5 rounded-full', group.dot)} aria-hidden />
              )}
              <span
                className={cn(
                  'text-[10.5px] font-semibold tracking-[0.14em] uppercase',
                  group.color ?? 'text-fg-dim',
                )}
              >
                {group.label}
              </span>
              <span className="text-fg-dim bg-surface-muted rounded-app-sm ml-auto px-1.5 text-[10px] tabular-nums">
                {group.clusters.length}
              </span>
            </header>
            {!collapsed && (
              <ul className="mx-2 my-1 space-y-0.5">
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
