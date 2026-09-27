import * as i18n from '@/i18n';
import { memo } from 'react';
import type { LucideIcon } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

interface Props {
  viewKey: string;
  /** `bar`: RunHQ group-tab look for pane strips; `pill`: quiet pill for the header. */
  variant: 'bar' | 'pill';
  label: string;
  icon: LucideIcon;
  active: boolean;
  /** The tab's pane is the focused one (bright vs muted active tier). */
  focused: boolean;
  closable: boolean;
  /** A tab from another pane is being dragged (show the insert marker). */
  foreignDrag: boolean;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onStep: (key: string, step: -1 | 1) => void;
  onMenu: (key: string, x: number, y: number) => void;
}

/** One view tab: drag to reorder or move panes, middle-click or Delete closes, right-click menu. */
export const ViewTabItem = memo(function ViewTabItem({
  viewKey,
  variant,
  label,
  icon: Icon,
  active,
  focused,
  closable,
  foreignDrag,
  onActivate,
  onClose,
  onStep,
  onMenu,
}: Props) {
  i18n.useLocale();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id: viewKey });
  const pill = variant === 'pill';
  const bright = active && focused;
  const muted = active && !focused;

  return (
    <div
      ref={setNodeRef}
      data-view-tab={viewKey}
      style={{
        transform: CSS.Translate.toString(transform ? { ...transform, y: 0 } : null),
        transition,
      }}
      {...attributes}
      {...listeners}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={() => onActivate(viewKey)}
      onMouseDown={(e) => {
        // Middle button: suppress autoscroll so onAuxClick can close cleanly.
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (e.button !== 1 || !closable) return;
        e.preventDefault();
        onClose(viewKey);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(viewKey, e.clientX, e.clientY);
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          onStep(viewKey, e.key === 'ArrowLeft' ? -1 : 1);
        } else if (closable && (e.key === 'Delete' || e.key === 'Backspace')) {
          e.preventDefault();
          onClose(viewKey);
        }
      }}
      title={label}
      className={cn(
        // `view-tab` drops the global focus ring: the active tab is the roving
        // focus target, so its own highlight already marks keyboard focus.
        'view-tab group relative flex shrink-0 cursor-pointer items-center gap-1.5 text-[12px] whitespace-nowrap transition-colors select-none',
        pill
          ? cn(
              'h-7 rounded-md pl-2',
              closable ? 'pr-1' : 'pr-2',
              active
                ? cn('focus-visible:bg-fg/10', bright ? 'bg-fg/7 text-fg' : 'bg-fg/5 text-fg-muted')
                : 'text-fg-muted hover:bg-fg/5 hover:text-fg focus-visible:bg-fg/5',
            )
          : cn(
              'border-border/40 h-full border-r pr-1.5 pl-3',
              active
                ? cn('bg-surface', bright ? 'text-fg' : 'text-fg-muted')
                : 'text-fg-muted hover:bg-fg/4 hover:text-fg focus-visible:bg-fg/4',
            ),
        isDragging && 'opacity-40',
      )}
    >
      {isOver && foreignDrag && (
        <span
          aria-hidden
          className="bg-accent pointer-events-none absolute inset-y-1 -left-px z-10 w-[2px] rounded-full"
        />
      )}
      <Icon
        className={cn(
          'h-3.5 w-3.5 shrink-0',
          // Pills keep RunHQ's quiet look: the icon follows the label colour.
          !pill && (bright ? 'text-accent' : muted ? 'text-fg-muted' : 'text-fg-dim'),
        )}
      />
      <span className="max-w-48 truncate">{label}</span>
      {closable ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose(viewKey);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={i18n.t('Close {title}', { title: label })}
          title={i18n.t('Close {title}', { title: label })}
          tabIndex={-1}
          className={cn(
            'text-fg-dim hover:bg-fg/8 hover:text-fg',
            'rounded-app-sm flex h-4 w-4 shrink-0 items-center justify-center transition',
            active ? 'opacity-80' : 'opacity-0 group-hover:opacity-80',
          )}
        >
          <X className="h-3 w-3" />
        </button>
      ) : (
        !pill && <span aria-hidden className="inline-block h-4 w-4 shrink-0" />
      )}
      {!pill && (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 h-[2px] transition-colors',
            bright ? 'bg-accent' : muted ? 'bg-fg-dim/40' : 'bg-transparent',
          )}
        />
      )}
    </div>
  );
});
