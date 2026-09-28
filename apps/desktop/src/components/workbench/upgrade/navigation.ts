import { resolveRef } from '@/lib/kube/catalog';
import { useAppStore } from '@/store/useAppStore';
import { VIEW, navigateTo, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo, ClusterId, UpgradeFinding } from '@/types';

/** Whether a finding has something to open (metrics findings have none). */
export function canOpenFinding(f: UpgradeFinding): boolean {
  return !!f.helm || !!f.object;
}

/** Helm findings open the release, the others their object (details panel selected). */
export function openFinding(
  clusterId: ClusterId,
  f: UpgradeFinding,
  apiResources: readonly ApiResourceInfo[] | null,
) {
  if (f.helm) {
    const store = useWorkbenchStore.getState();
    store.setActiveKind(clusterId, VIEW.helmReleases);
    store.select(clusterId, VIEW.helmReleases, {
      key: VIEW.helmReleases,
      namespace: f.helm.namespace,
      name: f.helm.name,
    });
    return;
  }
  if (!f.object) return;
  const gvk = resolveRef(f.object.api_version, f.object.kind, apiResources);
  if (gvk) navigateTo(clusterId, gvk, f.object.namespace, f.object.name);
}

/** Focus a cluster's workbench on its upgrade readiness view (from the dashboard). */
export function openUpgradeView(clusterId: ClusterId) {
  useWorkbenchStore.getState().setActiveKind(clusterId, VIEW.upgradeReadiness);
  const app = useAppStore.getState();
  if (app.activeMainTabKey !== `cluster:${clusterId}`) app.openCluster(clusterId);
}
