import * as i18n from '@/i18n';
import { cn } from '@/lib/cn';
import type { LevelKey, LogLevel } from '@/lib/logs/levels';

/** Text colour per level bucket (theme tokens). */
export const LEVEL_TEXT: Record<LevelKey, string> = {
  fatal: 'text-status-error',
  error: 'text-status-error',
  warn: 'text-status-starting',
  info: 'text-tone-info',
  debug: 'text-fg-dim',
  trace: 'text-fg-dim',
  none: 'text-fg-dim',
};

/** Dot colour per level bucket. */
export const LEVEL_DOT: Record<LevelKey, string> = {
  fatal: 'bg-status-error',
  error: 'bg-status-error',
  warn: 'bg-status-starting',
  info: 'bg-tone-info',
  debug: 'bg-fg-dim',
  trace: 'bg-fg-dim/60',
  none: 'bg-border-strong',
};

/** Chip label of a level bucket: level names are log data (verbatim), `none` is UI copy. */
export function levelKeyLabel(key: LevelKey): string {
  return key === 'none' ? i18n.t('No level') : key;
}

/** `ERROR` / `WARN` … badge of a table row (level names stay English). */
export function LevelBadge({ level }: { level: LogLevel | null }) {
  if (!level) return <span className="text-fg-dim/70">—</span>;
  return (
    <span
      lang="en"
      className={cn(
        'text-[10px] font-semibold tracking-[0.06em] uppercase',
        LEVEL_TEXT[level],
        level === 'fatal' && 'bg-status-error/15 rounded px-1',
      )}
    >
      {level}
    </span>
  );
}
