import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import {
  ArrowLeft,
  ArrowRight,
  ChevronsRight,
  Columns2,
  ListX,
  Pin,
  PinOff,
  Rows2,
  Trash2,
  X,
} from 'lucide-react';
import { FileContextMenu, type FileContextMenuEntry } from '@/components/ui/FileContextMenu';
import { IconButton } from '@/components/ui/IconButton';
import { kindIcon } from '@/lib/kube/icons';
import { viewLabel } from '@/lib/kube/nav';
import { cn } from '@/lib/cn';
import { useWorkbenchStore, VIEW } from '@/store/useWorkbenchStore';
import {
  MAX_PINNED_VIEW_TABS,
  paneAxis,
  splitSides,
  type ViewGroup,
  type ViewLayout,
} from '@/store/viewLayout';
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
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { setNodeRef, isOver } = useDroppable({ id: `${STRIP_DROP}${group.id}` });
  const store = useWorkbenchStore.getState;
  const { tabs, active } = group;
  const pinnedTabKeys = useWorkbenchStore((s) => s.pinnedTabKeys[clusterId]);
  const previewTabKey = useWorkbenchStore((s) => s.previewTabKeys[clusterId] ?? null);
  const pinned = useMemo(() => new Set(pinnedTabKeys), [pinnedTabKeys]);
  const movableTabs = useMemo(() => tabs.filter((key) => !pinned.has(key)), [tabs, pinned]);
  const revealRevision = useWorkbenchStore((s) =>
    active ? (s.viewRevealRevision[`${clusterId}|${active}`] ?? 0) : 0,
  );
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
      tabListRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );

  // Re-selecting an already-active view also requests a reveal. Scroll only
  // this strip, without moving the page or any enclosing split pane.
  useEffect(() => {
    if (!active) return;
    const strip = scrollRef.current;
    const tab = strip?.querySelector<HTMLElement>(`[data-view-tab="${CSS.escape(active)}"]`);
    if (!strip || !tab) return;
    // Layout offsets ignore dnd-kit's temporary sorting transforms.
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    let target = strip.scrollLeft;
    if (left < strip.scrollLeft) target = left;
    else if (right > strip.scrollLeft + strip.clientWidth)
      target = Math.min(left, right - strip.clientWidth);
    if (target === strip.scrollLeft) return;
    strip.scrollTo({
      left: target,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
    // A new selection interrupts the previous reveal, even when the new
    // tab is already visible partway through that animation.
    return () => strip.scrollTo({ left: strip.scrollLeft, behavior: 'auto' });
  }, [active, tabs, pinned, revealRevision]);

  const activate = useCallback(
    (key: string) => store().setActiveKind(clusterId, key),
    [clusterId, store],
  );
  const keep = useCallback(
    (key: string) => {
      // Double click on the ephemeral tab makes it permanent.
      if (store().previewTabKeys[clusterId] === key) store().keepPreviewTab(clusterId);
    },
    [clusterId, store],
  );
  const close = useCallback((key: string) => store().closeTab(clusterId, key), [clusterId, store]);
  const togglePin = useCallback(
    (key: string) => store().toggleTabPin(clusterId, key),
    [clusterId, store],
  );
  const openMenu = useCallback((key: string, x: number, y: number) => setMenu({ key, x, y }), []);
  const step = useCallback(
    (key: string, by: -1 | 1) => {
      const next = tabs[(tabs.indexOf(key) + by + tabs.length) % tabs.length];
      if (!next) return;
      store().setActiveKind(clusterId, next);
      tabListRef.current
        ?.querySelector<HTMLElement>(`[data-view-tab="${CSS.escape(next)}"]`)
        ?.focus({ preventScroll: true });
    },
    [clusterId, store, tabs],
  );

  const menuItems = useMemo((): FileContextMenuEntry[] => {
    if (!menu) return [];
    const at = tabs.indexOf(menu.key);
    if (at < 0) return [];
    const isPinned = pinned.has(menu.key);
    const sides = splitSides(layout, group.id, menu.key);
    return [
      {
        id: 'pin',
        label: isPinned ? i18n.t('Unpin Tab') : i18n.t('Pin Tab'),
        icon: isPinned ? <PinOff size={12} /> : <Pin size={12} />,
        disabled: !isPinned && pinned.size >= MAX_PINNED_VIEW_TABS,
        title:
          !isPinned && pinned.size >= MAX_PINNED_VIEW_TABS
            ? i18n.t('You can pin up to {count} tabs per cluster.', { count: MAX_PINNED_VIEW_TABS })
            : undefined,
        onClick: () => togglePin(menu.key),
      },
      {
        id: 'move-left',
        label: i18n.t('Move Left'),
        icon: <ArrowLeft size={12} />,
        disabled: isPinned || at === 0 || pinned.has(tabs[at - 1]!),
        onClick: () => store().moveTabLeft(clusterId, menu.key),
      },
      {
        id: 'move-right',
        label: i18n.t('Move Right'),
        icon: <ArrowRight size={12} />,
        disabled: isPinned || at === tabs.length - 1,
        onClick: () => store().moveTabRight(clusterId, menu.key),
      },
      { id: 'sep-pin', separator: true },
      {
        id: 'split-right',
        label: i18n.t('Split Right'),
        icon: <Columns2 size={12} />,
        disabled: isPinned || !sides.includes('right'),
        onClick: () => store().splitPane(clusterId, group.id, 'right', menu.key),
      },
      {
        id: 'split-down',
        label: i18n.t('Split Down'),
        icon: <Rows2 size={12} />,
        disabled: isPinned || !sides.includes('bottom'),
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
        disabled: !movableTabs.some((key) => key !== menu.key),
        onClick: () => store().closeOtherTabs(clusterId, menu.key),
      },
      {
        id: 'close-right',
        label: i18n.t('Close to the Right'),
        icon: <ChevronsRight size={12} />,
        disabled: !tabs.slice(at + 1).some((key) => !pinned.has(key)),
        onClick: () => store().closeTabsToRight(clusterId, menu.key),
      },
      { id: 'sep1', separator: true },
      {
        id: 'close-all',
        label: i18n.t('Close All'),
        icon: <Trash2 size={12} />,
        tone: 'danger',
        disabled: onlyOverview || movableTabs.length === 0,
        onClick: () => store().closeAllTabs(clusterId, group.id),
      },
    ];
  }, [
    menu,
    tabs,
    pinned,
    movableTabs,
    layout,
    group.id,
    onlyOverview,
    close,
    togglePin,
    clusterId,
    store,
  ]);

  const renderTab = (item: (typeof items)[number]) => (
    <ViewTabItem
      key={item.key}
      viewKey={item.key}
      variant={header ? 'pill' : 'bar'}
      label={item.label}
      icon={item.icon}
      active={item.key === active}
      focused={focused}
      pinned={pinned.has(item.key)}
      preview={previewTabKey === item.key}
      closable={!onlyOverview && !pinned.has(item.key)}
      foreignDrag={foreignDrag}
      onActivate={activate}
      onKeep={keep}
      onClose={close}
      onTogglePin={togglePin}
      onStep={step}
      onMenu={openMenu}
    />
  );

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
          '@container/view-tabs flex min-w-0 flex-1 transition-colors',
          header ? 'items-center' : 'items-stretch',
          isOver && foreignDrag && 'bg-accent/8',
        )}
        onPointerDownCapture={() => {
          // Let pointer interaction take over before a tab drag starts.
          const strip = scrollRef.current;
          strip?.scrollTo({ left: strip.scrollLeft, behavior: 'auto' });
        }}
        onWheel={(e) => {
          // Vertical wheel scrolls the strip horizontally, like browser tab bars.
          const strip = scrollRef.current;
          if (strip && e.deltaY !== 0 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            strip.scrollLeft += e.deltaY;
          } else if (strip && e.deltaX !== 0 && !strip.contains(e.target as Node)) {
            strip.scrollLeft += e.deltaX;
          }
        }}
      >
        <SortableContext items={movableTabs} strategy={horizontalListSortingStrategy}>
          {tabs.some((key) => pinned.has(key)) && (
            <div
              className={cn(
                'border-border/60 mr-1 flex shrink-0 border-r pr-1',
                header ? 'items-center gap-0.5' : 'items-stretch',
              )}
            >
              {items.filter((item) => pinned.has(item.key)).map(renderTab)}
            </div>
          )}
          <div
            ref={scrollRef}
            data-view-tabs-scroll
            className={cn(
              'main-tabbar-scroll relative flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden',
              header ? 'items-center gap-0.5' : 'items-stretch',
            )}
          >
            {items.filter((item) => !pinned.has(item.key)).map(renderTab)}
          </div>
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
