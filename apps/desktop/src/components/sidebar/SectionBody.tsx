import * as i18n from '@/i18n';
import type { ClusterDef, ClusterId, ClusterStatus, SectionId } from '@/types';
import { ClusterRow } from './ClusterRow';
import { itemKey, UNASSIGNED } from './dnd';
import { ReorderRow } from './section-body/ReorderRow';
import { ReorderTail } from './section-body/ReorderTail';

/** Row model used by {@link SectionBody}. */
export type SidebarItem = { kind: 'cluster'; ref: ClusterDef };

export interface BodyProps {
  /** Ordered rows for this bucket (user order, alphabetical fallback). */
  items: SidebarItem[];
  /**
   * Bucket key the drop targets aim at: a section id, or {@link UNASSIGNED}.
   * `null` disables drag-to-reorder (search results, derived groupings).
   */
  bucketId: SectionId | null;
  statuses: Record<ClusterId, ClusterStatus>;
  selectedClusterId: string | null;
  clusterSection: Record<string, SectionId>;
  onSelect: (id: string) => void;
  onEdit: (cluster: ClusterDef) => void;
  onDelete: (cluster: ClusterDef) => void;
  emptyMessage?: string;
}

export function SectionBody({
  items,
  bucketId,
  statuses,
  selectedClusterId,
  clusterSection,
  onSelect,
  onEdit,
  onDelete,
}: BodyProps) {
  i18n.useLocale();
  if (items.length === 0) {
    return (
      <div className="border-border/60 mx-2 my-1 rounded-lg border border-dashed px-3 py-2.5 text-center">
        <p className="text-fg-dim text-[10.5px] leading-tight">{i18n.t('Drop clusters here')}</p>
      </div>
    );
  }

  const targetSectionId =
    bucketId == null || bucketId === UNASSIGNED ? null : (bucketId as SectionId);
  const reorderEnabled = bucketId != null;

  return (
    <ul className="mx-1 space-y-0.5">
      {items.map((item, idx) => {
        const key = itemKey(item.kind, item.ref.id);
        const row = (
          <ClusterRow
            cluster={item.ref}
            status={statuses[item.ref.id]}
            selected={selectedClusterId === item.ref.id}
            currentSectionId={clusterSection[item.ref.id] ?? null}
            onSelect={() => onSelect(item.ref.id)}
            onEdit={() => onEdit(item.ref)}
            onDelete={() => onDelete(item.ref)}
          />
        );
        if (!reorderEnabled) return <li key={key}>{row}</li>;
        return (
          <ReorderRow
            key={key}
            index={idx}
            items={items}
            bucketId={bucketId}
            targetSectionId={targetSectionId}
            itemKeyFor={key}
          >
            {row}
          </ReorderRow>
        );
      })}
      {reorderEnabled && (
        <ReorderTail items={items} bucketId={bucketId} targetSectionId={targetSectionId} />
      )}
    </ul>
  );
}

export function FlatItems(props: BodyProps) {
  i18n.useLocale();
  if (props.items.length === 0) {
    return (
      <div className="text-fg-dim px-3 py-6 text-center text-[12px]">
        {props.emptyMessage ?? i18n.t('No clusters yet.')}
      </div>
    );
  }
  return <SectionBody {...props} />;
}
