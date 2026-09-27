import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Minimal SVG charts drawn with theme tokens (no chart library). */

export interface Segment {
  key: string;
  label: string;
  value: number;
  /** Tailwind stroke/bg pair, e.g. `stroke-status-running` + `bg-status-running`. */
  stroke: string;
  fill: string;
}

export function Ring({
  segments,
  size = 104,
  stroke = 10,
  children,
  label,
}: {
  segments: Segment[];
  size?: number;
  stroke?: number;
  children?: ReactNode;
  label: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((s, x) => s + x.value, 0);
  let offset = 0;
  const gap = total > 0 && segments.filter((s) => s.value > 0).length > 1 ? 2 : 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={label}
        className="-rotate-90"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className="stroke-fg/8"
        />
        {total > 0 &&
          segments.map((s) => {
            if (!s.value) return null;
            const len = (s.value / total) * c;
            const dash = Math.max(0, len - gap);
            const el = (
              <circle
                key={s.key}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                strokeWidth={stroke}
                strokeDasharray={`${dash} ${c - dash}`}
                strokeDashoffset={-offset}
                strokeLinecap="butt"
                className={cn(s.stroke, 'transition-[stroke-dasharray] duration-500')}
              />
            );
            offset += len;
            return el;
          })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        {children}
      </div>
    </div>
  );
}

export interface Gauge {
  key: string;
  label: string;
  value: number;
  stroke: string;
  fill: string;
}

/** Concentric progress rings (outer = first) against one maximum. */
export function GaugeRings({
  gauges,
  max,
  size = 132,
  children,
  label,
}: {
  gauges: Gauge[];
  max: number;
  size?: number;
  children?: ReactNode;
  label: string;
}) {
  const stroke = 8;
  const spacing = 4;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={label}
        className="-rotate-90"
      >
        {gauges.map((g, i) => {
          const r = size / 2 - stroke / 2 - i * (stroke + spacing);
          if (r <= 0) return null;
          const c = 2 * Math.PI * r;
          const pct = max > 0 ? Math.min(1, g.value / max) : 0;
          return (
            <g key={g.key}>
              <circle
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                strokeWidth={stroke}
                className="stroke-fg/7"
              />
              <circle
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                strokeWidth={stroke}
                strokeLinecap="round"
                strokeDasharray={`${pct * c} ${c}`}
                className={cn(g.stroke, 'transition-[stroke-dasharray] duration-500')}
              />
            </g>
          );
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        {children}
      </div>
    </div>
  );
}

export function SegmentBar({ segments, label }: { segments: Segment[]; label: string }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  return (
    <div
      className="bg-fg/7 flex h-2.5 w-full overflow-hidden rounded-full"
      role="img"
      aria-label={label}
    >
      {total > 0 &&
        segments.map((s) =>
          s.value ? (
            <span
              key={s.key}
              className={cn(
                'h-full transition-[width] duration-500 first:rounded-l-full last:rounded-r-full',
                s.fill,
              )}
              style={{ width: `${(s.value / total) * 100}%` }}
              title={`${s.label}: ${s.value}`}
            />
          ) : null,
        )}
    </div>
  );
}

export function Legend({
  items,
  className,
}: {
  items: Array<{ key: string; label: string; value: ReactNode; fill: string; pct?: string }>;
  className?: string;
}) {
  return (
    <ul className={cn('space-y-1.5 text-[11.5px]', className)}>
      {items.map((i) => (
        <li
          key={i.key}
          className="flex items-center gap-2"
          title={`${i.label}${i.pct ? ` · ${i.pct}` : ''}`}
        >
          <span className={cn('h-2 w-2 shrink-0 rounded-sm', i.fill)} aria-hidden />
          <span className="text-fg-muted min-w-0 flex-1 truncate">{i.label}</span>
          <span className="text-fg shrink-0 tabular-nums">{i.value}</span>
          {i.pct !== undefined && (
            <span className="text-fg-dim w-9 shrink-0 text-right text-[10.5px] tabular-nums">
              {i.pct}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function Card({
  title,
  icon,
  actions,
  children,
  className,
}: {
  title: string;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'rounded-app border-border bg-surface-raised/40 overflow-hidden border',
        className,
      )}
    >
      <header className="border-border/60 flex items-center gap-2 border-b px-4 py-2">
        {icon && <span className="text-fg-dim [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>}
        <h3 className="text-fg-dim text-[11px] font-semibold tracking-[0.12em] uppercase">
          {title}
        </h3>
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function StatTile({
  label,
  value,
  sub,
  tone,
  onClick,
  icon,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: string;
  onClick?: () => void;
  icon?: ReactNode;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'rounded-app border-border bg-surface-raised/40 flex flex-col items-start border px-4 py-3 text-left transition',
        onClick && 'hover:border-border-strong hover:bg-surface-raised',
      )}
    >
      <span className="text-fg-dim flex items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.12em] uppercase [&>svg]:h-3 [&>svg]:w-3">
        {icon}
        {label}
      </span>
      <span
        className={cn(
          'mt-1.5 text-[22px] leading-none font-semibold tracking-tight tabular-nums',
          tone ?? 'text-fg',
        )}
      >
        {value}
      </span>
      {sub && <span className="text-fg-dim mt-1.5 text-[11px]">{sub}</span>}
    </Tag>
  );
}
