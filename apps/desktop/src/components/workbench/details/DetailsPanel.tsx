import * as i18n from '@/i18n';
import { useEffect, useMemo, useState } from 'react';
import { Bell, FileCode2, History, Info, Loader2, X } from 'lucide-react';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { ipc } from '@/lib/ipc';
import { resolveRef } from '@/lib/kube/catalog';
import type { ColumnContext } from '@/lib/kube/columns';
import { kindIcon } from '@/lib/kube/icons';
import { cn } from '@/lib/cn';
import { formatAge } from '@/lib/format';
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
import { useDragWidth } from '../useDragWidth';
import { isTypingTarget, useNow } from '../util';
import { DetailsOverview } from './DetailsOverview';
import { DetailsToolbar } from './DetailsToolbar';
import { EventsTab } from './EventsTab';
import { YamlTab } from './YamlTab';
// Workload operations: rollout history tab, opened by actions through detailsTabs.
import { hasRollout } from '@/lib/kube/rollout';
import { requestFor, useDetailsTabRequest } from './detailsTabs';
import { HistoryTab } from './HistoryTab';

type Tab = 'details' | 'yaml' | 'events' | 'history';

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
}: {
  clusterId: string;
  gvk: Gvk;
  kindKey: string;
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
  const close = () => useWorkbenchStore.getState().select(clusterId, kindKey, null);
  const tabRequest = useDetailsTabRequest((s) =>
    requestFor(s.request, clusterId, obj?.metadata.uid),
  );
  useEffect(() => {
    if (tabRequest) setTab(tabRequest.tab);
  }, [tabRequest]);

  useEffect(() => {
    if (!isActive) return;
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
  }, [isActive, clusterId]);

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
  const tabs: Array<{ id: Tab; label: string; icon: typeof Info }> = [
    { id: 'details', label: i18n.t('Details'), icon: Info },
    { id: 'yaml', label: 'YAML', icon: FileCode2 },
    { id: 'events', label: i18n.t('Events'), icon: Bell },
    ...(obj && hasRollout(obj)
      ? [{ id: 'history' as const, label: i18n.t('History'), icon: History }]
      : []),
  ];

  return (
    <aside
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
      <header className="border-border/60 flex min-h-12 shrink-0 items-center gap-2.5 border-b px-3 py-2">
        <span className="bg-accent/10 text-accent flex h-7 w-7 shrink-0 items-center justify-center rounded-lg">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-fg truncate text-[13px] font-semibold" title={selection.name}>
            {selection.name}
          </h2>
          <p className="text-fg-dim truncate text-[11px]">
            {gvk.kind}
            {selection.namespace && <> · {selection.namespace}</>}
            {obj?.metadata.creationTimestamp && (
              <> · {formatAge(obj.metadata.creationTimestamp, now)}</>
            )}
          </p>
        </div>
        {obj && <DetailsToolbar clusterId={clusterId} actions={actions} readOnly={readOnly} />}
        <span className="bg-border/80 mx-0.5 h-5 w-px shrink-0" aria-hidden />
        <button
          type="button"
          onClick={close}
          aria-label={i18n.t('Close details')}
          title={i18n.t('Close (Esc)')}
          className="text-fg-dim hover:bg-fg/5 hover:text-fg rounded-md p-1.5"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      <nav
        role="tablist"
        aria-label={i18n.t('Details tabs')}
        className="border-border/60 flex h-10 shrink-0 items-center gap-1 border-b px-3"
      >
        {tabs.map(({ id, label, icon: TabIcon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] transition',
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
      ) : tab === 'details' || (tab === 'history' && !hasRollout(obj)) ? (
        <div className="overlay-scroll min-h-0 flex-1 overflow-auto">
          <DetailsOverview obj={obj} gvk={gvk} ctx={ctx} isActive={isActive} readOnly={readOnly} />
        </div>
      ) : tab === 'history' ? (
        <HistoryTab {...{ clusterId, gvk, obj, readOnly, isActive }} />
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
