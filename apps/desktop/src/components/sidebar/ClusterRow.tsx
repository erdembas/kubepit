import * as i18n from '@/i18n';
import { useState } from 'react';
import { GripVertical, Lock, Pencil, Plug, Trash2, Unplug } from 'lucide-react';
import { MoveToSectionMenu } from '../MoveToSectionMenu';
import { IconButton } from '@/components/ui/IconButton';
import { connectCluster, disconnectCluster } from '@/lib/clusterActions';
import { connState, environmentMeta, isLive } from '@/lib/clusterMeta';
import { cn } from '@/lib/cn';
import { beginDrag, endDrag } from './dnd';
import type { ClusterDef, ClusterStatus, SectionId } from '@/types';

export function ClusterRow({
  cluster,
  status,
  selected,
  currentSectionId,
  onSelect,
  onEdit,
  onDelete,
}: {
  cluster: ClusterDef;
  status: ClusterStatus | undefined;
  selected: boolean;
  currentSectionId: SectionId | null;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  i18n.useLocale();
  const state = connState(status);
  const live = isLive(state);
  const env = environmentMeta(cluster.environment);
  const [dragging, setDragging] = useState(false);

  const dotClass =
    state === 'error' ? 'bg-status-error' : live ? 'bg-status-running' : 'bg-fg-dim/50';
  const dotAnim = state === 'connecting' ? 'animate-pulse-dot' : live ? 'animate-breathe' : '';

  return (
    <div
      onClick={onSelect}
      draggable
      onDragStart={(e) => {
        beginDrag(e, 'cluster', cluster.id);
        setDragging(true);
      }}
      onDragEnd={() => {
        endDrag();
        setDragging(false);
      }}
      title={status?.error ?? undefined}
      className={cn(
        'group relative cursor-grab rounded-lg py-1.5 pr-2 pl-0.5 transition-colors active:cursor-grabbing',
        selected ? 'bg-fg/6 text-fg' : 'text-fg-muted hover:bg-fg/4 hover:text-fg',
        dragging && 'opacity-40',
      )}
    >
      {selected && (
        <span className="bg-accent absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full" />
      )}

      <div className="relative flex items-center gap-1.5">
        <GripVertical
          className="text-fg-dim/60 h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden
        />
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotClass, dotAnim)} aria-hidden />
        <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', selected && 'font-medium')}>
          {cluster.name}
        </span>

        <div className="relative flex h-6 shrink-0 items-center justify-end">
          <div
            className={cn(
              'flex items-center gap-1.5 transition-opacity',
              selected
                ? 'pointer-events-none absolute inset-y-0 right-0 opacity-0'
                : 'static opacity-100 group-hover:pointer-events-none group-hover:absolute group-hover:inset-y-0 group-hover:right-0 group-hover:opacity-0',
            )}
          >
            {cluster.read_only && (
              <Lock className="text-fg-dim h-3 w-3" aria-label={i18n.t('Read-only')} />
            )}
            {env && (
              <span
                className={cn('bg-fg/4 rounded-md px-1.5 py-0.5 text-[9px] font-medium', env.color)}
              >
                {env.short}
              </span>
            )}
          </div>

          <div
            className={cn(
              'flex items-center gap-0 transition-opacity',
              selected
                ? 'static opacity-100'
                : 'pointer-events-none absolute inset-y-0 right-0 opacity-0 group-hover:pointer-events-auto group-hover:static group-hover:opacity-100',
            )}
          >
            {!selected &&
              (live ? (
                <IconButton
                  label={i18n.t('Disconnect')}
                  icon={<Unplug />}
                  size="xs"
                  tone="danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    void disconnectCluster(cluster.id);
                  }}
                />
              ) : (
                <IconButton
                  label={i18n.t('Connect')}
                  icon={<Plug />}
                  size="xs"
                  tone="accent"
                  onClick={(e) => {
                    e.stopPropagation();
                    void connectCluster(cluster.id);
                  }}
                />
              ))}
            <MoveToSectionMenu itemId={cluster.id} currentSectionId={currentSectionId} />
            <IconButton
              label={i18n.t('Edit')}
              icon={<Pencil />}
              size="xs"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
            />
            {!selected && (
              <IconButton
                label={i18n.t('Remove')}
                icon={<Trash2 />}
                size="xs"
                tone="danger"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
              />
            )}
          </div>
        </div>
      </div>

      {selected && (status?.version || cluster.tags.length > 0) && (
        <div className="text-fg-dim mt-0.5 ml-3.5 flex min-w-0 items-center gap-2 text-[10.5px]">
          {status?.platform && (
            <span className="text-accent shrink-0 font-medium">{status.platform}</span>
          )}
          {status?.version && (
            <span className="shrink-0 font-mono tabular-nums">
              {status.version.replace(/^v?(\d+\.\d+\.\d+).*/, 'v$1')}
            </span>
          )}
          {cluster.tags.length > 0 && (
            <span className="min-w-0 truncate">{cluster.tags.map((t) => `#${t}`).join(' ')}</span>
          )}
        </div>
      )}
    </div>
  );
}
