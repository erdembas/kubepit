import { workloadKey } from '@/lib/kube/recommendations/model';
import type { SectionProps } from './sectionProps';
import { UsageRanking } from './UsageRanking';
import { useRecommendationsView } from './viewState';

/**
 * Body section 2 (spec §9.1): `UsageRanking` over `rows` (`rankUsage`);
 * opening a row sets `useRecommendationsView`'s `open` (the drawer).
 */
export function UsageSection({ clusterId, rows }: SectionProps) {
  const [view, update] = useRecommendationsView(clusterId);
  return (
    <UsageRanking
      list={rows}
      active={view.open}
      onOpen={(rec) => update({ open: workloadKey(rec) })}
    />
  );
}
