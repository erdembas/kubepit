import * as i18n from '@/i18n';
import { X } from 'lucide-react';
import { CheckRow } from '@/components/sidebar-filter-menu/CheckRow';
import { GROUP_OPTIONS, STATUS_OPTIONS } from '@/components/sidebar-filter-menu/filterOptions';
import { MenuSection } from '@/components/sidebar-filter-menu/MenuSection';
import { cn } from '@/lib/cn';
import type { SidebarGroupBy, SidebarStatusFilter } from '@/store/useAppStore';

export interface EnvironmentBucket {
  key: string;
  label: string;
  short: string;
  color: string;
  count: number;
}

interface FilterMenuBodyProps {
  statusFilter: SidebarStatusFilter;
  setStatusFilter: (value: SidebarStatusFilter) => void;
  groupBy: SidebarGroupBy;
  setGroupBy: (value: SidebarGroupBy) => void;
  environmentBuckets: EnvironmentBucket[];
  tagBuckets: Array<{ tag: string; count: number }>;
  environmentFilter: string[];
  tagFilter: string[];
  toggleEnvironment: (key: string) => void;
  toggleTag: (tag: string) => void;
  resetEnvironments: () => void;
  resetTags: () => void;
  activeFilterCount: number;
  onClearAll: () => void;
}

const SEGMENT = 'rounded-app-sm px-2 py-1 text-[11px] font-medium transition';
const SEGMENT_ON = 'bg-accent/15 text-accent shadow-[inset_0_0_0_1px_rgb(var(--accent)/0.25)]';
const SEGMENT_OFF = 'text-fg-muted hover:bg-surface-overlay hover:text-fg';

export function FilterMenuBody({
  statusFilter,
  setStatusFilter,
  groupBy,
  setGroupBy,
  environmentBuckets,
  tagBuckets,
  environmentFilter,
  tagFilter,
  toggleEnvironment,
  toggleTag,
  resetEnvironments,
  resetTags,
  activeFilterCount,
  onClearAll,
}: FilterMenuBodyProps) {
  i18n.useLocale();
  const reset = (onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      className="text-fg-dim hover:text-fg text-[10px] font-medium"
    >
      {i18n.t('Reset')}
    </button>
  );
  return (
    <>
      <div className="max-h-[70vh] overflow-y-auto">
        <MenuSection label={i18n.t('Show')}>
          <div className="flex gap-1">
            {STATUS_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setStatusFilter(option.key)}
                title={option.hint}
                className={cn(
                  SEGMENT,
                  'flex-1',
                  statusFilter === option.key ? SEGMENT_ON : SEGMENT_OFF,
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </MenuSection>

        <div className="border-border/60 border-t" />

        <MenuSection label={i18n.t('Group by')}>
          <div className="grid grid-cols-4 gap-1">
            {GROUP_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setGroupBy(option.key)}
                className={cn(SEGMENT, groupBy === option.key ? SEGMENT_ON : SEGMENT_OFF)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </MenuSection>

        {environmentBuckets.length > 0 && (
          <>
            <div className="border-border/60 border-t" />
            <MenuSection
              label={i18n.t('Environment')}
              action={environmentFilter.length > 0 ? reset(resetEnvironments) : null}
            >
              <div className="space-y-0.5">
                {environmentBuckets.map((env) => (
                  <CheckRow
                    key={env.key}
                    checked={environmentFilter.includes(env.key)}
                    onToggle={() => toggleEnvironment(env.key)}
                    leading={
                      <span
                        className={cn(
                          'w-9 font-mono text-[9.5px] font-semibold tracking-wide uppercase',
                          env.color,
                        )}
                      >
                        {env.short}
                      </span>
                    }
                    label={env.label}
                    count={env.count}
                  />
                ))}
              </div>
            </MenuSection>
          </>
        )}

        {tagBuckets.length > 0 && (
          <>
            <div className="border-border/60 border-t" />
            <MenuSection
              label={i18n.t('Tags')}
              action={tagFilter.length > 0 ? reset(resetTags) : null}
            >
              <div className="space-y-0.5">
                {tagBuckets.map(({ tag, count }) => (
                  <CheckRow
                    key={tag}
                    checked={tagFilter.includes(tag)}
                    onToggle={() => toggleTag(tag)}
                    leading={<span className="text-fg-dim font-mono text-[10px]">#</span>}
                    label={tag}
                    count={count}
                  />
                ))}
              </div>
            </MenuSection>
          </>
        )}
      </div>

      {activeFilterCount > 0 && (
        <div className="border-border/60 bg-surface-overlay/60 flex items-center justify-between border-t px-3 py-2">
          <span className="text-fg-dim text-[10.5px]">
            {i18n.plural('{count} active filter', '{count} active filters', activeFilterCount)}
          </span>
          <button
            type="button"
            onClick={onClearAll}
            className="text-fg-muted hover:text-fg flex items-center gap-1 text-[11px] font-medium transition"
          >
            {i18n.rich('{icon}Clear all', { icon: <X className="h-3 w-3" /> })}
          </button>
        </div>
      )}
    </>
  );
}
