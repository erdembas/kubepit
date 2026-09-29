import { useMemo } from 'react';
import { optimizationTotals, workloadKey } from '@/lib/kube/recommendations/model';
import { useRecommendationsStore } from '@/store/useRecommendationsStore';
import { CapacityOverview } from './CapacityOverview';
import { ReviewSpotlight } from './ReviewSpotlight';
import { AttentionTile, InventoryTile, OptimizationSummary } from './SummaryCards';
import type { SectionProps } from './sectionProps';
import { useRecommendationsView } from './viewState';

const NO_APPLIED: Record<string, number> = {};

/**
 * Body section 1 (spec §9.1): `OptimizationSummary` with the Attention and
 * Inventory tiles beside `CapacityOverview`, then `ReviewSpotlight`, in
 * `grid gap-3 @3xl:grid-cols-2`. Clicks only change the shared view state:
 * Attention shows the under-provisioned rows in the list, a namespace
 * narrows the page to it (again: back to the scope), Review opens the row
 * in the drawer.
 */
export function SummarySection({ clusterId, report, rows }: SectionProps) {
  const [view, update] = useRecommendationsView(clusterId);
  const totals = useMemo(() => optimizationTotals(rows), [rows]);
  const applied = useRecommendationsStore((s) => s.byCluster[clusterId]?.applied ?? NO_APPLIED);

  return (
    <div className="grid gap-3 @3xl:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-3">
        <OptimizationSummary totals={totals} currency={report.currency} />
        <div className="grid grid-cols-2 gap-3">
          <AttentionTile
            count={totals.under}
            onClick={() => update({ filter: 'under', lenses: [] })}
          />
          <InventoryTile
            workloads={totals.workloads}
            containers={totals.containers}
            namespaces={totals.namespaces}
          />
        </div>
      </div>
      <CapacityOverview
        list={rows}
        active={view.namespace}
        onNamespace={(namespace) =>
          update({ namespace: view.namespace === namespace ? null : namespace })
        }
      />
      <ReviewSpotlight
        className="@3xl:col-span-2"
        list={rows}
        currency={report.currency}
        active={view.open}
        applied={applied}
        onReview={(rec) => update({ open: workloadKey(rec) })}
      />
    </div>
  );
}
