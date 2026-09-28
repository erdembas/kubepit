import { cn } from '@/lib/cn';

/** A pressed / unpressed choice chip of the cluster editor's source settings. */
export function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded-app-sm inline-flex h-7 items-center gap-1.5 border px-2 text-[11.5px] transition',
        active
          ? 'border-accent/40 bg-accent/12 text-fg font-medium'
          : 'border-border text-fg-muted hover:text-fg hover:border-border-strong',
      )}
    >
      {children}
    </button>
  );
}
