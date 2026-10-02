import * as i18n from '@/i18n';
import { memo } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { Columns2 } from 'lucide-react';
import { DropZoneOverlay, HostSlot, SplitTree, useHosts } from '@/components/split/SplitTree';
import { PaneFocusContext, useNestedPaneFocus } from '@/components/split/paneFocus';
import { PANE_DROP, useTabDrag, type DropZone } from '@/components/split/tabDrag';
import { kindIcon } from '@/lib/kube/icons';
import { viewLabel } from '@/lib/kube/nav';
import { perfViewShown } from '@/lib/perf/probe';
import { useViewLayout, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ViewGroup, ViewLayout } from '@/store/viewLayout';
import type { ApiResourceInfo } from '@/types';
import { ViewHost } from '../ViewHost';
import { ViewTabStrip } from './ViewTabStrip';
import { viewTabCollision } from './viewTabCollision';

const MIN_PANE = { row: 280, column: 150 } as const;

/**
 * The workbench's split panes, laid out by the layout's split tree. One
 * `DndContext` spans every tab strip so a tab can be dragged to another
 * strip (move), onto another pane's body (move) or onto any edge of a pane
 * (split on that axis). Dividers resize neighbouring panes.
 * An unsplit workbench portals its strip into the header's `tabSlot`; the
 * portal keeps it inside this `DndContext`.
 */
export function ViewPanes({
  clusterId,
  isActive,
  namespaces,
  apiResources,
  tabSlot,
}: {
  clusterId: string;
  isActive: boolean;
  namespaces: string[];
  apiResources: ApiResourceInfo[] | null;
  tabSlot: HTMLElement | null;
}) {
  i18n.useLocale();
  const layout = useViewLayout(clusterId);
  const drag = useTabDrag(layout);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const store = useWorkbenchStore.getState;
  const multi = layout.groups.length > 1;
  // Panes portal into stable hosts so a split that wraps one keeps its pages mounted.
  const hostFor = useHosts(layout.groups.map((g) => g.id));
  const DragIcon = drag.dragKey ? kindIcon(drag.dragKey) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={viewTabCollision}
      onDragStart={drag.start}
      onDragMove={drag.move}
      onDragCancel={drag.cancel}
      onDragEnd={(event) => {
        const target = drag.end(event);
        const key = String(event.active.id);
        if (target?.type === 'move') store().moveTab(clusterId, key, target.pane, target.index);
        else if (target) store().splitPane(clusterId, target.pane, target.side, key);
      }}
    >
      <SplitTree
        node={layout.root}
        slot={(id) => <HostSlot host={hostFor(id)} />}
        onResize={(sizes) => store().resizePanes(clusterId, sizes)}
        minPane={MIN_PANE}
      />
      {layout.groups.map((group) =>
        createPortal(
          <ViewPane
            clusterId={clusterId}
            layout={layout}
            group={group}
            focused={!multi || group.id === layout.focused}
            clusterActive={isActive}
            namespaces={namespaces}
            apiResources={apiResources}
            dragKey={drag.dragKey}
            dropZone={drag.drop?.pane === group.id ? drag.drop.zone : null}
            tabSlot={multi ? null : tabSlot}
          />,
          hostFor(group.id),
          group.id,
        ),
      )}
      <DragOverlay dropAnimation={null}>
        {drag.dragKey && DragIcon ? (
          <div className="border-border bg-surface-overlay text-fg flex h-8 items-center gap-1.5 rounded-md border px-3 text-[12px] shadow-[0_8px_24px_-8px_rgb(0_0_0/0.5)]">
            <DragIcon className="text-accent h-3.5 w-3.5" />
            {viewLabel(drag.dragKey, apiResources)}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * One pane: its tab strip (in `tabSlot` when given) plus every tab's page
 * (hidden ones stay mounted, paused).
 */
const ViewPane = memo(function ViewPane({
  clusterId,
  layout,
  group,
  focused,
  clusterActive,
  namespaces,
  apiResources,
  dragKey,
  dropZone,
  tabSlot,
}: {
  clusterId: string;
  layout: ViewLayout;
  group: ViewGroup;
  focused: boolean;
  clusterActive: boolean;
  namespaces: string[];
  apiResources: ApiResourceInfo[] | null;
  dragKey: string | null;
  dropZone: DropZone | null;
  tabSlot: HTMLElement | null;
}) {
  i18n.useLocale();
  perfViewShown(group.id, group.active);
  const { setNodeRef } = useDroppable({ id: `${PANE_DROP}${group.id}` });
  // Unfocused while the main pane holding this cluster is not focused either.
  const keyboardFocus = useNestedPaneFocus(focused);
  const focus = () => {
    if (!focused) useWorkbenchStore.getState().focusPane(clusterId, group.id);
  };

  const strip = (
    <ViewTabStrip
      clusterId={clusterId}
      layout={layout}
      group={group}
      focused={focused}
      dragKey={dragKey}
      apiResources={apiResources}
      placement={tabSlot ? 'header' : 'pane'}
    />
  );

  return (
    <section
      data-pane-root
      aria-label={i18n.t('View pane')}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onPointerDownCapture={focus}
      onFocusCapture={focus}
    >
      {tabSlot ? createPortal(strip, tabSlot) : strip}
      <PaneFocusContext.Provider value={keyboardFocus}>
        <div ref={setNodeRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {group.tabs.length ? (
            group.tabs.map((key) => (
              <div
                key={key}
                role="tabpanel"
                aria-hidden={key !== group.active}
                className={key === group.active ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'}
              >
                <ViewHost
                  clusterId={clusterId}
                  viewKey={key}
                  isActive={clusterActive && key === group.active}
                  namespaces={namespaces}
                  apiResources={apiResources}
                />
              </div>
            ))
          ) : (
            <div className="flex flex-1 items-center justify-center p-8">
              <div className="max-w-xs text-center">
                <div className="bg-fg/5 text-fg-dim mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl">
                  <Columns2 className="h-5 w-5" />
                </div>
                <h3 className="text-fg text-[13.5px] font-semibold">{i18n.t('Empty pane')}</h3>
                <p className="text-fg-muted mt-1.5 text-[12px]">
                  {i18n.t('Pick a kind in the navigator or drag a tab here.')}
                </p>
              </div>
            </div>
          )}
          <DropZoneOverlay zone={dropZone} />
        </div>
      </PaneFocusContext.Provider>
    </section>
  );
});
