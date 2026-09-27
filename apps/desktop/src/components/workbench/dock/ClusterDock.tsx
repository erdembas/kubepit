import * as i18n from '@/i18n';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useAppStore } from '@/store/useAppStore';
import {
  dock as dockOpeners,
  useDockStore,
  type ClusterDock as DockState,
} from '@/store/useDockStore';
import type { ClusterId } from '@/types';
import { DockCollapsedBar } from './DockCollapsedBar';
import { DockResizeHandle } from './DockResizeHandle';
import { DockTabBody } from './DockTabBody';
import { DockTabStrip } from './DockTabStrip';
import { isDockToggleShortcut } from './shared/xtermUtils';
import { scopeNamespace, tabTitle } from './tabs';

const MIN_HEIGHT = 140;
const MAX_FRACTION = 0.8;
const DEFAULT_HEIGHT = 320;
const EMPTY: DockState = {
  tabs: [],
  activeId: null,
  open: false,
  height: DEFAULT_HEIGHT,
  maximized: false,
};

/** Tracks the height of the element the dock is laid out in (the workbench column). */
function useParentHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.contentRect.height ?? 0;
      if (next > 0) setHeight(next);
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}

/**
 * Bottom dock of a cluster workbench: terminals, pod logs and YAML editors
 * as tabs. Every tab stays mounted while inactive, while the dock is
 * minimized and while the cluster tab is hidden, so shells and log streams
 * survive; closing the tab (or removing the cluster) ends them.
 */
export function ClusterDock({ clusterId, visible }: { clusterId: ClusterId; visible: boolean }) {
  i18n.useLocale();
  const dock = useDockStore((s) => s.docks[clusterId]) ?? EMPTY;
  const setOpen = useDockStore((s) => s.setOpen);
  const setHeight = useDockStore((s) => s.setHeight);
  const setMaximized = useDockStore((s) => s.setMaximized);
  const clusterName = useAppStore((s) => s.clusters.find((c) => c.id === clusterId)?.name ?? null);
  const rootRef = useRef<HTMLDivElement>(null);
  const parentHeight = useParentHeight(rootRef);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);

  const openClusterShell = useCallback(
    () => dockOpeners.shell(clusterId, clusterName ?? clusterId, scopeNamespace(clusterId)),
    [clusterId, clusterName],
  );
  const openLocalShell = useCallback(
    () => dockOpeners.localShell(clusterId, i18n.t('Local shell')),
    [clusterId],
  );
  const openCreate = useCallback(
    () => dockOpeners.create(clusterId, scopeNamespace(clusterId)),
    [clusterId],
  );

  // Ctrl+` toggles the dock of the visible cluster (capture phase, so a
  // focused terminal cannot swallow it). With no tabs it opens a shell.
  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if (!isDockToggleShortcut(event) || event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      const current = useDockStore.getState().docks[clusterId];
      if (!current || current.tabs.length === 0) openClusterShell();
      else useDockStore.getState().setOpen(clusterId, !current.open);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [visible, clusterId, openClusterShell]);

  const maxHeight = parentHeight > 0 ? Math.max(MIN_HEIGHT, parentHeight * MAX_FRACTION) : Infinity;
  const clamp = useCallback(
    (h: number) => Math.round(Math.max(MIN_HEIGHT, Math.min(h, maxHeight))),
    [maxHeight],
  );
  const open = dock.open && dock.tabs.length > 0;
  const height =
    dock.maximized && parentHeight > 0 ? parentHeight : clamp(dragHeight ?? dock.height);
  const activeTab = dock.tabs.find((t) => t.id === dock.activeId) ?? null;

  return (
    <div
      ref={rootRef}
      className="bg-surface relative flex shrink-0 flex-col"
      style={open ? { height } : undefined}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      {open ? (
        <>
          {!dock.maximized && (
            <DockResizeHandle
              height={height}
              clamp={clamp}
              onDrag={setDragHeight}
              onCommit={(h) => setHeight(clusterId, h)}
              onReset={() => setHeight(clusterId, DEFAULT_HEIGHT)}
            />
          )}
          <div className="border-border/70 border-t" />
          <DockTabStrip
            clusterId={clusterId}
            clusterName={clusterName}
            tabs={dock.tabs}
            activeId={dock.activeId}
            maximized={dock.maximized}
            dockFocused={focused}
            onClusterShell={openClusterShell}
            onLocalShell={openLocalShell}
            onCreate={openCreate}
            onToggleMaximize={() => setMaximized(clusterId, !dock.maximized)}
            onMinimize={() => setOpen(clusterId, false)}
          />
        </>
      ) : (
        <DockCollapsedBar
          tabCount={dock.tabs.length}
          activeTitle={activeTab ? tabTitle(activeTab, clusterName) : null}
          onOpen={() => setOpen(clusterId, true)}
          onClusterShell={openClusterShell}
          onCreate={openCreate}
        />
      )}
      <div className={open ? 'relative min-h-0 flex-1' : 'hidden'}>
        {dock.tabs.map((tab) => {
          const isActive = tab.id === dock.activeId;
          return (
            <div key={tab.id} className={isActive ? 'absolute inset-0 flex' : 'hidden'}>
              <DockTabBody clusterId={clusterId} tab={tab} active={visible && open && isActive} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
