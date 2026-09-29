import * as i18n from '@/i18n';
import { useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { gvkForKey } from '@/lib/kube/catalog';
import { kindIcon } from '@/lib/kube/icons';
import { nodeId, TOPOLOGY_SOURCE_COUNT, type SlotScope, type TopoNode } from '@/lib/kube/topology';
import { useWorkbenchStore, VIEW } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo } from '@/types';
import { DetailsPanel } from '../details/DetailsPanel';
import { useMapFocus } from './mapNavigation';
import { TopologyMap } from './TopologyMap';
import { useTopologyData } from './useTopologyData';
// NetworkPolicy simulator: reachability overlay from the selected pod.
import { MapReachabilityToggle, useMapReachability } from '../netpol/MapReachability';
import { useNetpolViewState } from '../netpol/netpolStore';

/**
 * Namespace "Resource Map": every object in the selected namespaces and how
 * they relate, live from the shared watches. Clicking a node opens its
 * details beside the map, like a table row.
 */
export function ResourceMapPage({
  clusterId,
  namespaces,
  isActive,
  apiResources,
}: {
  clusterId: string;
  namespaces: string[];
  isActive: boolean;
  apiResources: ApiResourceInfo[] | null;
}) {
  i18n.useLocale();
  // Every slot watches the selected namespaces.
  const slotScopes = useMemo(
    () => Array<SlotScope>(TOPOLOGY_SOURCE_COUNT).fill(namespaces),
    [namespaces],
  );
  // The reachability overlay reads the whole graph: only then does it come back from the engine.
  const overlayOn = useNetpolViewState(clusterId).mapOverlay;
  const data = useTopologyData(clusterId, slotScopes, isActive, apiResources, null, undefined, {
    withGraph: overlayOn,
  });
  const selection = useWorkbenchStore((s) => s.selection[clusterId]?.[VIEW.resourceMap] ?? null);
  const focusRequest = useMapFocus((s) => (s.request?.clusterId === clusterId ? s.request : null));
  const selectedId = selection ? nodeId(selection.key, selection.namespace, selection.name) : null;
  const { gvkFor } = data;
  const selectedGvk = useMemo(
    () => (selection ? (gvkForKey(selection.key, apiResources) ?? gvkFor(selection.key)) : null),
    [selection, apiResources, gvkFor],
  );
  const Icon = kindIcon(VIEW.resourceMap);
  const reach = useMapReachability({
    clusterId,
    namespaces,
    isActive,
    apiResources,
    graph: data.graph,
    selection,
  });

  const onOpen = (node: TopoNode) =>
    useWorkbenchStore.getState().select(clusterId, VIEW.resourceMap, {
      key: node.kindKey,
      namespace: node.namespace,
      name: node.name,
    });

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="border-border/60 flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <span className="bg-accent/10 text-accent flex h-6 w-6 shrink-0 items-center justify-center rounded-md">
            <Icon className="h-3.5 w-3.5" />
          </span>
          <h2 className="text-fg shrink-0 truncate text-[13px] font-semibold">
            {i18n.t('Resource Map')}
          </h2>
          <span className="text-fg-dim hidden truncate text-[11px] lg:inline">
            {namespaces.length === 0
              ? i18n.t('All namespaces')
              : namespaces.length === 1
                ? namespaces[0]
                : i18n.t('{count} namespaces', { count: namespaces.length })}
          </span>
          {data.loading && data.synced && (
            <Loader2 className="text-fg-dim h-3 w-3 animate-spin" aria-label={i18n.t('Syncing')} />
          )}
          <span className="ml-auto" />
          <MapReachabilityToggle reach={reach} />
        </div>
        <TopologyMap
          label={i18n.t('Resource Map')}
          model={data.model}
          rootId={null}
          hops={1}
          selectedId={selectedId}
          showNamespace={namespaces.length !== 1}
          persistKey="namespace"
          errors={data.errors}
          fitKey={`${clusterId}|${namespaces.join(',')}`}
          focusRequest={focusRequest}
          onOpen={onOpen}
          emptyText={i18n.t('Nothing to map in the selected namespaces.')}
          overlay={reach.overlay}
          overlayNotice={reach.notice}
          footer={({ objects, relationships }) => (
            <div className="border-border/60 text-fg-dim flex h-7 shrink-0 items-center gap-2 border-t px-4 text-[11px] tabular-nums">
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  data.errors.length
                    ? 'bg-status-starting'
                    : data.synced && isActive
                      ? 'bg-status-running animate-breathe'
                      : 'bg-fg-dim/50',
                )}
              />
              <span>
                {!isActive ? i18n.t('Paused') : data.synced ? i18n.t('Live') : i18n.t('Loading…')}
              </span>
              <span className="text-fg-dim/40">·</span>
              <span>{i18n.plural('{count} object', '{count} objects', objects)}</span>
              <span className="text-fg-dim/40">·</span>
              <span>
                {i18n.plural('{count} relationship', '{count} relationships', relationships)}
              </span>
            </div>
          )}
        />
      </div>
      {selection && selectedGvk && (
        <DetailsPanel
          clusterId={clusterId}
          gvk={selectedGvk}
          kindKey={selection.key}
          viewKey={VIEW.resourceMap}
          selection={selection}
          liveObject={selectedId ? data.objectFor(selectedId) : null}
          isActive={isActive}
          apiResources={apiResources}
        />
      )}
    </div>
  );
}
