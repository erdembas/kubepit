import * as i18n from '@/i18n';
import { lazy, memo, Suspense } from 'react';
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
import { Dashboard } from '@/components/dashboard/Dashboard';
import { MainTabStrip } from '@/components/main-tab-bar/MainTabStrip';
import { resolveTabMeta } from '@/components/main-tab-bar/tabMeta';
import { DropZoneOverlay, HostSlot, SplitTree, useHosts } from '@/components/split/SplitTree';
import { PaneFocusContext } from '@/components/split/paneFocus';
import { PANE_DROP, tabCollision, useTabDrag, type DropZone } from '@/components/split/tabDrag';
import { StatusDot } from '@/components/ui/StatusDot';
import { ClusterWorkbench } from '@/components/workbench/ClusterWorkbench';
import { tabFromKey } from '@/store/mainLayout';
import type { SplitLayout, TabGroup } from '@/store/splitLayout';
import { mainTabKey, useAppStore } from '@/store/useAppStore';

const SettingsView = lazy(() =>
  import('@/components/settings/SettingsView').then((m) => ({ default: m.SettingsView })),
);
const PortForwardsView = lazy(() =>
  import('@/components/port-forwards/PortForwardsView').then((m) => ({
    default: m.PortForwardsView,
  })),
);

const MIN_PANE = { row: 360, column: 200 } as const;

/**
 * The main area: app tabs (dashboard, clusters, settings, port forwards) in
 * split panes, each with its own tab strip. One `DndContext` spans every
 * strip so a tab can move to another strip or pane, or split a pane on any
 * edge. Every tab's page renders once into a stable host that the pane
 * showing it adopts, so moving a cluster between panes or splitting around
 * it keeps its workbench, watches and terminals alive. Hidden pages keep
 * their DOM, watches (paused), terminals and log streams.
 */
export function MainPanes() {
  i18n.useLocale();
  const layout = useAppStore((s) => s.mainLayout);
  const mainTabs = useAppStore((s) => s.mainTabs);
  const drag = useTabDrag(layout);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const store = useAppStore.getState;
  const multi = layout.groups.length > 1;
  const keys = mainTabs.map(mainTabKey);
  const hostFor = useHosts(keys);
  const paneOf = new Map(layout.groups.flatMap((g) => g.tabs.map((k) => [k, g] as const)));

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={tabCollision}
      onDragStart={drag.start}
      onDragMove={drag.move}
      onDragCancel={drag.cancel}
      onDragEnd={(event) => {
        const target = drag.end(event);
        const key = String(event.active.id);
        if (target?.type === 'move') store().moveMainTab(key, target.pane, target.index);
        else if (target) store().splitMainPane(target.pane, target.side, key);
      }}
    >
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <SplitTree
          node={layout.root}
          slot={(id) => {
            const group = layout.groups.find((g) => g.id === id);
            return group ? (
              <MainPane
                layout={layout}
                group={group}
                focused={!multi || id === layout.focused}
                dragKey={drag.dragKey}
                dropZone={drag.drop?.pane === id ? drag.drop.zone : null}
                hostFor={hostFor}
              />
            ) : null;
          }}
          onResize={(sizes) => store().resizeMainPanes(sizes)}
          minPane={MIN_PANE}
        />
      </div>
      {keys.map((key) => {
        const pane = paneOf.get(key);
        const visible = pane?.active === key;
        return createPortal(
          <MainTabPanel
            tabKey={key}
            visible={visible}
            focused={visible && (!multi || pane?.id === layout.focused)}
          />,
          hostFor(key),
          key,
        );
      })}
      <DragOverlay dropAnimation={null}>
        {drag.dragKey ? <MainDragGhost tabKey={drag.dragKey} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

/** One pane: its strip plus the slots its tabs' pages show in (inactive ones hidden). */
function MainPane({
  layout,
  group,
  focused,
  dragKey,
  dropZone,
  hostFor,
}: {
  layout: SplitLayout;
  group: TabGroup;
  focused: boolean;
  dragKey: string | null;
  dropZone: DropZone | null;
  hostFor: (key: string) => HTMLDivElement;
}) {
  i18n.useLocale();
  const { setNodeRef } = useDroppable({ id: `${PANE_DROP}${group.id}` });
  // A lone pane with only the dashboard has nothing to switch to.
  const showStrip = layout.groups.length > 1 || group.tabs.length > 1;
  const focus = () => {
    if (!focused) useAppStore.getState().focusMainPane(group.id);
  };

  return (
    <section
      aria-label={i18n.t('Main pane')}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onPointerDownCapture={focus}
      onFocusCapture={focus}
    >
      {showStrip && (
        <MainTabStrip layout={layout} group={group} focused={focused} dragKey={dragKey} />
      )}
      <div
        ref={setNodeRef}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {group.tabs.map((key) => (
          <HostSlot
            key={key}
            host={hostFor(key)}
            className={
              key === group.active
                ? 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'
                : 'hidden'
            }
          />
        ))}
        {!group.tabs.length && (
          <div className="flex flex-1 items-center justify-center p-8">
            <div className="max-w-xs text-center">
              <div className="bg-fg/5 text-fg-dim mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl">
                <Columns2 className="h-5 w-5" />
              </div>
              <h3 className="text-fg text-[13.5px] font-semibold">{i18n.t('Empty pane')}</h3>
              <p className="text-fg-muted mt-1.5 text-[12px]">
                {i18n.t('Open a cluster from the sidebar or drag a tab here.')}
              </p>
            </div>
          </div>
        )}
        <DropZoneOverlay zone={dropZone} />
      </div>
    </section>
  );
}

// Portaled from `MainPanes`, so React events bubble there rather than to the
// pane: clicks inside a page focus its pane from here.
const MainTabPanel = memo(function MainTabPanel({
  tabKey,
  visible,
  focused,
}: {
  tabKey: string;
  visible: boolean;
  /** Visible in the focused pane: global shortcuts act here. */
  focused: boolean;
}) {
  i18n.useLocale();
  const tab = tabFromKey(tabKey);
  const focus = () => {
    if (!focused) useAppStore.getState().focusMainTabPane(tabKey);
  };
  if (!tab) return null;
  return (
    <PaneFocusContext.Provider value={focused}>
      <div
        role="tabpanel"
        aria-hidden={!visible}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        onPointerDownCapture={focus}
        onFocusCapture={focus}
      >
        {tab.kind === 'dashboard' && <Dashboard visible={visible} />}
        {tab.kind === 'cluster' && <ClusterWorkbench clusterId={tab.refId} isActive={visible} />}
        <Suspense fallback={<p className="text-fg-muted p-5 text-[12px]">{i18n.t('Loading…')}</p>}>
          {tab.kind === 'settings' && <SettingsView />}
          {tab.kind === 'port-forwards' && <PortForwardsView />}
        </Suspense>
      </div>
    </PaneFocusContext.Provider>
  );
});

function MainDragGhost({ tabKey }: { tabKey: string }) {
  i18n.useLocale();
  const clusters = useAppStore((s) => s.clusters);
  const statuses = useAppStore((s) => s.statuses);
  const tab = tabFromKey(tabKey);
  if (!tab) return null;
  const meta = resolveTabMeta(tab, clusters, statuses);
  return (
    <div className="border-border bg-surface-overlay text-fg flex h-8 items-center gap-2 rounded-md border px-3 text-[12px] shadow-[0_8px_24px_-8px_rgb(0_0_0/0.5)]">
      <span className="text-fg-dim flex h-3.5 w-3.5 items-center justify-center">
        {meta.status ? <StatusDot status={meta.status} size="sm" /> : meta.icon}
      </span>
      {meta.label}
    </div>
  );
}
