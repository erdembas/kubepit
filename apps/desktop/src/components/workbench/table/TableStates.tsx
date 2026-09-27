import * as i18n from '@/i18n';
import { AlertTriangle, CircleHelp, Inbox, RotateCcw, ShieldAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ROW_HEIGHT } from './ResourceTable';

export function TableSkeleton({ rows = 12 }: { rows?: number }) {
  i18n.useLocale();
  return (
    <div
      className="min-h-0 flex-1 overflow-hidden"
      aria-busy="true"
      aria-label={i18n.t('Loading…')}
    >
      <div className="border-border/70 border-b" style={{ height: ROW_HEIGHT }} />
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="border-border/40 flex items-center gap-4 border-b px-3"
          style={{ height: ROW_HEIGHT }}
        >
          <span
            className="bg-fg/6 h-2.5 animate-pulse rounded"
            style={{ width: `${22 + ((i * 37) % 18)}%`, animationDelay: `${i * 60}ms` }}
          />
          <span
            className="bg-fg/5 h-2.5 w-24 animate-pulse rounded"
            style={{ animationDelay: `${i * 60 + 30}ms` }}
          />
          <span
            className="bg-fg/4 ml-auto h-2.5 w-12 animate-pulse rounded"
            style={{ animationDelay: `${i * 60 + 60}ms` }}
          />
        </div>
      ))}
    </div>
  );
}

function Centered({
  icon: Icon,
  tone,
  title,
  message,
  action,
}: {
  icon: LucideIcon;
  tone: string;
  title: string;
  message?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div
          className={`mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl ${tone}`}
        >
          <Icon className="h-5 w-5" />
        </div>
        <h3 className="text-fg text-[13.5px] font-semibold">{title}</h3>
        {message && (
          <p className="text-fg-muted mt-1.5 text-[12px] leading-relaxed break-words whitespace-pre-line">
            {message}
          </p>
        )}
        {action && <div className="mt-4 flex justify-center">{action}</div>}
      </div>
    </div>
  );
}

export function TableEmpty({
  filtered,
  kind,
  onClear,
}: {
  filtered: boolean;
  kind: string;
  onClear: () => void;
}) {
  i18n.useLocale();
  return filtered ? (
    <Centered
      icon={Inbox}
      tone="bg-fg/5 text-fg-dim"
      title={i18n.t('No matches')}
      message={i18n.t('Nothing in {kind} matches the current filter.', { kind })}
      action={
        <Button size="sm" variant="secondary" onClick={onClear}>
          {i18n.t('Clear filter')}
        </Button>
      }
    />
  ) : (
    <Centered
      icon={Inbox}
      tone="bg-fg/5 text-fg-dim"
      title={i18n.t('No {kind}', { kind })}
      message={i18n.t('There are no {kind} in the selected namespaces.', { kind })}
    />
  );
}

export function TableError({
  error,
  forbidden,
  onRetry,
  onExplain,
}: {
  error: string;
  forbidden: boolean;
  onRetry: () => void;
  /** Opens the permission explainer ("Why?") for a forbidden list. */
  onExplain?: () => void;
}) {
  i18n.useLocale();
  return (
    <Centered
      icon={forbidden ? ShieldAlert : AlertTriangle}
      tone={
        forbidden
          ? 'bg-status-starting/12 text-status-starting'
          : 'bg-status-error/12 text-status-error'
      }
      title={forbidden ? i18n.t('Access denied') : i18n.t('Could not load resources')}
      message={
        forbidden ? `${error}\n${i18n.t('Try selecting a namespace you have access to.')}` : error
      }
      action={
        <div className="flex items-center gap-2">
          {forbidden && onExplain && (
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<CircleHelp className="h-3.5 w-3.5" />}
              onClick={onExplain}
            >
              {i18n.t('Why?')}
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
            onClick={onRetry}
          >
            {i18n.t('Retry')}
          </Button>
        </div>
      }
    />
  );
}
