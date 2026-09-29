import type { ClusterId, RightsizingReport, WorkloadRecommendation } from '@/types';

export interface ExportMenuProps {
  clusterId: ClusterId;
  /** The picked past run (null = the latest). */
  runId: number | null;
  /** The scan shown; null = nothing to export yet. */
  report: RightsizingReport | null;
  /** The rows in scope (see `SectionProps.rows`). */
  rows: WorkloadRecommendation[];
}

/**
 * The header's Export slot (spec §9.1), filled by Task 24: a JSON / YAML
 * menu that saves `recommendations_export` through `exportRecommendations`.
 * Renders nothing until then.
 */
export function ExportMenu(_props: ExportMenuProps) {
  return null;
}
