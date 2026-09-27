import type { MouseEvent, ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface Props {
  icon: ReactNode;
  /** Omit for an icon-only action. */
  label?: string;
  title: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  active?: boolean;
  className?: string;
}

/** RunHQ `TabStripAction`: captioned trailing action at the end of a tab strip. */
export function DockStripAction({ icon, label, title, onClick, active, className }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={label ? undefined : title}
      className={cn(
        'rounded-app-sm flex h-6 shrink-0 items-center gap-1 px-1.5 text-[11px] font-medium whitespace-nowrap transition-colors',
        'focus-visible:ring-accent/40 focus-visible:ring-2 focus-visible:outline-none',
        active
          ? 'bg-surface-overlay/60 text-fg'
          : 'text-fg-dim hover:text-fg hover:bg-surface-overlay/60',
        className,
      )}
    >
      <span className="shrink-0 [&>svg]:h-3 [&>svg]:w-3">{icon}</span>
      {label && <span>{label}</span>}
    </button>
  );
}
