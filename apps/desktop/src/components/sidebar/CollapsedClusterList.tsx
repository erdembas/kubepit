import * as i18n from '@/i18n';
import { connState, isLive } from '@/lib/clusterMeta';
import { cn } from '@/lib/cn';
import type { ClusterDef, ClusterStatus } from '@/types';
import { ClusterGlyph } from './ClusterGlyph';

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
        return (
          <button
            key={cluster.id}
            type="button"
            title={cluster.name}
            aria-label={cluster.name}
            aria-pressed={selected}
            onClick={() => onSelect(cluster.id)}
            className={cn(
              'hover:bg-fg/4 relative flex h-8 w-8 items-center justify-center rounded-md transition',
              selected && 'bg-fg/7',
            )}
          >
            {selected && (
              <span
                className="bg-accent absolute top-1.5 bottom-1.5 -left-[9px] w-[2px] rounded-full"
                aria-hidden
              />
            )}
            <ClusterGlyph
              cluster={cluster}
              state={state}
              size="md"
              dim={!isLive(state) && !selected}
            />
          </button>
        );
      })}
    </div>
  );
}
