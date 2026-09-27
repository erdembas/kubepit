import * as i18n from '@/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import {
  ChevronDown,
  FilePlus2,
  FolderGit2,
  ListX,
  Maximize2,
  Minimize2,
  X,
  XCircle,
} from 'lucide-react';
import { FileContextMenu } from '@/components/ui/FileContextMenu';
import { cn } from '@/lib/cn';
import { useDockStore, type DockTab } from '@/store/useDockStore';
import type { ClusterId } from '@/types';
import { DockStripAction } from './DockStripAction';
import { DockTabItem } from './DockTabItem';
import { NewTerminalButton } from './NewTerminalButton';
import { requestCloseTabs, tabTooltip, uniqueTitles } from './tabs';

interface Props {
  clusterId: ClusterId;
  clusterName: string | null;
  tabs: DockTab[];
  activeId: string | null;
  maximized: boolean;
  dockFocused: boolean;
  onClusterShell: () => void;
  onLocalShell: () => void;
  onCreate: () => void;
  onManifests: () => void;
  onToggleMaximize: () => void;
  onMinimize: () => void;
}

/** RunHQ `GroupTabStrip` for the dock: scrollable tabs + captioned trailing actions. */
export function DockTabStrip({
  clusterId,
  clusterName,
  tabs,
  activeId,
  maximized,
  dockFocused,
  onClusterShell,
  onLocalShell,
  onCreate,
  onManifests,
  onToggleMaximize,
  onMinimize,
}: Props) {
  i18n.useLocale();
  const dirty = useDockStore((s) => s.dirty);
  const setActive = useDockStore((s) => s.setActive);
  const moveTab = useDockStore((s) => s.moveTab);
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const titles = useMemo(() => uniqueTitles(tabs, clusterName), [tabs, clusterName]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Keep the active tab visible when it is opened or focused from elsewhere.
  useEffect(() => {
    if (!activeId) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-tab-id="${activeId}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId, tabs.length]);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const to = tabs.findIndex((t) => t.id === over.id);
    if (to >= 0) moveTab(clusterId, String(active.id), to);
  };
  const close = (tabId: string) => requestCloseTabs(clusterId, [tabId]);

  return (
    <div
      className="border-border/60 bg-surface flex h-9 shrink-0 items-stretch border-b"
      role="tablist"
    >
      <div
        ref={scrollRef}
        className={cn('flex min-w-0 flex-1 items-stretch overflow-x-auto', 'main-tabbar-scroll')}
        onWheel={(e) => {
          // Vertical wheel scrolls the strip horizontally, like browser tab bars.
          if (e.deltaY !== 0 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            e.currentTarget.scrollLeft += e.deltaY;
          }
        }}
      >
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
            {tabs.map((tab) => (
              <DockTabItem
                key={tab.id}
                tab={tab}
                title={titles.get(tab.id) ?? tab.title}
                tooltip={tabTooltip(tab, clusterName)}
                active={tab.id === activeId}
                dockFocused={dockFocused}
                dirty={Boolean(dirty[tab.id])}
                onActivate={(id) => setActive(clusterId, id)}
                onClose={close}
                onMenu={(tabId, x, y) => setMenu({ tabId, x, y })}
              />
            ))}
          </SortableContext>
        </DndContext>
        <div className="min-w-6 flex-1" onDoubleClick={onClusterShell} />
      </div>
      <div className="border-border/60 flex shrink-0 items-center gap-1 border-l px-2">
        <NewTerminalButton
          clusterName={clusterName}
          onClusterShell={onClusterShell}
          onLocalShell={onLocalShell}
        />
        <DockStripAction
          icon={<FilePlus2 />}
          label={i18n.t('Create')}
          title={i18n.t('Create a resource from YAML')}
          onClick={onCreate}
        />
        <DockStripAction
          icon={<FolderGit2 />}
          label={i18n.t('Manifests')}
          title={i18n.t('Diff and apply local manifests to clusters')}
          onClick={onManifests}
        />
        <span aria-hidden className="bg-border/70 mx-0.5 h-4 w-px" />
        <DockStripAction
          icon={maximized ? <Minimize2 /> : <Maximize2 />}
          title={maximized ? i18n.t('Restore dock size') : i18n.t('Maximize dock')}
          onClick={onToggleMaximize}
        />
        <DockStripAction
          icon={<ChevronDown />}
          title={i18n.t('Minimize dock (Ctrl+`)')}
          onClick={onMinimize}
        />
      </div>
      {menu && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              id: 'close',
              label: i18n.t('Close'),
              icon: <X size={12} />,
              onClick: () => close(menu.tabId),
            },
            {
              id: 'close-others',
              label: i18n.t('Close others'),
              icon: <ListX size={12} />,
              disabled: tabs.length < 2,
              onClick: () =>
                requestCloseTabs(
                  clusterId,
                  tabs.filter((t) => t.id !== menu.tabId).map((t) => t.id),
                ),
            },
            { id: 'sep', separator: true },
            {
              id: 'close-all',
              label: i18n.t('Close all'),
              icon: <XCircle size={12} />,
              tone: 'danger',
              onClick: () =>
                requestCloseTabs(
                  clusterId,
                  tabs.map((t) => t.id),
                ),
            },
          ]}
        />
      )}
    </div>
  );
}
