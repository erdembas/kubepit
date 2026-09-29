import * as i18n from '@/i18n';
import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Folder row of the cluster explorer (sections and derived groups), styled
 * like the resource navigator's group headers so both trees read as one IDE.
 */
export function TreeGroupHeader({
  label,
  color,
  dotClass,
  collapsed,
  onToggle,
  total,
  running = 0,
  actions,
}: {
  label: string;
  /** Section colour (inline, user-picked). */
  color?: string;
  /** Token class for derived groups (environment, status). */
  dotClass?: string;
  collapsed: boolean;
  onToggle: () => void;
  total: number;
  running?: number;
  /** Shown while the header is hovered or focused. */
  actions?: ReactNode;
}) {
  i18n.useLocale();
  return (
    <header className="group/header bg-surface-raised/95 sticky top-0 z-10 backdrop-blur-sm">
      <div className="hover:bg-fg/3 flex items-center gap-1 rounded-md pr-1 transition-colors">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={onToggle}
          className="text-fg-dim hover:text-fg-muted focus-visible:bg-fg/5 focus-visible:text-fg-muted flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-2 text-left transition-colors outline-none"
        >
          <ChevronDown
            className={cn('h-3 w-3 shrink-0 transition-transform', collapsed && '-rotate-90')}
          />
          {(color || dotClass) && (
            <span
              aria-hidden
              className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotClass)}
              style={color ? { backgroundColor: color } : undefined}
            />
          )}
          <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold tracking-[0.12em] uppercase">
            {label}
          </span>
        </button>
        {actions && (
          <span className="flex items-center opacity-0 transition-opacity group-focus-within/header:opacity-100 group-hover/header:opacity-100">
            {actions}
          </span>
        )}
        <span
          title={i18n.t('{running} running · {count} total', { running, count: total })}
          className={cn(
            'min-w-5 pr-1 text-right text-[10px] tabular-nums',
            running ? 'text-status-running' : 'text-fg-dim',
          )}
        >
          {running ? `${running}/${total}` : total}
        </span>
      </div>
    </header>
  );
}
