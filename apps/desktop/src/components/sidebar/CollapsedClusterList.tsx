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

/** Compact rail (sidebar collapsed): each cluster as an avatar over a small name, Lens-hotbar style. */
export function CollapsedClusterList({
  clusters,
  statuses,
  selectedClusterId,
  onSelect,
}: CollapsedClusterListProps) {
  i18n.useLocale();
  return (
    <div className="flex flex-col items-stretch gap-0.5 px-1 py-2">
      {clusters.map((cluster) => {
        const state = connState(statuses[cluster.id]);
        const selected = selectedClusterId === cluster.id;
        const live = isLive(state);
        return (
          <button
            key={cluster.id}
            type="button"
            title={cluster.name}
            aria-label={cluster.name}
            aria-pressed={selected}
            onClick={() => onSelect(cluster.id)}
            className={cn(
              'relative flex flex-col items-center gap-1 rounded-md px-0.5 pt-1.5 pb-1 transition-colors',
              selected ? 'bg-fg/7 text-fg' : 'text-fg-muted hover:bg-fg/4 hover:text-fg',
            )}
          >
            {selected && (
              <span
                className="bg-accent absolute top-1.5 bottom-1.5 -left-1 w-[2px] rounded-full"
                aria-hidden
              />
            )}
            <ClusterGlyph cluster={cluster} state={state} size="md" dim={!live && !selected} />
            <span
              aria-hidden
              className={cn(
                'line-clamp-2 w-full text-center text-[9px] leading-[11px] break-words',
                selected && 'font-medium',
                !live && !selected && 'text-fg-dim',
              )}
            >
              {cluster.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}
