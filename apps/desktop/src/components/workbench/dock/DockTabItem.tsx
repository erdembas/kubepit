import * as i18n from '@/i18n';
import type { ComponentType } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  FileCode2,
  FolderGit2,
  FolderTree,
  GitCompareArrows,
  Logs,
  ScrollText,
  TerminalSquare,
  X,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import type { DockTab } from '@/store/useDockStore';

const TAB_ICON: Record<DockTab['kind'], ComponentType<{ className?: string }>> = {
  terminal: TerminalSquare,
  logs: ScrollText,
  editor: FileCode2,
  compare: GitCompareArrows,
  'workload-logs': Logs,
  files: FolderTree,
  manifests: FolderGit2,
};

interface Props {
  tab: DockTab;
  title: string;
  tooltip: string;
  active: boolean;
  /** Keyboard focus is inside the dock (RunHQ's bright vs muted active tier). */
  dockFocused: boolean;
  dirty: boolean;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onMenu: (tabId: string, x: number, y: number) => void;
}

/** RunHQ `TabStripItem` for dock tabs: drag to reorder, middle-click closes, right-click menu. */
export function DockTabItem({
  tab,
  title,
  tooltip,
  active,
  dockFocused,
  dirty,
  onActivate,
  onClose,
  onMenu,
}: Props) {
  i18n.useLocale();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  });
  const Icon = TAB_ICON[tab.kind];
  const usesFocusTier = tab.kind === 'terminal';
  const bright = active && (!usesFocusTier || dockFocused);
  const muted = active && usesFocusTier && !dockFocused;

  return (
    <div
      ref={setNodeRef}
      data-tab-id={tab.id}
      style={{
        transform: CSS.Translate.toString(transform ? { ...transform, y: 0 } : null),
        transition,
      }}
      onClick={() => onActivate(tab.id)}
      onMouseDown={(e) => {
        // Middle button: suppress autoscroll so onAuxClick can close cleanly.
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        onClose(tab.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(tab.id, e.clientX, e.clientY);
      }}
      title={tooltip}
      className={cn(
        'group relative flex h-full shrink-0 cursor-pointer items-center gap-1.5 px-3 text-[12px] font-medium transition-colors select-none',
        'border-border/40 border-r',
        bright
          ? 'bg-accent/15 text-fg'
          : muted
            ? 'bg-surface-muted text-fg-muted'
            : 'text-fg-dim hover:text-fg hover:bg-surface-overlay/40',
        isDragging && 'z-10 opacity-60',
      )}
      {...attributes}
      {...listeners}
      role="tab"
      aria-selected={active}
      tabIndex={-1}
    >
      <Icon
        className={cn(
          'h-3 w-3 shrink-0',
          bright ? 'text-accent' : muted ? 'text-fg-muted' : 'text-fg-dim',
        )}
      />
      <span className="max-w-56 truncate">{title}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose(tab.id);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label={i18n.t('Close {title}', { title })}
        title={
          dirty
            ? i18n.t('Unsaved changes — close {title}', { title })
            : i18n.t('Close {title}', { title })
        }
        className={cn(
          'text-fg-dim hover:bg-status-error/15 hover:text-status-error',
          'rounded-app-sm flex h-4 w-4 shrink-0 items-center justify-center transition',
          active || dirty ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
      >
        {dirty ? (
          <>
            <span aria-hidden className="bg-fg-muted h-1.5 w-1.5 rounded-full group-hover:hidden" />
            <X className="hidden h-2.5 w-2.5 group-hover:block" />
          </>
        ) : (
          <X className="h-2.5 w-2.5" />
        )}
      </button>
      <span
        aria-hidden
        className={cn(
          'absolute top-0 right-0 left-0 h-[2px] transition-colors',
          bright ? 'bg-accent' : muted ? 'bg-fg-dim/40' : 'bg-transparent',
        )}
      />
    </div>
  );
}
