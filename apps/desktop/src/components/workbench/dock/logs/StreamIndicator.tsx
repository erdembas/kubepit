import * as i18n from '@/i18n';
import { Loader2, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { StreamStatus } from './useLogStream';

interface Props {
  status: StreamStatus;
  paused: boolean;
  pending: number;
  follow: boolean;
  onRetry: () => void;
}

/** Compact stream state: live / paused / ended / error (with retry). */
export function StreamIndicator({ status, paused, pending, follow, onRetry }: Props) {
  i18n.useLocale();
  if (status.state === 'connecting') {
    return (
      <span className="text-fg-dim flex shrink-0 items-center gap-1.5 px-1 text-[11px] whitespace-nowrap">
        <Loader2 className="h-3 w-3 animate-spin" />
        {i18n.t('Connecting…')}
      </span>
    );
  }
  if (status.state === 'error') {
    return (
      <span className="flex shrink-0 items-center gap-1.5 px-1 text-[11px] whitespace-nowrap">
        <Dot className="bg-status-error" />
        <span className="text-status-error max-w-56 truncate" title={status.message}>
          {i18n.t('Stream error')}
        </span>
        <RetryButton label={i18n.t('Retry')} onClick={onRetry} />
      </span>
    );
  }
  if (status.state === 'ended') {
    return (
      <span className="text-fg-dim flex shrink-0 items-center gap-1.5 px-1 text-[11px] whitespace-nowrap">
        <Dot className="bg-fg-dim/60" />
        {follow ? i18n.t('Stream ended') : i18n.t('Loaded')}
        <RetryButton label={follow ? i18n.t('Reconnect') : i18n.t('Reload')} onClick={onRetry} />
      </span>
    );
  }
  if (paused) {
    return (
      <span className="text-tone-warning-fg flex shrink-0 items-center gap-1.5 px-1 text-[11px] whitespace-nowrap">
        <Dot className="bg-tone-warning" />
        {pending > 0
          ? i18n.plural('Paused · {count} new line', 'Paused · {count} new lines', pending)
          : i18n.t('Paused')}
      </span>
    );
  }
  return (
    <span className="text-fg-muted flex shrink-0 items-center gap-1.5 px-1 text-[11px] whitespace-nowrap">
      <Dot className={cn('bg-status-running', follow && 'animate-pulse-dot')} />
      {follow ? i18n.t('Live') : i18n.t('Loading…')}
    </span>
  );
}

function Dot({ className }: { className: string }) {
  return <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', className)} />;
}

function RetryButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-fg-muted hover:text-fg hover:bg-surface-overlay rounded-app-sm flex h-5 items-center gap-1 px-1.5 text-[11px] font-medium transition"
    >
      <RotateCcw className="h-2.5 w-2.5" />
      {label}
    </button>
  );
}
