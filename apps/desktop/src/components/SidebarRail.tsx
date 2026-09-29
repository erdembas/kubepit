import * as i18n from '@/i18n';
import { useCallback, useEffect, useState } from 'react';
import { FileSearch, PanelLeftClose, Pin, Plus } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { openAndConnect, requestRemoveCluster } from '@/lib/clusterActions';
import { cn } from '@/lib/cn';
import { modChord } from '@/lib/platform';
import { IconButton } from '@/components/ui/IconButton';
import type { ClusterDef } from '@/types';
import { ClusterFilterInput, ClustersHeader } from './sidebar/ClustersHeader';
import { FleetNav, SettingsNavRow } from './sidebar/FleetNav';
import {
  CollapsedClusterList,
  GroupedClusterList,
  SidebarSectionLayout,
  COLLAPSED_W,
  getActiveDrag,
  useSidebarRailModel,
  useSidebarRailResize,
} from './sidebar';

/**
 * Left explorer: fleet destinations on top, then the cluster tree (sections or
 * a derived grouping). Unpinned it folds into a hotbar of cluster avatars.
 */
export function SidebarRail() {
  i18n.useLocale();
  const clusters = useAppStore((s) => s.clusters);
  const statuses = useAppStore((s) => s.statuses);
  const selectedClusterId = useAppStore((s) => s.selectedClusterId);
  const environmentFilter = useAppStore((s) => s.environmentFilter);
  const tagFilter = useAppStore((s) => s.tagFilter);
  const sidebarStatusFilter = useAppStore((s) => s.sidebarStatusFilter);
  const groupBy = useAppStore((s) => s.sidebarGroupBy);
  const search = useAppStore((s) => s.search);
  const openClusterEditor = useAppStore((s) => s.openClusterEditor);
  const sections = useAppStore((s) => s.sections);
  const clusterSection = useAppStore((s) => s.clusterSection);
  const collapsedSections = useAppStore((s) => s.collapsedSections);
  const sectionItemOrder = useAppStore((s) => s.sectionItemOrder);
  const toggleSectionCollapsed = useAppStore((s) => s.toggleSectionCollapsed);
  const pinned = useAppStore((s) => s.sidebarPinned);
  const setPinned = useAppStore((s) => s.setSidebarPinned);
  const [hovered, setHovered] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const { width, onResizeStart, onResizeMove, onResizeEnd } = useSidebarRailResize();

  const expanded = pinned || hovered;

  // Let native drag-and-drop land anywhere inside the rail.
  useEffect(() => {
    const onDoc = (e: globalThis.DragEvent) => {
      if (getActiveDrag() == null) return;
      e.preventDefault();
    };
    document.addEventListener('dragover', onDoc);
    document.addEventListener('dragenter', onDoc);
    return () => {
      document.removeEventListener('dragover', onDoc);
      document.removeEventListener('dragenter', onDoc);
    };
  }, []);

  const {
    filteredClusters,
    itemsBySection,
    totalsBySection,
    flatGroups,
    connectedCount,
    hiddenCount,
  } = useSidebarRailModel({
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
  });
  const currentWidth = expanded ? width : COLLAPSED_W;
  const useSectionLayout = groupBy === 'none';

  const toggleGroupCollapsed = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const onEdit = useCallback(
    (cluster: ClusterDef) => openClusterEditor({ mode: 'edit', cluster }),
    [openClusterEditor],
  );

  // Arrows walk the explorer rows (fleet items and clusters); Enter opens one.
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if ((e.target as HTMLElement).closest('input')) return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-explorer-item]')];
    const current = rows.findIndex((row) => row === document.activeElement);
    if (current < 0) return;
    e.preventDefault();
    const next = Math.max(0, Math.min(rows.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1)));
    rows[next]?.focus();
  };

  return (
    <aside
      aria-label={i18n.t('Explorer')}
      className="chrome-gradient border-border/70 bg-surface-raised relative flex h-full shrink-0 flex-col border-r"
      style={{ width: currentWidth }}
      onMouseEnter={() => {
        if (!pinned) setHovered(true);
      }}
      onMouseLeave={() => {
        if (!pinned) setHovered(false);
      }}
      onKeyDown={onKeyDown}
    >
      <div
        data-tauri-drag-region
        className={cn(
          'border-border/60 flex h-9 shrink-0 items-center gap-2 border-b',
          expanded ? 'justify-between pr-2 pl-4' : 'justify-center',
        )}
      >
        {expanded && (
          <span className="text-fg-muted text-[10.5px] font-semibold tracking-[0.18em] uppercase">
            {i18n.t('Explorer')}
          </span>
        )}
        <IconButton
          label={
            pinned
              ? i18n.t('Collapse sidebar ({shortcut})', { shortcut: modChord('B') })
              : i18n.t('Pin sidebar open ({shortcut})', { shortcut: modChord('B') })
          }
          icon={pinned ? <PanelLeftClose /> : <Pin />}
          size="xs"
          onClick={() => setPinned(!pinned)}
        />
      </div>

      <FleetNav expanded={expanded} />

      {expanded && (
        <div className="border-border/60 shrink-0 border-t pt-1">
          <ClustersHeader clustersCount={clusters.length} connectedCount={connectedCount} />
          {clusters.length > 0 && <ClusterFilterInput />}
          {hiddenCount > 0 && (
            <p className="text-fg-dim mx-4 mb-1 text-[10.5px]">
              {i18n.t('Showing {shown} · {hiddenCount} hidden', {
                shown: filteredClusters.length,
                hiddenCount,
              })}
            </p>
          )}
        </div>
      )}

      <div
        className={cn(
          'overlay-scroll min-h-0 flex-1 overflow-x-hidden',
          !expanded && 'border-border/60 border-t',
        )}
      >
        {!expanded && (
          <CollapsedClusterList
            clusters={clusters}
            statuses={statuses}
            selectedClusterId={selectedClusterId}
            onSelect={openAndConnect}
          />
        )}

        {expanded && (
          <>
            {clusters.length === 0 ? (
              <EmptyExplorer
                onAddCluster={() => openClusterEditor({ mode: 'add' })}
                onDiscover={() => useAppStore.getState().setImportDialogOpen(true)}
              />
            ) : useSectionLayout ? (
              <div className="pb-3">
                <SidebarSectionLayout
                  searching={!!search.trim()}
                  sections={sections}
                  itemsBySection={itemsBySection}
                  hasSections={sections.length > 0}
                  collapsedSections={collapsedSections}
                  totalsBySection={totalsBySection}
                  statuses={statuses}
                  selectedClusterId={selectedClusterId}
                  clusterSection={clusterSection}
                  onToggleSection={toggleSectionCollapsed}
                  onSelect={openAndConnect}
                  onEdit={onEdit}
                  onDelete={requestRemoveCluster}
                  emptyMessage={hiddenCount > 0 ? i18n.t('No matches for this filter.') : undefined}
                />
              </div>
            ) : flatGroups.length === 0 ? (
              <p className="text-fg-dim px-4 py-6 text-center text-[12px]">
                {i18n.t('No matches for this filter.')}
              </p>
            ) : (
              <div className="pb-3">
                <GroupedClusterList
                  groups={flatGroups}
                  collapsedGroups={search.trim() ? new Set() : collapsedGroups}
                  statuses={statuses}
                  selectedClusterId={selectedClusterId}
                  clusterSection={clusterSection}
                  onToggleGroup={toggleGroupCollapsed}
                  onSelect={openAndConnect}
                  onEdit={onEdit}
                  onDelete={requestRemoveCluster}
                />
              </div>
            )}
          </>
        )}
      </div>

      <SettingsNavRow expanded={expanded} />
      <div
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        className="group absolute top-0 right-0 bottom-0 z-30 w-2 cursor-col-resize"
      >
        <div className="group-hover:bg-accent/30 group-active:bg-accent/50 absolute top-0 right-0 bottom-0 w-[2px] transition-colors" />
      </div>
    </aside>
  );
}

function EmptyExplorer({
  onAddCluster,
  onDiscover,
}: {
  onAddCluster: () => void;
  onDiscover: () => void;
}) {
  i18n.useLocale();
  const action =
    'border-border/80 bg-surface-raised text-fg hover:bg-surface-overlay hover:border-border-strong rounded-app-sm flex w-full items-center gap-2 border px-2.5 py-1.5 text-left text-[11.5px] font-medium shadow-sm transition';
  return (
    <div className="px-4 py-4">
      <p className="text-fg-dim mb-3 text-[11.5px] leading-relaxed">
        {i18n.t('No clusters yet. Add a kubeconfig context to start exploring.')}
      </p>
      <div className="space-y-1.5">
        <button type="button" className={action} onClick={onDiscover}>
          <FileSearch className="text-fg-dim h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{i18n.t('Discover kubeconfig contexts')}</span>
        </button>
        <button type="button" className={action} onClick={onAddCluster}>
          <Plus className="text-fg-dim h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{i18n.t('Add cluster')}</span>
          <span className="text-fg-dim font-mono text-[10px]">{modChord('N')}</span>
        </button>
      </div>
    </div>
  );
}
