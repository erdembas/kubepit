import * as i18n from '@/i18n';
import { SectionBlock } from './SectionBlock';
import { FlatItems, SectionBody, type SidebarItem } from './SectionBody';
import { UnassignedBlock } from './UnassignedBlock';
import { UNASSIGNED } from './dnd';
import type { ClusterDef, ClusterStatus, Section, SectionId } from '@/types';

interface SidebarSectionLayoutProps {
  searching?: boolean;
  sections: Section[];
  itemsBySection: Map<SectionId, SidebarItem[]>;
  hasSections: boolean;
  collapsedSections: Record<string, boolean | undefined>;
  totalsBySection: Map<SectionId, { running: number; total: number }>;
  statuses: Record<string, ClusterStatus>;
  selectedClusterId: string | null;
  clusterSection: Record<string, SectionId>;
  emptyMessage?: string;
  onToggleSection: (id: SectionId) => void;
  onSelect: (id: string) => void;
  onEdit: (cluster: ClusterDef) => void;
  onDelete: (cluster: ClusterDef) => void;
}

export function SidebarSectionLayout({
  searching = false,
  sections,
  itemsBySection,
  hasSections,
  collapsedSections,
  totalsBySection,
  statuses,
  selectedClusterId,
  clusterSection,
  emptyMessage,
  onToggleSection,
  onSelect,
  onEdit,
  onDelete,
}: SidebarSectionLayoutProps) {
  i18n.useLocale();
  const commonProps = { statuses, selectedClusterId, clusterSection, onSelect, onEdit, onDelete };

  if (!hasSections) {
    return (
      <div className="px-2">
        <FlatItems
          items={itemsBySection.get(UNASSIGNED) ?? []}
          bucketId={searching ? null : UNASSIGNED}
          emptyMessage={emptyMessage}
          {...commonProps}
        />
      </div>
    );
  }

  const unassignedItems = itemsBySection.get(UNASSIGNED) ?? [];
  const unassignedTotals = totalsBySection.get(UNASSIGNED) ?? { running: 0, total: 0 };

  if (searching && ![...itemsBySection.values()].some((items) => items.length))
    return (
      <p className="text-fg-dim px-4 py-6 text-center text-[12px]">
        {i18n.t('No matching clusters.')}
      </p>
    );

  return (
    <>
      {sections
        .filter((section) => !searching || (itemsBySection.get(section.id)?.length ?? 0) > 0)
        .map((section) => {
          const totals = totalsBySection.get(section.id) ?? { running: 0, total: 0 };
          return (
            <SectionBlock
              key={section.id}
              section={section}
              collapsed={!searching && !!collapsedSections[section.id]}
              onToggle={() => onToggleSection(section.id)}
              running={totals.running}
              total={totals.total}
            >
              <SectionBody
                items={itemsBySection.get(section.id) ?? []}
                bucketId={searching ? null : section.id}
                {...commonProps}
              />
            </SectionBlock>
          );
        })}

      {(!searching || unassignedItems.length > 0) && (
        <UnassignedBlock
          collapsed={!searching && !!collapsedSections[UNASSIGNED]}
          onToggle={() => onToggleSection(UNASSIGNED)}
          total={unassignedTotals.total}
          running={unassignedTotals.running}
        >
          <SectionBody
            items={unassignedItems}
            bucketId={searching ? null : UNASSIGNED}
            {...commonProps}
          />
        </UnassignedBlock>
      )}
    </>
  );
}
