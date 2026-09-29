import type { ClusterId, RightsizingReport, WorkloadRecommendation } from '@/types';

/**
 * What `RecommendationsPage` gives every section of its body. Page state
 * that crosses sections (the picked namespace, the list's verdict tab,
 * lenses and sort, the drawer's row) lives in `useRecommendationsView`.
 */
export interface SectionProps {
  clusterId: ClusterId;
  /** The scan shown (the latest, or the picked past run), re-evaluated with the current settings. */
  report: RightsizingReport;
  /** The rows in scope: `filterRecommendations(report.workloads, 'all', namespaces, '')`. */
  rows: WorkloadRecommendation[];
  /** The picked past run (null = the latest), e.g. for `recommendations_export` and poll keys. */
  runId: number | null;
  /** A past run is shown: read-only, nothing is applied. */
  past: boolean;
  /** The cluster is connected (usage charts and apply need it; stored data does not). */
  connected: boolean;
  /** Namespaces in scope: the one picked on the page, else the workbench's (empty = all). */
  namespaces: string[];
}
