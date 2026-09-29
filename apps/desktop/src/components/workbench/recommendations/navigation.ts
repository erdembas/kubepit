import { openAndConnect } from '@/lib/clusterActions';
import { VIEW, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ClusterId } from '@/types';
import { updateRecommendationsView } from './viewState';

/**
 * Open a cluster's Recommendations view from outside its workbench (the
 * dashboard): its tab comes to the front and a disconnected cluster
 * connects, like opening it from its card. `open` (a `workloadKey`) also
 * shows that workload in the drawer.
 */
export function openRecommendationsView(clusterId: ClusterId, open?: string) {
  if (open !== undefined) updateRecommendationsView(clusterId, { open });
  useWorkbenchStore.getState().setActiveKind(clusterId, VIEW.recommendations);
  openAndConnect(clusterId);
}
