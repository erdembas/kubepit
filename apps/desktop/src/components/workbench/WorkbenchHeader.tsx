import * as i18n from '@/i18n';
import { Pencil, Plus, RefreshCw, SquareTerminal, Unplug } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { useElementWidth } from '@/lib/hooks';
import { disconnectCluster, refreshOverview } from '@/lib/clusterActions';
import { templateFor } from '@/lib/kube/templates';
import { useAppStore } from '@/store/useAppStore';
import { dock } from '@/store/useDockStore';
import { gvkForCluster, sharedNamespacesOf } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo, ClusterDef, ClusterStatus } from '@/types';
import { ClusterAvatar, EnvPill, ReadOnlyBadge } from './ClusterAvatar';
import { refreshPolledPrefix } from './data/polled';
import { restartClusterWatches } from './data/watchCache';
import { KindJump } from './header/KindJump';

export function WorkbenchHeader({
  cluster,
  status,
  activeKind,
  apiResources,
  tabSlotRef,
}: {
  cluster: ClusterDef;
  status: ClusterStatus | undefined;
  activeKind: string;
  apiResources: ApiResourceInfo[] | null;
  /** Receives the slot an unsplit workbench's view tabs render into (see `ViewPanes`). */
  tabSlotRef: (node: HTMLDivElement | null) => void;
}) {
  i18n.useLocale();
  // Sized by its own width: side-by-side clusters get narrow headers on wide screens.
  const [headerRef, width] = useElementWidth<HTMLElement>();
  const showVersion = width >= 960;
  const showKindJump = width >= 760;
  // The header's create button and terminal share the workbench scope
  // (the last explicit namespace selection), not any one view's own scope.
  const namespaces = sharedNamespacesOf(cluster.id);
  const scopeNs =
    namespaces?.length === 1 ? namespaces[0]! : (cluster.default_namespace ?? null);
  const version = status?.version?.replace(/^v?(\d+\.\d+\.\d+).*/, 'v$1');

  const refresh = () => {
    restartClusterWatches(cluster.id);
    refreshPolledPrefix(`${cluster.id}|`);
    void refreshOverview(cluster.id);
  };
  const create = () => {
    const gvk = gvkForCluster(cluster.id, activeKind);
    dock.create(cluster.id, scopeNs, templateFor(gvk, scopeNs ?? 'default'));
  };

  return (
    <header
      ref={headerRef}
      aria-label={i18n.t('Cluster workbench')}
      className="border-border/70 bg-surface-raised/30 flex h-11 shrink-0 items-center gap-2 border-b px-3"
    >
      <div className="flex min-w-0 shrink items-center gap-2 overflow-hidden">
        <ClusterAvatar cluster={cluster} />
        <span
          className="text-fg min-w-16 truncate text-[13px] font-semibold tracking-tight"
          title={cluster.context}
        >
          {cluster.name}
        </span>
        <EnvPill cluster={cluster} />
        {showVersion && (status?.platform || version) && (
          <span
            className="bg-fg/5 text-fg-muted shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium"
            title={status?.version ?? undefined}
          >
            {[status?.platform, version].filter(Boolean).join(' · ')}
          </span>
        )}
        {cluster.read_only && <ReadOnlyBadge />}
      </div>
      {/* Stays empty once split: every pane then keeps its own tab strip.
          Shrinks first when crowded, since the tabs scroll, but keeps room
          for one tab, or three compact pins plus a scrollable tab. */}
      <div
        ref={tabSlotRef}
        className="flex min-w-0 flex-auto shrink-[16] self-stretch has-[*]:min-w-24 has-[[data-view-tab-pinned]]:min-w-60"
      />
      {showKindJump && <KindJump clusterId={cluster.id} apiResources={apiResources} />}
      <span className="bg-border/80 mx-1 h-5 w-px shrink-0" aria-hidden />
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton
          label={i18n.t('Open terminal')}
          icon={<SquareTerminal />}
          onClick={() => dock.shell(cluster.id, cluster.name, scopeNs)}
        />
        <IconButton
          label={
            cluster.read_only
              ? i18n.t('Read-only cluster: changes are blocked')
              : i18n.t('Create resource')
          }
          icon={<Plus />}
          disabled={cluster.read_only}
          onClick={create}
        />
        <IconButton label={i18n.t('Refresh')} icon={<RefreshCw />} onClick={refresh} />
        <IconButton
          label={i18n.t('Edit cluster')}
          icon={<Pencil />}
          onClick={() => useAppStore.getState().openClusterEditor({ mode: 'edit', cluster })}
        />
        <IconButton
          label={i18n.t('Disconnect')}
          icon={<Unplug />}
          tone="danger"
          onClick={() => void disconnectCluster(cluster.id)}
        />
      </div>
    </header>
  );
}
