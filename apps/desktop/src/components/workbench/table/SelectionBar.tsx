import * as i18n from '@/i18n';
import { useEffect } from 'react';
import { X } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/useAppStore';
import type { BulkAction } from '../actions/bulkActions';
import { LockedIcon, OPEN_GATE, useActionGates } from '../access/gates';
import { useActionDialogs } from '../actions/dialogStore';
import { usePaneFocused } from '@/components/split/paneFocus';
import { isTypingTarget } from '../util';

/** Space the table reserves under its last row while the bar floats over it. */
export const SELECTION_BAR_INSET = 64;

/** Floating bar over the bottom of a list with the actions for the checked rows. */
export function SelectionBar({
  clusterId,
  count,
  total,
  actions,
  readOnly,
  isActive,
  onSelectAll,
  onClear,
}: {
  clusterId: string;
  count: number;
  total: number;
  actions: BulkAction[];
  readOnly: boolean;
  isActive: boolean;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  i18n.useLocale();
  const gates = useActionGates(clusterId, actions, readOnly);

  // Esc clears the selection before it reaches the details panel (capture phase).
  const paneFocused = usePaneFocused();
  useEffect(() => {
    if (!isActive || !paneFocused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (
        isTypingTarget(e.target) ||
        useAppStore.getState().confirm ||
        useActionDialogs.getState().dialog
      )
        return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      e.preventDefault();
      onClear();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isActive, paneFocused, onClear]);

  return (
    <div className="@container pointer-events-none absolute inset-x-0 bottom-10 z-20 flex justify-center px-3">
      <div
        role="toolbar"
        aria-label={i18n.t('Selection actions')}
        className="border-border bg-surface-overlay animate-fade-in pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-xl border p-1 shadow-[0_16px_48px_-12px_rgb(0_0_0/0.5)]"
      >
        <span className="bg-accent/10 text-accent flex h-7 shrink-0 items-center rounded-lg px-2.5 text-[12px] font-medium tabular-nums">
          {i18n.t('{count} selected', { count })}
        </span>
        {count < total && (
          <button
            type="button"
            onClick={onSelectAll}
            className="text-fg-dim hover:bg-fg/8 hover:text-fg hidden h-7 shrink-0 rounded-lg px-2 text-[12px] tabular-nums transition-colors @lg:block"
          >
            {i18n.t('Select all {count}', { count: total })}
          </button>
        )}
        <span className="bg-border mx-1 h-5 w-px shrink-0" aria-hidden />
        {actions.map((a) => {
          const Icon = a.icon;
          const gate = gates.get(a.id) ?? OPEN_GATE;
          return (
            <button
              key={a.id}
              type="button"
              disabled={gate.blocked}
              aria-label={a.label}
              title={gate.blocked ? `${a.label} — ${gate.message}` : a.label}
              onClick={a.run}
              className={cn(
                'flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium transition-colors',
                'disabled:cursor-not-allowed disabled:opacity-40',
                a.tone === 'danger'
                  ? 'text-status-error enabled:hover:bg-status-error/12'
                  : 'text-fg-muted enabled:hover:bg-fg/8 enabled:hover:text-fg',
              )}
            >
              {gate.reason === 'permission' ? (
                <LockedIcon icon={Icon} badgeClassName="bg-surface-overlay" />
              ) : (
                <Icon className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="hidden @3xl:inline">{a.label}</span>
            </button>
          );
        })}
        <span className="bg-border mx-1 h-5 w-px shrink-0" aria-hidden />
        <IconButton
          size="sm"
          label={i18n.t('Clear selection (Esc)')}
          icon={<X />}
          onClick={onClear}
          className="shrink-0 rounded-lg"
        />
      </div>
    </div>
  );
}
