import { useCallback } from 'react';
import { create } from 'zustand';
import type { RecSort } from '@/lib/kube/recommendations/model';
import type { RightsizingFilter } from '@/lib/kube/rightsizing/model';
import type { ClusterId, RecommendationLens } from '@/types';

/**
 * What the sections of a cluster's Recommendations view share (session
 * only): the namespace picked on the page (capacity overview), the list's
 * verdict tab, lenses and sort (the Attention tile sets the tab), and the
 * workload shown in the drawer (`workloadKey`, also set from outside the
 * view, e.g. "Open in Recommendations"). The list's search text is the
 * workbench filter of the view, like every other page.
 */

export interface RecommendationsView {
  /** Narrows the page to one namespace (null = the workbench scope). */
  namespace: string | null;
  filter: RightsizingFilter;
  lenses: RecommendationLens[];
  sort: RecSort;
  /** `workloadKey` of the row open in the drawer. */
  open: string | null;
}

export const DEFAULT_VIEW: RecommendationsView = {
  namespace: null,
  filter: 'changed',
  lenses: [],
  sort: 'priority',
  open: null,
};

interface ViewStore {
  byCluster: Record<ClusterId, RecommendationsView>;
  update: (clusterId: ClusterId, patch: Partial<RecommendationsView>) => void;
}

export const useRecommendationsViewStore = create<ViewStore>()((set) => ({
  byCluster: {},
  update: (clusterId, patch) =>
    set((s) => ({
      byCluster: {
        ...s.byCluster,
        [clusterId]: { ...(s.byCluster[clusterId] ?? DEFAULT_VIEW), ...patch },
      },
    })),
}));

/** Updates a cluster's view state (also from outside the view). */
export function updateRecommendationsView(
  clusterId: ClusterId,
  patch: Partial<RecommendationsView>,
): void {
  useRecommendationsViewStore.getState().update(clusterId, patch);
}

/** The view state of a cluster and its updater (stable per cluster). */
export function useRecommendationsView(
  clusterId: ClusterId,
): [RecommendationsView, (patch: Partial<RecommendationsView>) => void] {
  const view = useRecommendationsViewStore((s) => s.byCluster[clusterId] ?? DEFAULT_VIEW);
  const update = useCallback(
    (patch: Partial<RecommendationsView>) => updateRecommendationsView(clusterId, patch),
    [clusterId],
  );
  return [view, update];
}
