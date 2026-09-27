import * as i18n from '@/i18n';
import { memo, useMemo } from 'react';
import { Loader2, SearchX } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { gvkForKey } from '@/lib/kube/catalog';
import { VIEW, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo } from '@/types';
import { PermissionsPage } from './access/PermissionsPage';
import { ApiExplorerPage } from './explain/ApiExplorerPage';
import { HelmChartsPage } from './helm/HelmChartsPage';
import { HelmPage } from './helm/HelmPage';
import { ClusterOverviewPage } from './overview/ClusterOverviewPage';
import { WorkloadsOverviewPage } from './overview/WorkloadsOverviewPage';
import { PortForwardsPage } from './portforward/PortForwardsPage';
import { ResourcePage } from './table/ResourcePage';

/**
 * Renders the page of one view tab. Hidden tabs stay mounted with
 * `isActive` false, so their watches and polls pause but scroll position,
 * checked rows and the details panel survive tab switches.
 */
export const ViewHost = memo(function ViewHost({
  clusterId,
  viewKey: activeKind,
  isActive,
  namespaces,
  apiResources,
}: {
  clusterId: string;
  viewKey: string;
  isActive: boolean;
  namespaces: string[];
  apiResources: ApiResourceInfo[] | null;
}) {
  i18n.useLocale();
  const custom = useWorkbenchStore((s) => s.customKinds[clusterId]?.[activeKind]);
  const gvk = useMemo(
    () => gvkForKey(activeKind, apiResources) ?? custom ?? null,
    [activeKind, apiResources, custom],
  );

  if (activeKind === VIEW.clusterOverview)
    return (
      <ClusterOverviewPage clusterId={clusterId} isActive={isActive} apiResources={apiResources} />
    );
  if (activeKind === VIEW.workloadsOverview)
    return (
      <WorkloadsOverviewPage
        clusterId={clusterId}
        namespaces={namespaces}
        isActive={isActive}
        apiResources={apiResources}
      />
    );
  if (activeKind === VIEW.portForwards)
    return <PortForwardsPage clusterId={clusterId} isActive={isActive} />;
  if (activeKind === VIEW.helmReleases)
    return <HelmPage clusterId={clusterId} namespaces={namespaces} isActive={isActive} />;
  if (activeKind === VIEW.myPermissions)
    return (
      <PermissionsPage
        clusterId={clusterId}
        namespaces={namespaces}
        isActive={isActive}
        apiResources={apiResources}
      />
    );
  if (activeKind === VIEW.helmCharts)
    return <HelmChartsPage clusterId={clusterId} namespaces={namespaces} isActive={isActive} />;
  if (activeKind === VIEW.apiExplorer)
    return (
      <ApiExplorerPage clusterId={clusterId} isActive={isActive} apiResources={apiResources} />
    );
  if (!gvk) {
    return apiResources ? (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <div className="bg-fg/5 text-fg-dim mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl">
            <SearchX className="h-5 w-5" />
          </div>
          <h3 className="text-fg text-[13.5px] font-semibold">
            {i18n.t('This kind is not served by the cluster')}
          </h3>
          <p className="text-fg-muted mt-1.5 font-mono text-[11.5px]">{activeKind}</p>
          <Button
            className="mt-4"
            size="sm"
            variant="secondary"
            onClick={() =>
              useWorkbenchStore.getState().setActiveKind(clusterId, VIEW.clusterOverview)
            }
          >
            {i18n.t('Go to overview')}
          </Button>
        </div>
      </div>
    ) : (
      <div className="text-fg-muted flex flex-1 items-center justify-center gap-2 text-[12px]">
        <Loader2 className="h-4 w-4 animate-spin" />
        {i18n.t('Discovering API resources…')}
      </div>
    );
  }
  return (
    <ResourcePage
      key={activeKind}
      clusterId={clusterId}
      kindKey={activeKind}
      gvk={gvk}
      namespaces={namespaces}
      isActive={isActive}
      apiResources={apiResources}
    />
  );
});
