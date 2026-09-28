import * as i18n from '@/i18n';
import { useEffect, useRef, useState } from 'react';
import { useWorkbenchStore, VIEW } from '@/store/useWorkbenchStore';
import { ActionDialogs } from './actions/ActionDialogs';
import { ConnectScreen } from './ConnectScreen';
import { useApiResources, useCluster, useSelectedNamespaces } from './data/hooks';
import { dropPolledPrefix } from './data/polled';
import { dropClusterWatches } from './data/watchCache';
import { ClusterDock } from './dock/ClusterDock';
import { ResourceNavigator } from './nav/ResourceNavigator';
import { ViewPanes } from './tabs/ViewPanes';
import { WorkbenchHeader } from './WorkbenchHeader';
import { WizardHost } from './wizards/WizardHost';

/**
 * One cluster tab. The shell keeps hidden workbenches mounted, so every
 * watch and poll below is gated on `isActive`; state survives tab switches.
 *
 * The dock stays mounted at the same tree position in every connection
 * state: terminals are local PTYs (kubectl + generated kubeconfig) and must
 * survive a disconnect.
 */
export function ClusterWorkbench({
  clusterId,
  isActive,
}: {
  clusterId: string;
  isActive: boolean;
}) {
  i18n.useLocale();
  const { cluster, status } = useCluster(clusterId);
  const state = status?.state ?? 'disconnected';
  const connected = state === 'connected' && !!cluster;
  const wasConnected = useRef(false);
  // Header slot the lone pane's view tabs render into (see `ViewPanes`).
  const [tabSlot, setTabSlot] = useState<HTMLDivElement | null>(null);
  const apiResources = useApiResources(clusterId, isActive && connected);
  const activeKind = useWorkbenchStore((s) => s.activeKind[clusterId] ?? VIEW.clusterOverview);
  const namespaces = useSelectedNamespaces(clusterId);

  // Forget cached lists and discovery once a cluster disconnects.
  useEffect(() => {
    if (state === 'connected') wasConnected.current = true;
    else if ((state === 'disconnected' || state === 'error') && wasConnected.current) {
      wasConnected.current = false;
      dropClusterWatches(clusterId);
      dropPolledPrefix(`${clusterId}|`);
      useWorkbenchStore.getState().forgetCluster(clusterId);
    }
  }, [state, clusterId]);

  if (!cluster)
    return (
      <p className="text-fg-muted p-5 text-[12px]">{i18n.t('This cluster no longer exists.')}</p>
    );
  return (
    <div
      className="bg-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      aria-label={i18n.t('Cluster workbench')}
      data-workbench=""
    >
      {connected && (
        <WorkbenchHeader
          cluster={cluster}
          status={status}
          isActive={isActive}
          activeKind={activeKind}
          apiResources={apiResources}
          tabSlotRef={setTabSlot}
        />
      )}
      <div className="flex min-h-0 flex-1">
        {connected && (
          <ResourceNavigator
            clusterId={clusterId}
            activeKind={activeKind}
            apiResources={apiResources}
          />
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {connected ? (
              <ViewPanes
                clusterId={clusterId}
                isActive={isActive}
                namespaces={namespaces}
                apiResources={apiResources}
                tabSlot={tabSlot}
              />
            ) : (
              <ConnectScreen cluster={cluster} status={status} />
            )}
          </div>
          <ClusterDock clusterId={clusterId} visible={isActive} />
        </div>
      </div>
      {isActive && connected && <ActionDialogs clusterId={clusterId} />}
      {isActive && connected && <WizardHost clusterId={clusterId} />}
    </div>
  );
}
