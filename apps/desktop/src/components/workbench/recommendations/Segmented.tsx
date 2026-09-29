import { cn } from '@/lib/cn';

/** A small segmented control of the section cards (`aria-pressed` buttons). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: ReadonlyArray<{ key: T; label: string }>;
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div
      className="bg-fg/4 inline-flex shrink-0 gap-0.5 rounded-md p-0.5"
      role="group"
      aria-label={label}
    >
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
          className={cn(
            'rounded px-1.5 py-px text-[10.5px] transition-colors',
            value === o.key
              ? 'bg-surface-raised text-fg font-medium shadow-sm'
              : 'text-fg-dim hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
