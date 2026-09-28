import * as i18n from '@/i18n';
import type { ReactNode } from 'react';
import { AlertTriangle, Lock } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Toolbar row above a dock editor (same height/tone as the log toolbar).
 * It scrolls sideways when too narrow; `wrap` makes it a size container
 * whose items wrap onto more rows instead (children may use `@…:` variants).
 */
export function EditorBar({ children, wrap = false }: { children: ReactNode; wrap?: boolean }) {
  return (
    <div
      className={cn(
        'border-border/60 bg-surface flex shrink-0 items-center gap-1.5 border-b px-2',
        wrap
          ? '@container min-h-9 flex-wrap gap-y-1.5 py-1'
          : 'main-tabbar-scroll h-9 overflow-x-auto',
      )}
    >
      {children}
    </div>
  );
}

export function BarLabel({ children }: { children: ReactNode }) {
  return <span className="text-fg-dim shrink-0 text-[11px] whitespace-nowrap">{children}</span>;
}

export function ReadOnlyNotice() {
  i18n.useLocale();
  return (
    <div className="border-tone-warning/30 bg-tone-warning/8 text-tone-warning-fg flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[11.5px]">
      <Lock className="h-3 w-3 shrink-0" />
      {i18n.t('This cluster is read-only. Changes cannot be saved or applied.')}
    </div>
  );
}

/** Inline problem banner with optional actions (conflicts, load/save errors). */
export function EditorBanner({
  tone,
  children,
  actions,
}: {
  tone: 'error' | 'warning';
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-start gap-2 border-b px-3 py-1.5 text-[11.5px]',
        tone === 'error'
          ? 'border-tone-critical/30 bg-tone-critical/5 text-tone-critical-fg'
          : 'border-tone-warning/30 bg-tone-warning/8 text-tone-warning-fg',
      )}
    >
      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{children}</span>
      {actions && <span className="flex shrink-0 items-center gap-1">{actions}</span>}
    </div>
  );
}
