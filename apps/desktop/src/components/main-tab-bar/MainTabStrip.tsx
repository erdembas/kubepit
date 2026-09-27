import { useLocaleMemo as useMemo } from '@/i18n';
import * as i18n from '@/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { Columns2, Rows2, X } from 'lucide-react';
import { DashboardTab } from '@/components/main-tab-bar/DashboardTab';
import { SortableTab } from '@/components/main-tab-bar/SortableTab';
import { resolveTabMeta } from '@/components/main-tab-bar/tabMeta';
import { useMainTabContextMenu } from '@/components/main-tab-bar/useMainTabContextMenu';
import { STRIP_DROP } from '@/components/split/tabDrag';
import { FileContextMenu } from '@/components/ui/FileContextMenu';
import { IconButton } from '@/components/ui/IconButton';
import { cn } from '@/lib/cn';
import { moveTabToNewWindow } from '@/lib/windowing';
import { tabFromKey } from '@/store/mainLayout';
import { paneAxis, splitSides, type SplitLayout, type TabGroup } from '@/store/splitLayout';
import { DASHBOARD_TAB_KEY, useAppStore, type MainTab } from '@/store/useAppStore';

/**
 * One main pane's tab strip (RunHQ main tab bar): the dashboard (when it
 * lives here) then sortable tabs with pin zones. Tabs drag to other strips,
 * pane bodies and pane edges (see `MainPanes`); trailing actions split the
 * pane or close it.
 */
export function MainTabStrip({
  layout,
  group,
  focused,
  dragKey,
}: {
  layout: SplitLayout;
  group: TabGroup;
  /** The pane is the focused one (bright vs muted active tab). */
  focused: boolean;
  /** Tab being dragged anywhere in the main area. */
  dragKey: string | null;
}) {
  i18n.useLocale();
  const clusters = useAppStore((s) => s.clusters);
  const statuses = useAppStore((s) => s.statuses);
  const pinnedKeys = useAppStore((s) => s.pinnedMainTabKeys);
  const store = useAppStore.getState;
  const multi = layout.groups.length > 1;

  const stripRef = useRef<HTMLDivElement | null>(null);
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });
  const { setNodeRef, isOver } = useDroppable({ id: `${STRIP_DROP}${group.id}` });
  const pinnedSet = useMemo(() => new Set(pinnedKeys), [pinnedKeys]);
  const tabs = useMemo(
    () => group.tabs.map(tabFromKey).filter((t): t is MainTab => !!t),
    [group.tabs],
  );
  const foreignDrag = dragKey !== null && !group.tabs.includes(dragKey);
  // The button continues the axis the pane already sits on (right by default).
  const splitSide = paneAxis(layout, group.id) === 'column' ? 'bottom' : 'right';
  const canSplit = splitSides(layout, group.id).includes(splitSide);

  const { menu, menuItems, openMenu, closeMenu } = useMainTabContextMenu({
    tabs,
    pinnedSet,
    closeMainTab: (key) => store().closeMainTab(key),
    closeOtherMainTabs: (key) => store().closeOtherMainTabs(key),
    closeMainTabsToRight: (key) => store().closeMainTabsToRight(key),
    closeMainTabsToLeft: (key) => store().closeMainTabsToLeft(key),
    closeAllMainTabs: (key) => store().closeAllMainTabs(key),
    toggleMainTabPin: (key) => store().toggleMainTabPin(key),
    moveMainTabLeft: (key) => store().moveMainTabLeft(key),
    moveMainTabRight: (key) => store().moveMainTabRight(key),
    splitSidesFor: (key) => splitSides(layout, group.id, key),
    splitWith: (key, side) => store().splitMainPane(group.id, side, key),
    moveToNewWindow: (key) => void moveTabToNewWindow(key),
  });

  const setStripRef = useCallback(
    (node: HTMLDivElement | null) => {
      stripRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );

  const onWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const element = stripRef.current;
    if (!element) return;
    if (element.scrollWidth <= element.clientWidth) return;
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.deltaY === 0) return;
    event.preventDefault();
    element.scrollLeft += event.deltaY;
  }, []);

  const recomputeOverflow = useCallback(() => {
    const element = stripRef.current;
    if (!element) return;
    const left = element.scrollLeft > 1;
    const right = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
    setOverflow((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useEffect(() => {
    const element = stripRef.current;
    if (!element) return;
    recomputeOverflow();
    const onScroll = () => recomputeOverflow();
    const resizeObserver = new ResizeObserver(() => recomputeOverflow());
    element.addEventListener('scroll', onScroll, { passive: true });
    resizeObserver.observe(element);
    return () => {
      element.removeEventListener('scroll', onScroll);
      resizeObserver.disconnect();
    };
  }, [recomputeOverflow]);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'smooth',
    });
  }, [group.active]);

  useEffect(() => {
    recomputeOverflow();
  }, [recomputeOverflow, group.tabs]);

  const items = useMemo(
    () =>
      tabs.map((tab, i) => {
        const key = group.tabs[i]!;
        return {
          tab,
          key,
          pinned: key !== DASHBOARD_TAB_KEY && pinnedSet.has(key),
          ...resolveTabMeta(tab, clusters, statuses),
        };
      }),
    [pinnedSet, clusters, statuses, tabs, group.tabs],
  );
  const dashboardItem = items.find((item) => item.key === DASHBOARD_TAB_KEY) ?? null;
  const sortableItems = items.filter((item) => item.key !== DASHBOARD_TAB_KEY);
  const sortableIds = useMemo(() => sortableItems.map((item) => item.key), [sortableItems]);
  const activate = (key: string) => store().setActiveMainTab(key);

  return (
    <>
      <div className="border-border/70 bg-surface-raised flex h-9 shrink-0 border-b">
        <div className="relative flex min-w-0 flex-1">
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-y-0 left-0 z-10 w-6 transition-opacity',
              overflow.left ? 'opacity-100' : 'opacity-0',
            )}
            style={{
              background:
                'linear-gradient(to right, rgb(var(--surface-raised)) 30%, rgb(var(--surface-raised) / 0))',
            }}
          />
          <div
            ref={setStripRef}
            role="tablist"
            aria-label={i18n.t('Open work')}
            onWheel={onWheel}
            className={cn(
              'main-tabbar-scroll relative flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden transition-colors',
              isOver && foreignDrag && 'bg-accent/8',
            )}
          >
            {dashboardItem && (
              <DashboardTab
                isActive={dashboardItem.key === group.active}
                muted={!focused}
                activeTabRef={dashboardItem.key === group.active ? activeTabRef : undefined}
                onActivate={() => activate(dashboardItem.key)}
                onContextMenu={(event) => openMenu(dashboardItem.key, event)}
                icon={dashboardItem.icon}
                label={dashboardItem.label}
              />
            )}
            <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
              {sortableItems.map(({ tab, key, pinned, label, icon, status, closable }) => {
                const isActive = key === group.active;
                return (
                  <SortableTab
                    key={key}
                    id={key}
                    tab={tab}
                    label={label}
                    icon={icon}
                    status={status}
                    isPinned={pinned}
                    pinnedSet={pinnedSet}
                    closable={closable}
                    isActive={isActive}
                    muted={!focused}
                    activeTabRef={isActive ? activeTabRef : undefined}
                    onActivate={() => activate(key)}
                    onClose={closable ? () => store().closeMainTab(key) : undefined}
                    onTogglePin={() => store().toggleMainTabPin(key)}
                    onContextMenu={(event) => openMenu(key, event)}
                  />
                );
              })}
            </SortableContext>
          </div>
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-y-0 right-0 z-10 w-6 transition-opacity',
              overflow.right ? 'opacity-100' : 'opacity-0',
            )}
            style={{
              background:
                'linear-gradient(to left, rgb(var(--surface-raised)) 30%, rgb(var(--surface-raised) / 0))',
            }}
          />
        </div>
        <div className="flex shrink-0 items-center gap-0.5 px-1.5">
          <IconButton
            size="xs"
            label={splitSide === 'right' ? i18n.t('Split pane right') : i18n.t('Split pane down')}
            icon={splitSide === 'right' ? <Columns2 /> : <Rows2 />}
            disabled={!canSplit}
            onClick={() => store().splitMainPane(group.id, splitSide)}
          />
          {multi && (
            <IconButton
              size="xs"
              label={i18n.t('Close pane')}
              icon={<X />}
              onClick={() => store().closeMainPane(group.id)}
            />
          )}
        </div>
      </div>
      {menu && menuItems && (
        <FileContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />
      )}
    </>
  );
}
