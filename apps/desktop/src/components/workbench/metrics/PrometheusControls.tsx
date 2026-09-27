import * as i18n from '@/i18n';
import { useState } from 'react';
import { ChartSpline, Flame, Gauge, RefreshCw, Settings2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  PROM_RANGES,
  kindLabel,
  promRangeLabel,
  promRangeTitle,
  serviceAddress,
  serviceLabel,
} from '@/lib/prometheus';
import { useAppStore } from '@/store/useAppStore';
import { dock } from '@/store/useDockStore';
import type { ClusterId, PrometheusStatus } from '@/types';
import { RangeToggle } from './UsageHistory';
import {
  redetectPrometheus,
  setPromRange,
  usePrometheusStatus,
  usePromRange,
} from './usePrometheus';

/** 1h · 6h · 24h · 7d segmented control; one preference for every Prometheus chart. */
export function PromRangeToggle() {
  i18n.useLocale();
  const range = usePromRange();
  return (
    <div className="bg-fg/4 inline-flex gap-0.5 rounded-md p-0.5" role="group">
      {PROM_RANGES.map((key) => (
        <button
          key={key}
          type="button"
          aria-pressed={range === key}
          onClick={() => setPromRange(key)}
          title={promRangeTitle(key)}
          className={cn(
            'rounded px-1.5 py-px text-[10.5px] tabular-nums transition-colors',
            range === key
              ? 'bg-surface-raised text-fg font-medium shadow-sm'
              : 'text-fg-dim hover:text-fg',
          )}
        >
          {promRangeLabel(key)}
        </button>
      ))}
    </div>
  );
}

/** The range picker of the active source: Prometheus ranges, or metrics-server's last hour. */
export function MetricsRangeToggle({
  clusterId,
  enabled = true,
}: {
  clusterId: ClusterId;
  enabled?: boolean;
}) {
  const status = usePrometheusStatus(clusterId, enabled).data;
  return status?.state === 'available' ? <PromRangeToggle /> : <RangeToggle />;
}

function NoteButton({
  title,
  onClick,
  children,
  disabled,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className="text-fg-dim hover:text-fg hover:bg-fg/5 flex h-4 w-4 items-center justify-center rounded transition disabled:opacity-50 [&>svg]:h-3 [&>svg]:w-3"
    >
      {children}
    </button>
  );
}

/**
 * Subtle line under the charts naming the active source ("Prometheus:
 * monitoring/prometheus-operated" or "metrics-server"), with ways out when
 * Prometheus was not found or does not answer.
 */
export function MetricsSourceNote({
  clusterId,
  status,
  query,
  historyAvailable = true,
}: {
  clusterId: ClusterId;
  status: PrometheusStatus | undefined;
  /** PromQL behind the main chart, offered as "open in a PromQL tab". */
  query?: string | null;
  /** False when metrics-server is missing too: there is no source at all. */
  historyAvailable?: boolean;
}) {
  i18n.useLocale();
  const cluster = useAppStore((s) => s.clusters.find((c) => c.id === clusterId));
  const [busy, setBusy] = useState(false);
  const redetect = () => {
    setBusy(true);
    void redetectPrometheus(clusterId)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  const settings = () =>
    cluster && useAppStore.getState().openClusterEditor({ mode: 'edit', cluster });

  if (status?.state === 'available' && status.service) {
    const service = status.service;
    const address = serviceAddress(service);
    const title =
      status.source === 'configured'
        ? i18n.t('{kind} at {address}, set in the cluster settings', {
            kind: kindLabel(service.kind),
            address,
          })
        : i18n.t('{kind} at {address}, detected automatically', {
            kind: kindLabel(service.kind),
            address,
          });
    return (
      <div className="text-fg-dim flex items-center justify-end gap-1 text-[10.5px]">
        <span className="flex min-w-0 items-center gap-1.5" title={title}>
          <Flame className="text-accent/80 h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">
            {i18n.t('Prometheus: {service}', { service: serviceLabel(service) })}
          </span>
        </span>
        <NoteButton
          title={i18n.t('Open in a PromQL tab')}
          onClick={() => dock.promql(clusterId, query ?? '')}
        >
          <ChartSpline />
        </NoteButton>
      </div>
    );
  }

  const hint = !historyAvailable
    ? i18n.t(
        'Neither metrics-server nor Prometheus was found. Install one of them, or set the Prometheus service in the cluster settings.',
      )
    : status?.state === 'unreachable'
      ? i18n.t('Prometheus at {service} does not answer: {error}', {
          service: status.service ? serviceLabel(status.service) : '—',
          error: status.error ?? '—',
        })
      : status?.state === 'off'
        ? i18n.t('Prometheus is turned off for this cluster.')
        : status?.state === 'not-found'
          ? i18n.t(
              'No Prometheus found, so charts show the last hour from metrics-server. Set a service in the cluster settings if detection misses it.',
            )
          : undefined;
  return (
    <div className="text-fg-dim flex items-center justify-end gap-1 text-[10.5px]">
      <span className="flex min-w-0 items-center gap-1.5" title={hint}>
        {status?.state === 'unreachable' ? (
          <span className="bg-status-starting h-1.5 w-1.5 shrink-0 rounded-full" aria-hidden />
        ) : (
          <Gauge className="h-3 w-3 shrink-0" aria-hidden />
        )}
        <span className="truncate">
          {!historyAvailable
            ? i18n.t('No metrics source')
            : status?.state === 'unreachable'
              ? i18n.t('metrics-server · Prometheus unreachable')
              : 'metrics-server'}
        </span>
      </span>
      {status && status.state !== 'off' && (
        <NoteButton title={i18n.t('Detect Prometheus again')} onClick={redetect} disabled={busy}>
          <RefreshCw className={cn(busy && 'animate-spin')} />
        </NoteButton>
      )}
      {cluster && status && (
        <NoteButton title={i18n.t('Prometheus settings')} onClick={settings}>
          <Settings2 />
        </NoteButton>
      )}
    </div>
  );
}
