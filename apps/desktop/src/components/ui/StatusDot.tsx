import * as i18n from '@/i18n';
import type { ConnState } from '@/types';
import { cn } from '@/lib/cn';

const COLOR: Record<ConnState, string> = {
  connected: 'bg-status-running shadow-[0_0_8px_rgb(var(--status-running)/0.55)]',
  connecting: 'bg-status-starting animate-pulse',
  disconnected: 'bg-status-stopped',
  error: 'bg-status-error shadow-[0_0_8px_rgb(var(--status-error)/0.55)]',
};

export function StatusDot({
  status,
  size = 'sm',
  className,
}: {
  status: ConnState;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}) {
  i18n.useLocale();
  const sz = size === 'xs' ? 'h-1.5 w-1.5' : size === 'md' ? 'h-2.5 w-2.5' : 'h-2 w-2';
  return <span className={cn('shrink-0 rounded-full', sz, COLOR[status], className)} />;
}

const PILL: Record<ConnState, string> = {
  connected: 'bg-status-running/15 text-status-running',
  connecting: 'bg-status-starting/15 text-status-starting',
  disconnected: 'bg-surface-muted text-fg-muted',
  error: 'bg-status-error/15 text-status-error',
};

export function connStateLabel(state: ConnState): string {
  switch (state) {
    case 'connected':
      return i18n.t('Connected');
    case 'connecting':
      return i18n.t('Connecting');
    case 'error':
      return i18n.t('Error');
    default:
      return i18n.t('Disconnected');
  }
}

export function StatusPill({ status }: { status: ConnState }) {
  i18n.useLocale();
  return (
    <span
      className={cn(
        'rounded-app-sm inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-semibold tracking-[0.08em] uppercase',
        PILL[status],
      )}
    >
      <StatusDot status={status} size="xs" />
      {connStateLabel(status)}
    </span>
  );
}
