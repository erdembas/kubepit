import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useCallback, useState } from 'react';
import type { WorkloadRecommendation } from '@/types';
import { RightsizingDialog } from '../cost/RightsizingDialog';
import { DrawerFrame, MissingRecommendation, RecommendationDrawer } from './RecommendationDrawer';
import { findRecommendation } from './drawerModel';
import type { SectionProps } from './sectionProps';
import { updateRecommendationsView, useRecommendationsView } from './viewState';

/**
 * The detail drawer beside `ListSection` (spec §9.1): `RecommendationDrawer`
 * for the row whose `workloadKey` is `useRecommendationsView`'s `open`,
 * looked up in the whole report (the list's filters do not hide it; other
 * sections and "Open in Recommendations" set `open` too). Closing clears
 * `open`. Apply opens the audited `RightsizingDialog`; one-click apply
 * (Task 26) plugs into `onApply`.
 */
export function DrawerSection({ clusterId, report, runId, past, connected }: SectionProps) {
  i18n.useLocale();
  const [view] = useRecommendationsView(clusterId);
  const rec = useMemo(() => findRecommendation(report, view.open), [report, view.open]);
  const [reviewing, setReviewing] = useState<WorkloadRecommendation | null>(null);
  const close = useCallback(
    () => updateRecommendationsView(clusterId, { open: null }),
    [clusterId],
  );
  const review = useCallback((r: WorkloadRecommendation) => setReviewing(r), []);

  return (
    <>
      {view.open &&
        (rec ? (
          <RecommendationDrawer
            clusterId={clusterId}
            rec={rec}
            report={report}
            runId={runId}
            past={past}
            connected={connected}
            onClose={close}
            onApply={review}
            onReview={review}
          />
        ) : (
          <DrawerFrame label={view.open} openKey={view.open} onClose={close}>
            <MissingRecommendation openKey={view.open} onClose={close} />
          </DrawerFrame>
        ))}
      {reviewing && (
        <RightsizingDialog
          clusterId={clusterId}
          rec={reviewing}
          currency={report.currency}
          onClose={() => setReviewing(null)}
        />
      )}
    </>
  );
}
