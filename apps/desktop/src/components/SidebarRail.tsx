import * as i18n from '@/i18n';
import { useCallback, useEffect, useState } from 'react';
import { Network, Search, Settings as SettingsIcon, X } from 'lucide-react';
import { useAppStore, PORT_FORWARDS_TAB_KEY } from '@/store/useAppStore';
import { openAndConnect, requestRemoveCluster } from '@/lib/clusterActions';
import { cn } from '@/lib/cn';
import type { ClusterDef } from '@/types';
import { SidebarSectionsHeader } from './sidebar/SidebarSectionsHeader';
import {
  WorkspaceHeader,
  CreateActionsFooter,
  CollapsedClusterList,
  GroupedClusterList,
  SidebarHomeButton,
  SidebarSectionLayout,
  COLLAPSED_W,
  getActiveDrag,
  useSidebarRailModel,
  useSidebarRailResize,
} from './sidebar';

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
  const setSearch = useAppStore((s) => s.setSearch);
  const goHome = useAppStore((s) => s.goHome);
  const openClusterEditor = useAppStore((s) => s.openClusterEditor);
  const setImportDialogOpen = useAppStore((s) => s.setImportDialogOpen);
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
  const onHomeSelected = useAppStore((s) => s.activeMainTabKey === 'dashboard:dashboard');
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

  return (
    <div
      className="chrome-gradient border-border/70 bg-surface-raised relative flex h-full shrink-0 flex-col border-r"
      style={{ width: currentWidth }}
      onMouseEnter={() => {
        if (!pinned) setHovered(true);
      }}
      onMouseLeave={() => {
        if (!pinned) setHovered(false);
      }}
    >
      <SidebarHomeButton
        expanded={expanded}
        pinned={pinned}
        selected={onHomeSelected}
        onSelect={goHome}
        onTogglePinned={() => setPinned(!pinned)}
      />

      <div className="overlay-scroll min-h-0 flex-1 overflow-x-hidden">
        {expanded && (
          <WorkspaceHeader clustersCount={clusters.length} connectedCount={connectedCount} />
        )}

        {expanded && (
          <div className="border-border/70 bg-surface/50 focus-within:border-accent/30 mx-3 mb-3 flex items-center gap-2 rounded-lg border px-2.5">
            <Search className="text-fg-dim h-3.5 w-3.5 shrink-0" />
            <input
              aria-label={i18n.t('Search clusters')}
              placeholder={i18n.t('Find clusters, tags, sections…')}
              className="text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent py-2 text-[11.5px] outline-none"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setSearch('');
                }
              }}
            />
            {search && (
              <button
                type="button"
                aria-label={i18n.t('Clear search')}
                className="text-fg-dim hover:text-fg p-0.5"
                onClick={() => setSearch('')}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        )}

        {expanded && <SidebarSectionsHeader />}

        {expanded && hiddenCount > 0 && (
          <div className="border-border/60 mx-3 mb-1 flex items-center gap-2 rounded-[6px] border border-dashed px-2 py-1">
            <span className="text-fg-dim text-[10.5px]">
              {i18n.t('Showing {shown} · {hiddenCount} hidden', {
                shown: filteredClusters.length,
                hiddenCount,
              })}
            </span>
          </div>
        )}

        {!expanded && (
          <CollapsedClusterList
            clusters={clusters}
            statuses={statuses}
            selectedClusterId={selectedClusterId}
            onSelect={openAndConnect}
          />
        )}

        {expanded && !useSectionLayout && flatGroups.length === 0 && (
          <div className="text-fg-dim px-3 py-6 text-center text-[12px]">
            {clusters.length === 0
              ? i18n.t('No clusters yet.')
              : i18n.t('No matches for this filter.')}
          </div>
        )}

        {expanded && !useSectionLayout && (
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
        )}

        {expanded && useSectionLayout && (
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
            emptyMessage={
              clusters.length === 0
                ? i18n.t('No clusters yet.')
                : hiddenCount > 0
                  ? i18n.t('No matches for this filter.')
                  : undefined
            }
          />
        )}
      </div>

      {expanded && (
        <CreateActionsFooter
          onAddCluster={() => openClusterEditor({ mode: 'add' })}
          onImport={() => setImportDialogOpen(true)}
        />
      )}

      <WorkspaceUtilities expanded={expanded} />
      <div
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        className="group absolute top-0 right-0 bottom-0 z-20 w-2 cursor-col-resize"
      >
        <div className="group-hover:bg-accent/30 group-active:bg-accent/50 absolute top-0 right-0 bottom-0 w-[2px] transition-colors" />
      </div>
    </div>
  );
}

/** Bottom utility row (RunHQ's WorkbenchUtilities): global port forwards and settings. */
function WorkspaceUtilities({ expanded }: { expanded: boolean }) {
  i18n.useLocale();
  const forwards = useAppStore((s) => s.portForwards.length);
  const activeKey = useAppStore((s) => s.activeMainTabKey);
  const openMainTab = useAppStore((s) => s.openMainTab);
  const openSettings = useAppStore((s) => s.openSettings);
  const item =
    'text-fg-muted hover:bg-fg/5 hover:text-fg flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px]';
  return (
    <div
      className={cn(
        'border-border/60 flex shrink-0 items-center justify-evenly gap-1 border-t px-2 py-2',
        !expanded && 'flex-col',
      )}
      aria-label={i18n.t('Workspace tools')}
    >
      <button
        type="button"
        onClick={() => openMainTab({ kind: 'port-forwards' })}
        title={i18n.t('Port forwards')}
        aria-label={i18n.t('Port forwards')}
        className={cn(item, activeKey === PORT_FORWARDS_TAB_KEY && 'text-accent')}
      >
        <Network className="h-3.5 w-3.5" />
        {expanded && i18n.t('Port forwards')}
        {forwards > 0 && (
          <span className="bg-accent/15 text-accent rounded-md px-1.5 text-[10px] tabular-nums">
            {forwards}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={() => openSettings()}
        title={i18n.t('Settings')}
        aria-label={i18n.t('Settings')}
        className={item}
      >
        <SettingsIcon className="h-3.5 w-3.5" />
        {expanded && i18n.t('Settings')}
      </button>
    </div>
  );
}
