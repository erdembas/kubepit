import * as i18n from '@/i18n';
import { useRef, useState } from 'react';
import {
  Copy,
  FolderInput,
  LayoutDashboard,
  Lock,
  MoreHorizontal,
  Pencil,
  Plug,
  SquareTerminal,
  Trash2,
  Unplug,
} from 'lucide-react';
import { MoveToSectionMenu } from '../MoveToSectionMenu';
import { copyText } from '@/components/workbench/util';
import { FileContextMenu, type FileContextMenuEntry } from '@/components/ui/FileContextMenu';
import { IconButton } from '@/components/ui/IconButton';
import { connectCluster, disconnectCluster, openAndConnect } from '@/lib/clusterActions';
import { connState, environmentMeta, isLive } from '@/lib/clusterMeta';
import { cn } from '@/lib/cn';
import { formatPercent } from '@/lib/format';
import { usageBarClass } from '@/lib/resourceTone';
import { useAppStore } from '@/store/useAppStore';
import { dock } from '@/store/useDockStore';
import { ClusterGlyph } from './ClusterGlyph';
import { beginDrag, endDrag } from './dnd';
import { clusterDetail, clusterUsage } from './explorerMeta';
import type { ClusterDef, ClusterStatus, SectionId } from '@/types';

/** Open the cluster tab with a kubectl shell in its dock. */
function openClusterTerminal(cluster: ClusterDef) {
  openAndConnect(cluster.id);
  dock.shell(cluster.id, cluster.name);
}

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
  const overview = useAppStore((s) => s.overviews[cluster.id]);
  const state = connState(status);
  const live = isLive(state);
  const env = environmentMeta(cluster.environment);
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [moving, setMoving] = useState(false);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const menuWasOpen = useRef(false);
  // Keep the row lit and its actions shown while one of its menus is open.
  const active = menu !== null || moving;

  const detail = clusterDetail(cluster, status, overview);
  const usage = live ? clusterUsage(overview) : null;
  const showSecondLine = live || state === 'error' || selected;

  const openMenuAt = (x: number, y: number) => setMenu({ x, y });
  const openMenuFromButton = () => {
    const rect = moreRef.current?.getBoundingClientRect();
    if (rect) openMenuAt(rect.left, rect.bottom + 4);
  };

  const menuItems: FileContextMenuEntry[] = [
    {
      id: 'open',
      label: i18n.t('Open workbench'),
      icon: <LayoutDashboard size={12} />,
      onClick: onSelect,
    },
    live
      ? {
          id: 'disconnect',
          label: i18n.t('Disconnect'),
          icon: <Unplug size={12} />,
          onClick: () => void disconnectCluster(cluster.id),
        }
      : {
          id: 'connect',
          label: i18n.t('Connect'),
          icon: <Plug size={12} />,
          onClick: () => void connectCluster(cluster.id),
        },
    {
      id: 'terminal',
      label: i18n.t('Open cluster terminal'),
      icon: <SquareTerminal size={12} />,
      hint: 'kubectl',
      onClick: () => openClusterTerminal(cluster),
    },
    { id: 'sep-1', separator: true },
    {
      id: 'copy',
      label: i18n.t('Copy context name'),
      icon: <Copy size={12} />,
      onClick: () => void copyText(cluster.context, cluster.context),
    },
    {
      id: 'move',
      label: i18n.t('Move to section'),
      icon: <FolderInput size={12} />,
      onClick: () => setMoving(true),
    },
    {
      id: 'edit',
      label: i18n.t('Edit cluster'),
      icon: <Pencil size={12} />,
      onClick: onEdit,
    },
    { id: 'sep-2', separator: true },
    {
      id: 'remove',
      label: i18n.t('Remove cluster'),
      icon: <Trash2 size={12} />,
      tone: 'danger',
      onClick: onDelete,
    },
  ];

  const tooltip = [
    status?.error ?? null,
    cluster.context !== cluster.name ? cluster.context : null,
    status?.server ?? null,
    cluster.tags.length ? cluster.tags.map((tag) => `#${tag}`).join(' ') : null,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div
      draggable
      // The menus are portals: their events bubble here through the React
      // tree, but they must not drag or re-open the row.
      onDragStart={(e) => {
        if (!e.currentTarget.contains(e.target as Node)) return;
        beginDrag(e, 'cluster', cluster.id);
        setDragging(true);
      }}
      onDragEnd={(e) => {
        if (!e.currentTarget.contains(e.target as Node)) return;
        endDrag();
        setDragging(false);
      }}
      onContextMenu={(e) => {
        if (!e.currentTarget.contains(e.target as Node)) return;
        e.preventDefault();
        openMenuAt(e.clientX, e.clientY);
      }}
      className={cn('group relative', dragging && 'opacity-40')}
    >
      <button
        type="button"
        data-explorer-item={cluster.id}
        aria-current={selected ? 'page' : undefined}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            openMenuAt(rect.left + 24, rect.bottom);
          }
        }}
        title={tooltip || undefined}
        // `group-*` so the row stays lit while the pointer is over its actions.
        className={cn(
          'relative flex w-full items-start gap-2 rounded-md py-[5px] pr-2 pl-2 text-left transition-colors',
          selected
            ? 'bg-fg/7 text-fg group-has-[:focus-visible]:bg-fg/10'
            : 'text-fg-muted group-hover:bg-fg/4 group-hover:text-fg group-has-[:focus-visible]:bg-fg/5 group-has-[:focus-visible]:text-fg',
          active && !selected && 'bg-fg/4 text-fg',
        )}
      >
        {selected && (
          <span
            className="bg-accent absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full"
            aria-hidden
          />
        )}
        <span className="flex h-[18px] items-center">
          <ClusterGlyph cluster={cluster} state={state} dim={!live && !selected} />
        </span>
        <span className="min-w-0 flex-1">
          {/* Room for the hover actions, so they never cover the name. */}
          <span
            className={cn(
              'flex h-[18px] min-w-0 items-center gap-1.5 group-hover:pr-11 group-has-[:focus-visible]:pr-11',
              active && 'pr-11',
            )}
          >
            <span
              className={cn(
                'min-w-0 truncate text-[12.5px] leading-[18px]',
                selected && 'font-medium',
              )}
            >
              {cluster.name}
            </span>
            {cluster.read_only && (
              <Lock className="text-fg-dim h-3 w-3 shrink-0" aria-label={i18n.t('Read-only')} />
            )}
            {env && (
              <span
                className={cn(
                  'bg-fg/4 ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-[9px] leading-none font-medium tracking-wide group-hover:hidden group-has-[:focus-visible]:hidden',
                  env.color,
                  active && 'hidden',
                )}
              >
                {env.short}
              </span>
            )}
          </span>
          {showSecondLine && (
            <span className="flex min-w-0 items-center gap-2 text-[10.5px] leading-4">
              {state === 'error' ? (
                <span className="text-status-error/90 min-w-0 truncate">
                  {status?.error ?? i18n.t('Error')}
                </span>
              ) : state === 'connecting' ? (
                <span className="text-fg-dim min-w-0 truncate">{i18n.t('Connecting…')}</span>
              ) : (
                <span className="text-fg-dim min-w-0 flex-1 truncate font-mono">
                  {detail.join(' · ')}
                </span>
              )}
              {usage && <UsageBars cpu={usage.cpu} memory={usage.memory} />}
            </span>
          )}
        </span>
      </button>

      <div
        className={cn(
          'invisible absolute top-px right-1 flex items-center group-hover:visible group-has-[:focus-visible]:visible',
          active && 'visible',
        )}
      >
        {live ? (
          <IconButton
            label={i18n.t('Open cluster terminal')}
            icon={<SquareTerminal />}
            size="xs"
            onClick={() => openClusterTerminal(cluster)}
          />
        ) : (
          <IconButton
            label={i18n.t('Connect')}
            icon={<Plug />}
            size="xs"
            tone="accent"
            onClick={() => void connectCluster(cluster.id)}
          />
        )}
        <IconButton
          ref={moreRef}
          label={i18n.t('Cluster actions')}
          icon={<MoreHorizontal />}
          size="xs"
          aria-haspopup="menu"
          aria-expanded={!!menu}
          // The menu closes on this very mousedown; a click then must not reopen it.
          onPointerDown={() => {
            menuWasOpen.current = menu !== null;
          }}
          onClick={() => {
            if (menuWasOpen.current) menuWasOpen.current = false;
            else openMenuFromButton();
          }}
        />
      </div>

      {menu && (
        <FileContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
      <MoveToSectionMenu
        itemId={cluster.id}
        currentSectionId={currentSectionId}
        open={moving}
        onOpenChange={setMoving}
        anchorRef={moreRef}
      />
    </div>
  );
}

function UsageBars({ cpu, memory }: { cpu: number | null; memory: number | null }) {
  i18n.useLocale();
  const bars = [
    { key: 'cpu', value: cpu },
    { key: 'memory', value: memory },
  ];
  return (
    <span
      className="flex shrink-0 items-center gap-1"
      title={i18n.t('CPU {cpu} · Memory {memory}', {
        cpu: cpu == null ? '—' : formatPercent(cpu),
        memory: memory == null ? '—' : formatPercent(memory),
      })}
    >
      {bars.map((bar) => (
        <span key={bar.key} className="bg-fg/10 h-[3px] w-4 overflow-hidden rounded-full">
          {bar.value != null && (
            <span
              className={cn('block h-full rounded-full', usageBarClass(bar.value))}
              style={{ width: `${Math.max(bar.value, 4)}%` }}
            />
          )}
        </span>
      ))}
    </span>
  );
}
