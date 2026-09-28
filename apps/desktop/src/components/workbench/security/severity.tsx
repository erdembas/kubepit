import * as i18n from '@/i18n';
import { cn } from '@/lib/cn';
import { SEVERITIES, totalOf, type Severity, type SeverityCounts } from '@/lib/kube/trivy';

/** Visual language of vulnerability severities (literal class names for Tailwind's scanner). */

export const SEV_TEXT: Record<Severity, string> = {
  CRITICAL: 'text-status-error',
  HIGH: 'text-cat-infra',
  MEDIUM: 'text-status-starting',
  LOW: 'text-cat-frontend',
  UNKNOWN: 'text-fg-dim',
};

export const SEV_FILL: Record<Severity, string> = {
  CRITICAL: 'bg-status-error',
  HIGH: 'bg-cat-infra',
  MEDIUM: 'bg-status-starting',
  LOW: 'bg-cat-frontend',
  UNKNOWN: 'bg-fg-dim',
};

export function severityName(s: Severity): string {
  switch (s) {
    case 'CRITICAL':
      return i18n.t('Critical');
    case 'HIGH':
      return i18n.t('High');
    case 'MEDIUM':
      return i18n.t('Medium');
    case 'LOW':
      return i18n.t('Low');
    default:
      return i18n.t('Unknown');
  }
}

const KEY: Record<Severity, keyof SeverityCounts> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  UNKNOWN: 'unknown',
};

export function countOf(counts: SeverityCounts, s: Severity): number {
  return counts[KEY[s]];
}

/** `C 3 · H 12 · M 40 · L 7` as four fixed-width colored numbers (zero stays dim). */
export function CountCells({
  counts,
  withUnknown = false,
  className,
}: {
  counts: SeverityCounts;
  withUnknown?: boolean;
  className?: string;
}) {
  i18n.useLocale();
  const shown = withUnknown ? SEVERITIES : SEVERITIES.filter((s) => s !== 'UNKNOWN');
  return (
    <span className={cn('flex shrink-0 items-center gap-1 tabular-nums', className)}>
      {shown.map((s) => {
        const n = countOf(counts, s);
        return (
          <span
            key={s}
            title={`${severityName(s)}: ${n}`}
            className={cn(
              'w-7 rounded px-0.5 text-right text-[11px]',
              n ? cn(SEV_TEXT[s], 'font-semibold') : 'text-fg-dim/50',
            )}
          >
            {n}
          </span>
        );
      })}
    </span>
  );
}

/** Headers matching `CountCells`: one severity dot per column (named in the tooltip). */
export function CountHeaders({ withUnknown = false }: { withUnknown?: boolean }) {
  i18n.useLocale();
  const shown = withUnknown ? SEVERITIES : SEVERITIES.filter((s) => s !== 'UNKNOWN');
  return (
    <span className="flex shrink-0 items-center gap-1">
      {shown.map((s) => (
        <span
          key={s}
          title={severityName(s)}
          aria-label={severityName(s)}
          className="flex w-7 justify-end pr-0.5"
        >
          <span className={cn('h-1.5 w-1.5 rounded-full', SEV_FILL[s])} />
        </span>
      ))}
    </span>
  );
}

/** Proportional bar of the counts. */
export function SeverityBar({ counts, className }: { counts: SeverityCounts; className?: string }) {
  const total = totalOf(counts);
  return (
    <span
      className={cn('bg-fg/8 flex h-1.5 min-w-8 overflow-hidden rounded-full', className)}
      aria-hidden
    >
      {total > 0 &&
        SEVERITIES.map((s) => {
          const n = countOf(counts, s);
          return n ? (
            <span key={s} className={SEV_FILL[s]} style={{ width: `${(n / total) * 100}%` }} />
          ) : null;
        })}
    </span>
  );
}

/** Severity word in its color (`CRITICAL` data values are shown translated). */
export function SeverityText({ severity, className }: { severity: Severity; className?: string }) {
  i18n.useLocale();
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 font-medium', SEV_TEXT[severity], className)}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', SEV_FILL[severity])} />
      {severityName(severity)}
    </span>
  );
}
