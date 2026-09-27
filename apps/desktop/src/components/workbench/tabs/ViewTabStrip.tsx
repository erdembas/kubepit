import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { ChevronsRight, Columns2, ListX, Rows2, Trash2, X } from 'lucide-react';
import { FileContextMenu, type FileContextMenuEntry } from '@/components/ui/FileContextMenu';
import { IconButton } from '@/components/ui/IconButton';
import { kindIcon } from '@/lib/kube/icons';
import { viewLabel } from '@/lib/kube/nav';
import { cn } from '@/lib/cn';
import { useWorkbenchStore, VIEW } from '@/store/useWorkbenchStore';
import { paneAxis, splitSides, type ViewGroup, type ViewLayout } from '@/store/viewLayout';
import type { ApiResourceInfo } from '@/types';
import { STRIP_DROP } from '@/components/split/tabDrag';
import { ViewTabItem } from './ViewTabItem';

/**
 * One pane's view tabs (RunHQ `GroupTabStrip` look). Tabs sort by drag and
 * can be dropped on other strips or pane edges (see `ViewPanes`); trailing
 * actions split the pane or close it. The lone overview tab of an unsplit
 * workbench cannot be closed. `placement="header"` drops the strip's own
 * bar chrome and renders pill tabs, so they don't read as a second row of
 * main tabs.
 */
export function ViewTabStrip({
  clusterId,
  layout,
  group,
  focused,
  dragKey,
  apiResources,
  placement = 'pane',
}: {
  clusterId: string;
  layout: ViewLayout;
  group: ViewGroup;
  focused: boolean;
  /** Tab being dragged anywhere in the workbench. */
  dragKey: string | null;
  apiResources: ApiResourceInfo[] | null;
  placement?: 'pane' | 'header';
}) {
  i18n.useLocale();
  const header = placement === 'header';
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { setNodeRef, isOver } = useDroppable({ id: `${STRIP_DROP}${group.id}` });
  const store = useWorkbenchStore.getState;
  const { tabs, active } = group;
  const multi = layout.groups.length > 1;
  const onlyOverview = !multi && tabs.length === 1 && tabs[0] === VIEW.clusterOverview;
  const foreignDrag = dragKey !== null && !tabs.includes(dragKey);
  // The button continues the axis the pane already sits on (right by default).
  const splitSide = paneAxis(layout, group.id) === 'column' ? 'bottom' : 'right';
  const canSplit = splitSides(layout, group.id).includes(splitSide);
  const items = useMemo(
    () => tabs.map((key) => ({ key, label: viewLabel(key, apiResources), icon: kindIcon(key) })),
    [tabs, apiResources],
  );

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );

  // Keep the active tab visible when it is opened or focused from elsewhere.
  useEffect(() => {
    if (!active) return;
    scrollRef.current
      ?.querySelector(`[data-view-tab="${CSS.escape(active)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, tabs.length]);

  const activate = useCallback(
    (key: string) => store().setActiveKind(clusterId, key),
    [clusterId, store],
  );
  const close = useCallback((key: string) => store().closeTab(clusterId, key), [clusterId, store]);
  const openMenu = useCallback((key: string, x: number, y: number) => setMenu({ key, x, y }), []);
  const step = useCallback(
    (key: string, by: -1 | 1) => {
      const next = tabs[(tabs.indexOf(key) + by + tabs.length) % tabs.length];
      if (!next) return;
      store().setActiveKind(clusterId, next);
      scrollRef.current
        ?.querySelector<HTMLElement>(`[data-view-tab="${CSS.escape(next)}"]`)
        ?.focus();
    },
    [clusterId, store, tabs],
  );

  const menuItems = useMemo((): FileContextMenuEntry[] => {
    if (!menu) return [];
    const at = tabs.indexOf(menu.key);
    const sides = splitSides(layout, group.id, menu.key);
    return [
      {
        id: 'split-right',
        label: i18n.t('Split Right'),
        icon: <Columns2 size={12} />,
        disabled: !sides.includes('right'),
        onClick: () => store().splitPane(clusterId, group.id, 'right', menu.key),
      },
      {
        id: 'split-down',
        label: i18n.t('Split Down'),
        icon: <Rows2 size={12} />,
        disabled: !sides.includes('bottom'),
        onClick: () => store().splitPane(clusterId, group.id, 'bottom', menu.key),
      },
      { id: 'sep0', separator: true },
      {
        id: 'close',
        label: i18n.t('Close'),
        icon: <X size={12} />,
        disabled: onlyOverview,
        onClick: () => close(menu.key),
      },
      {
        id: 'close-others',
        label: i18n.t('Close Others'),
        icon: <ListX size={12} />,
        disabled: tabs.length < 2,
        onClick: () => store().closeOtherTabs(clusterId, menu.key),
      },
      {
        id: 'close-right',
        label: i18n.t('Close to the Right'),
        icon: <ChevronsRight size={12} />,
        disabled: at < 0 || at === tabs.length - 1,
        onClick: () => store().closeTabsToRight(clusterId, menu.key),
      },
      { id: 'sep1', separator: true },
      {
        id: 'close-all',
        label: i18n.t('Close All'),
        icon: <Trash2 size={12} />,
        tone: 'danger',
        disabled: onlyOverview,
        onClick: () => store().closeAllTabs(clusterId, group.id),
      },
    ];
  }, [menu, tabs, layout, group.id, onlyOverview, close, clusterId, store]);

  return (
    <div
      className={cn(
        'flex',
        header
          ? 'min-w-0 flex-1 items-center'
          : 'border-border/60 bg-surface-raised/60 h-9 shrink-0 items-stretch border-b',
      )}
    >
      {header && <span className="bg-border/80 mr-2 ml-1 h-5 w-px shrink-0" aria-hidden />}
      <div
        ref={setRefs}
        role="tablist"
        aria-label={i18n.t('Open views')}
        className={cn(
          'main-tabbar-scroll flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden transition-colors',
          header ? 'items-center gap-0.5' : 'items-stretch',
          isOver && foreignDrag && 'bg-accent/8',
        )}
        onWheel={(e) => {
          // Vertical wheel scrolls the strip horizontally, like browser tab bars.
          if (e.deltaY !== 0 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            e.currentTarget.scrollLeft += e.deltaY;
          }
        }}
      >
        <SortableContext items={tabs} strategy={horizontalListSortingStrategy}>
          {items.map((item) => (
            <ViewTabItem
              key={item.key}
              viewKey={item.key}
              variant={header ? 'pill' : 'bar'}
              label={item.label}
              icon={item.icon}
              active={item.key === active}
              focused={focused}
              closable={!onlyOverview}
              foreignDrag={foreignDrag}
              onActivate={activate}
              onClose={close}
              onStep={step}
              onMenu={openMenu}
            />
          ))}
        </SortableContext>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 px-1.5">
        <IconButton
          size="xs"
          label={splitSide === 'right' ? i18n.t('Split pane right') : i18n.t('Split pane down')}
          icon={splitSide === 'right' ? <Columns2 /> : <Rows2 />}
          disabled={!canSplit}
          onClick={() => store().splitPane(clusterId, group.id, splitSide)}
        />
        {multi && (
          <IconButton
            size="xs"
            label={i18n.t('Close pane')}
            icon={<X />}
            onClick={() => store().closePane(clusterId, group.id)}
          />
        )}
      </div>
      {menu && (
        <FileContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
