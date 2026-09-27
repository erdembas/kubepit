import * as i18n from '@/i18n';
import { clusterColor, clusterInitials, connState, isLive } from '@/lib/clusterMeta';
import { cn } from '@/lib/cn';
import type { ClusterDef, ClusterStatus } from '@/types';

interface CollapsedClusterListProps {
  clusters: ClusterDef[];
  statuses: Record<string, ClusterStatus>;
  selectedClusterId: string | null;
  onSelect: (id: string) => void;
}

/** Icon-only rail (sidebar collapsed): one avatar per cluster, Lens-hotbar style. */
export function CollapsedClusterList({
  clusters,
  statuses,
  selectedClusterId,
  onSelect,
}: CollapsedClusterListProps) {
  i18n.useLocale();
  return (
    <div className="flex flex-col items-center gap-1 py-2">
      {clusters.map((cluster) => {
        const state = connState(statuses[cluster.id]);
        const selected = selectedClusterId === cluster.id;
        const live = isLive(state);
        return (
          <button
            key={cluster.id}
            type="button"
            title={cluster.name}
            aria-pressed={selected}
            onClick={() => onSelect(cluster.id)}
            className={cn(
              'hover:bg-fg/4 relative flex h-8 w-8 items-center justify-center rounded-md transition',
              selected && 'bg-fg/6',
            )}
          >
            <span
              className="flex h-6 w-6 items-center justify-center rounded-[6px] text-[10px] font-bold text-white"
              style={{
                backgroundColor: clusterColor(cluster),
                opacity: live || selected ? 1 : 0.55,
              }}
            >
              {clusterInitials(cluster.name)}
            </span>
            {state !== 'disconnected' && (
              <span
                className={cn(
                  'ring-surface-raised absolute right-0.5 bottom-0.5 h-2 w-2 rounded-full ring-2',
                  state === 'error'
                    ? 'bg-status-error'
                    : state === 'connecting'
                      ? 'bg-status-starting animate-pulse'
                      : 'bg-status-running',
                )}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
