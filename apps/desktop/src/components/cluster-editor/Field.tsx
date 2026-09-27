export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block min-w-0">
      <span className="text-fg-dim mb-1 block text-[10.5px] font-semibold tracking-[0.14em] uppercase">
        {label}
      </span>
      {children}
      {hint && <span className="text-fg-dim mt-1 block text-[11px]">{hint}</span>}
    </label>
  );
}
