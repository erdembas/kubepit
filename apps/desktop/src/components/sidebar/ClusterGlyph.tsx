import { clusterColor, clusterInitials } from '@/lib/clusterMeta';
import { cn } from '@/lib/cn';
import type { ClusterDef, ConnState } from '@/types';

/** Cluster avatar with its connection state as a corner dot (explorer rows and the hotbar). */
export function ClusterGlyph({
  cluster,
  state,
  size = 'sm',
  dim = false,
}: {
  cluster: Pick<ClusterDef, 'id' | 'name' | 'color'>;
  state: ConnState;
  size?: 'sm' | 'md';
  dim?: boolean;
}) {
  return (
    <span aria-hidden className="relative inline-flex shrink-0">
      <span
        className={cn(
          'flex items-center justify-center font-bold tracking-tight text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)] transition-opacity',
          size === 'md'
            ? 'h-6 w-6 rounded-[6px] text-[10px]'
            : 'h-[18px] w-[18px] rounded-[5px] text-[8px]',
        )}
        style={{ backgroundColor: clusterColor(cluster), opacity: dim ? 0.55 : 1 }}
      >
        {clusterInitials(cluster.name)}
      </span>
      {state !== 'disconnected' && (
        <span
          className={cn(
            'ring-surface-raised absolute rounded-full ring-2',
            size === 'md'
              ? '-right-0.5 -bottom-0.5 h-2 w-2'
              : '-right-[3px] -bottom-[3px] h-[7px] w-[7px]',
            state === 'error'
              ? 'bg-status-error'
              : state === 'connecting'
                ? 'bg-status-starting animate-pulse'
                : 'bg-status-running',
          )}
        />
      )}
    </span>
  );
}
