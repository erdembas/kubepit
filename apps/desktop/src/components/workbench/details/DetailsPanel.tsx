import * as i18n from '@/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Bell, FileCode2, FileDiff, History, Info, Loader2, Stethoscope, X } from 'lucide-react';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { ipc } from '@/lib/ipc';
import { resolveRef } from '@/lib/kube/catalog';
import type { ColumnContext } from '@/lib/kube/columns';
import { kindIcon } from '@/lib/kube/icons';
import { cn } from '@/lib/cn';
import { formatAge } from '@/lib/format';
import { horizontalWheelDelta } from '@/lib/ui/wheelScroll';
import { useAppStore } from '@/store/useAppStore';
import {
  DETAILS_WIDTH,
  navigateTo,
  useWorkbenchStore,
  type ObjectSelection,
} from '@/store/useWorkbenchStore';
import type { ApiResourceInfo, Gvk, KubeObject } from '@/types';
import { resourceActions } from '../actions/resourceActions';
import { useActionDialogs } from '../actions/dialogStore';
import { useCluster, useNodeMetrics, usePodMetrics } from '../data/hooks';
import { usePolled } from '../data/polled';
import { usePaneFocused } from '@/components/split/paneFocus';
import { useDragWidth } from '../useDragWidth';
import { isTypingTarget, useNow } from '../util';
import { BookmarkButton } from './BookmarkButton';
import { DetailsOverview } from './DetailsOverview';
import { DetailsToolbar } from './DetailsToolbar';
import { EventsTab } from './EventsTab';
import { YamlTab } from './YamlTab';
// Workload operations: rollout history tab, opened by actions through detailsTabs.
import { hasRollout } from '@/lib/kube/rollout';
import { requestFor, useDetailsTabRequest } from './detailsTabs';
import { HistoryTab } from './HistoryTab';
// Resource relationship map: the object's neighbourhood.
import { Workflow } from 'lucide-react';
import { MapTab } from '../topology/MapTab';
import { GitOpsBadge } from '../gitops/ManagedNotice';
// Change timeline: journaled changes of this object.
import { isJournaled } from '@/lib/kube/changes/kinds';
import { ChangesTab } from './ChangesTab';
// NetworkPolicy simulator: who can reach this pod / workload.
import { Radar } from 'lucide-react';
import { hasReachability } from '@/lib/kube/netpol/subject';
import { ReachabilityTab } from '../netpol/ReachabilityTab';
import { PodDiagnosisTab } from '../troubleshooting/PodDiagnosisTab';

type Tab =
  'details' | 'yaml' | 'events' | 'history' | 'map' | 'changes' | 'reachability' | 'diagnosis';

const POD_METRIC_KINDS = new Set([
  'Pod',
  'Node',
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'ReplicationController',
  'Job',
  'Service',
  'PersistentVolumeClaim',
]);

/** Freelens-style details panel docked to the right of the table. */
export function DetailsPanel({
  clusterId,
  gvk,
  kindKey,
  selection,
  liveObject,
  isActive,
  apiResources,
  viewKey,
}: {
  clusterId: string;
  gvk: Gvk;
  kindKey: string;
  /**
   * View tab whose selection this panel shows (defaults to `kindKey`; the
   * resource map and the GitOps overview host details for other kinds).
   */
  viewKey?: string;
  selection: ObjectSelection;
  liveObject: KubeObject | null;
  isActive: boolean;
  apiResources: ApiResourceInfo[] | null;
}) {
  i18n.useLocale();
  const [tab, setTab] = useState<Tab>('details');
  const { cluster, readOnly } = useCluster(clusterId);
  const width = useWorkbenchStore((s) => s.detailsWidth);
  const drag = useDragWidth({
    width,
    setWidth: (w) => useWorkbenchStore.getState().setDetailsWidth(w),
    min: DETAILS_WIDTH.min,
    max: Math.min(DETAILS_WIDTH.max, Math.round(window.innerWidth * 0.7)),
    defaultWidth: DETAILS_WIDTH.default,
    edge: 'left',
  });
  // Objects outside the watched namespaces (links) are fetched and polled instead.
  const fetched = usePolled<KubeObject>(
    liveObject
      ? null
      : `${clusterId}|get|${kindKey}|${selection.namespace ?? ''}|${selection.name}`,
    () => ipc.resourceGet(clusterId, gvk, selection.namespace, selection.name),
    10_000,
    isActive,
  );
  const obj = liveObject ?? fetched.data ?? null;
  const close = () => useWorkbenchStore.getState().select(clusterId, viewKey ?? kindKey, null);
  const tabRequest = useDetailsTabRequest((s) =>
    requestFor(s.request, clusterId, obj?.metadata.uid),
  );
  useEffect(() => {
    if (tabRequest) setTab(tabRequest.tab);
  }, [tabRequest]);
  const paneFocused = usePaneFocused();

  useEffect(() => {
    if (!isActive || !paneFocused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (
        isTypingTarget(e.target) ||
        useAppStore.getState().confirm ||
        useActionDialogs.getState().dialog
      )
        return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, paneFocused, clusterId]);

  // A click on the pane's empty workspace area closes the panel too, like Esc
  // (Settings → General). Only this panel's pane dismisses it: the click must
  // land on no control, selection drag or open overlay, and the panel's own
  // surfaces and hidden tab copies never react.
  const clickClose = useAppStore((s) => s.settings?.details_click_close ?? true);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!isActive || !clickClose) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      const panel = panelRef.current;
      if (!target || !panel || !panel.offsetParent || panel.contains(target)) return;
      const pane = panel.closest('[data-pane-root]');
      if (!pane || !pane.contains(target)) return;
      if (
        target.closest(
          'button, a, input, textarea, select, label, summary, [role="menu"], [role="dialog"], [role="alertdialog"], [role="tab"], [role="tablist"], [role="separator"], [role="slider"], [role="row"], [role="rowgroup"], [role="treeitem"], [role="option"], [role="listbox"], [data-resize-handle], [data-tauri-drag-region]',
        )
      )
        return;
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      close();
    };
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, clickClose, clusterId]);

  const now = useNow(30_000, isActive);
  const isNode = obj?.kind === 'Node';
  const wantsPodMetrics = !!obj && POD_METRIC_KINDS.has(obj.kind);
  const podMetrics = usePodMetrics(
    clusterId,
    obj?.metadata.namespace ? [obj.metadata.namespace] : [],
    isActive && wantsPodMetrics,
  );
  const nodeMetrics = useNodeMetrics(clusterId, isActive && isNode);
  const ctx: ColumnContext = useMemo(
    () => ({
      clusterId,
      now,
      apiResources,
      podMetrics,
      nodeMetrics,
      navigate: (ref) => {
        const target = resolveRef(ref.apiVersion, ref.kind, apiResources);
        if (target) navigateTo(clusterId, target, ref.namespace ?? null, ref.name);
      },
    }),
    [clusterId, now, apiResources, podMetrics, nodeMetrics],
  );
  const actions = useMemo(
    () => (obj ? resourceActions({ clusterId, cluster, gvk, obj, onDeleted: close }) : []),
    [obj, clusterId, cluster, gvk],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const Icon = kindIcon(kindKey);
  // Kind · namespace · age; also the tooltip when a narrow header truncates it.
  const subtitle = [
    gvk.kind,
    selection.namespace,
    obj?.metadata.creationTimestamp ? formatAge(obj.metadata.creationTimestamp, now) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const tabs: Array<{ id: Tab; label: string; icon: typeof Info }> = [
    { id: 'details', label: i18n.t('Details'), icon: Info },
    ...(gvk.kind === 'Pod' && gvk.group === ''
      ? [{ id: 'diagnosis' as const, label: i18n.t('Diagnosis'), icon: Stethoscope }]
      : []),
    { id: 'yaml', label: 'YAML', icon: FileCode2 },
    { id: 'events', label: i18n.t('Events'), icon: Bell },
    ...(obj && hasRollout(obj)
      ? [{ id: 'history' as const, label: i18n.t('History'), icon: History }]
      : []),
    { id: 'map', label: i18n.t('Map'), icon: Workflow },
    ...(obj && isJournaled(obj)
      ? [{ id: 'changes' as const, label: i18n.t('Changes'), icon: FileDiff }]
      : []),
    ...(obj && hasReachability(obj)
      ? [{ id: 'reachability' as const, label: i18n.t('Reachability'), icon: Radar }]
      : []),
  ];

  // The strip overflows at narrow widths: keep the active tab in view (tab
  // requests usually open the right-most tabs) and let the wheel scroll it.
  const tabStrip = useRef<HTMLElement>(null);
  useEffect(() => {
    tabStrip.current
      ?.querySelector(`[data-details-tab="${tab}"]`)
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [tab, tabs.length]);
  useEffect(() => {
    const el = tabStrip.current;
    if (!el) return;
    // Native and non-passive, so the strip takes the whole wheel movement
    // (no double scroll on trackpads); pinch zoom (ctrl) is left alone.
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || el.scrollWidth <= el.clientWidth) return;
      const delta = horizontalWheelDelta(e);
      if (!delta) return;
      e.preventDefault();
      el.scrollLeft += delta;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <aside
      ref={panelRef}
      aria-label={i18n.t('{kind} details', { kind: gvk.kind })}
      className="border-border bg-surface animate-slide-in-right relative flex min-h-0 shrink-0 flex-col border-l shadow-[-12px_0_32px_-24px_rgb(0_0_0/0.45)]"
      style={{ width: drag.width, maxWidth: '72%' }}
    >
      <ResizeHandle
        handleProps={drag.handleProps}
        dragging={drag.dragging}
        className="focus-visible:bg-accent/15 absolute inset-y-0 -left-1 w-2 touch-none focus-visible:outline-none"
        title={i18n.t('Resize details · drag or use ←/→ · double-click to reset')}
      />
      {/*
       * The header is a size container: below 32rem the actions move to their
       * own row under the name (`order-last basis-full`), so the name keeps the
       * whole first row beside the icon and the close button.
       */}
      <header className="border-border/60 @container flex min-h-12 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b px-3 py-2">
        <span className="bg-accent/10 text-accent flex h-7 w-7 shrink-0 items-center justify-center rounded-lg">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1 basis-32">
          <h2 className="text-fg truncate text-[13px] font-semibold" title={selection.name}>
            {selection.name}
          </h2>
          <p className="text-fg-dim truncate text-[11px]" title={subtitle}>
            {subtitle}
          </p>
          {obj && <GitOpsBadge clusterId={clusterId} obj={obj} isActive={isActive} />}
        </div>
        <div className="order-last flex basis-full flex-wrap items-center gap-0.5 pl-9.5 @lg:order-none @lg:basis-auto @lg:pl-0">
          <BookmarkButton
            clusterId={clusterId}
            gvk={gvk}
            namespace={selection.namespace}
            name={selection.name}
          />
          {obj && <DetailsToolbar clusterId={clusterId} actions={actions} readOnly={readOnly} />}
        </div>
        <span className="bg-border/80 mx-0.5 hidden h-5 w-px shrink-0 @lg:block" aria-hidden />
        <button
          type="button"
          onClick={close}
          aria-label={i18n.t('Close details')}
          title={i18n.t('Close (Esc)')}
          className="text-fg-dim hover:bg-fg/5 hover:text-fg shrink-0 rounded-md p-1.5"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      <nav
        ref={tabStrip}
        role="tablist"
        aria-label={i18n.t('Details tabs')}
        className="border-border/60 main-tabbar-scroll flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b px-3"
      >
        {tabs.map(({ id, label, icon: TabIcon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            data-details-tab={id}
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] transition',
              tab === id
                ? 'bg-fg/7 text-fg font-medium'
                : 'text-fg-dim hover:bg-fg/4 hover:text-fg',
            )}
          >
            <TabIcon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </nav>
      {!obj ? (
        <div className="text-fg-muted flex flex-1 items-center justify-center gap-2 p-6 text-[12px]">
          {fetched.error ? (
            <span className="text-status-error text-center break-words">{fetched.error}</span>
          ) : (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {i18n.t('Loading…')}
            </>
          )}
        </div>
      ) : tab === 'details' ||
        (tab === 'diagnosis' && (obj.kind !== 'Pod' || gvk.group !== '')) ||
        (tab === 'history' && !hasRollout(obj)) ||
        (tab === 'changes' && !isJournaled(obj)) ||
        (tab === 'reachability' && !hasReachability(obj)) ? (
        <div data-details-scroll className="overlay-scroll min-h-0 flex-1 overflow-auto">
          <DetailsOverview obj={obj} gvk={gvk} ctx={ctx} isActive={isActive} readOnly={readOnly} />
        </div>
      ) : tab === 'diagnosis' ? (
        <PodDiagnosisTab
          clusterId={clusterId}
          obj={obj}
          isActive={isActive}
          ctx={ctx}
          onEvents={() => setTab('events')}
          onDetails={() => setTab('details')}
        />
      ) : tab === 'history' ? (
        <HistoryTab {...{ clusterId, gvk, obj, readOnly, isActive }} />
      ) : tab === 'map' ? (
        <MapTab
          clusterId={clusterId}
          gvk={gvk}
          obj={obj}
          isActive={isActive}
          apiResources={apiResources}
          onShowDetails={() => setTab('details')}
        />
      ) : tab === 'changes' ? (
        <ChangesTab clusterId={clusterId} obj={obj} isActive={isActive} />
      ) : tab === 'reachability' ? (
        <ReachabilityTab
          clusterId={clusterId}
          gvk={gvk}
          obj={obj}
          isActive={isActive}
          apiResources={apiResources}
        />
      ) : tab === 'yaml' ? (
        <YamlTab
          clusterId={clusterId}
          gvk={gvk}
          obj={obj}
          readOnly={readOnly}
          isActive={isActive}
        />
      ) : (
        <EventsTab clusterId={clusterId} obj={obj} isActive={isActive} ctx={ctx} />
      )}
    </aside>
  );
}
