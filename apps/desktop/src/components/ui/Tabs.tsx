import * as i18n from '@/i18n';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface Tab<K extends string = string> {
  key: K;
  label: string;
  icon?: ReactNode;
  badge?: ReactNode;
}

interface Props<K extends string> {
  tabs: Tab<K>[];
  value: K;
  onChange: (key: K) => void;
  className?: string;
  /**
   * Ids for a tab panel: tabs get `${idBase}-tab-${key}` and the selected
   * one `aria-controls="${idBase}-panel-${key}"`, the id the caller gives
   * its `role="tabpanel"` (labelled by the tab).
   */
  idBase?: string;
}

export function Tabs<K extends string>({ tabs, value, onChange, className, idBase }: Props<K>) {
  i18n.useLocale();
  return (
    <div
      role="tablist"
      className={cn(
        'border-border bg-surface-muted rounded-app-sm inline-flex items-center gap-0 border p-0.5',
        className,
      )}
    >
      {tabs.map((tab) => {
        const active = tab.key === value;
        return (
          <button
            key={tab.key}
            role="tab"
            id={idBase ? `${idBase}-tab-${tab.key}` : undefined}
            aria-controls={idBase && active ? `${idBase}-panel-${tab.key}` : undefined}
            aria-selected={active}
            onClick={() => onChange(tab.key)}
            className={cn(
              'rounded-app-sm inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] font-medium transition',
              active ? 'bg-surface-overlay text-fg' : 'text-fg-muted hover:text-fg',
            )}
          >
            {tab.icon}
            {tab.label}
            {tab.badge}
          </button>
        );
      })}
    </div>
  );
}
