import * as i18n from '@/i18n';
import { memo } from 'react';
import {
  ArrowUpRight,
  Loader2,
  Lock,
  Pencil,
  Play,
  RotateCcw,
  Square,
  SquareTerminal,
} from 'lucide-react';
import { StatusDot } from '@/components/ui/StatusDot';
import { useFleetMetricsHistory } from '@/components/workbench/metrics/useMetricsHistory';
import { Sparkline } from '@/components/workbench/overview/TimeSeriesChart';
import { connectCluster, disconnectCluster, openAndConnect } from '@/lib/clusterActions';
import { connState, environmentMeta, isLive, serverLabel } from '@/lib/clusterMeta';
import { cn } from '@/lib/cn';
import { formatAge, formatBytes, formatCpu, formatPercent } from '@/lib/format';
import { usageBarClass } from '@/lib/resourceTone';
import { useVisibleStore } from '@/lib/useVisibleStore';
import { useAppStore } from '@/store/useAppStore';
import { dock } from '@/store/useDockStore';
import type { ClusterDef, ClusterOverview, KubeObject, MetricsSeries } from '@/types';

/**
 * Dashboard card for one cluster — the Kubepit twin of RunHQ's service
 * card: identity strip, a monospace "command" line (server · version),
 * the action row, and a tail area that shows live health instead of logs.
 */
export const ClusterCard = memo(function ClusterCard({
  cluster,
  visible,
}: {
  cluster: ClusterDef;
  visible: boolean;
}) {
  i18n.useLocale();
  const status = useVisibleStore(useAppStore, (s) => s.statuses[cluster.id], visible);
  const overview = useVisibleStore(useAppStore, (s) => s.overviews[cluster.id], visible);
  const overviewError = useVisibleStore(useAppStore, (s) => s.overviewErrors[cluster.id], visible);
  const openClusterEditor = useAppStore((s) => s.openClusterEditor);
  const state = connState(status);
  const live = isLive(state);
  // One shared request feeds every card's sparklines.
  const trend = useFleetMetricsHistory(visible && state === 'connected').data?.[cluster.id];
  const env = environmentMeta(cluster.environment);
  const version = status?.version?.replace(/^v?(\d+\.\d+\.\d+).*/, 'v$1');

  const primary =
    'rounded-app-sm inline-flex h-7 items-center gap-1.5 border px-2.5 text-[12px] font-medium transition';
  const quiet =
    'text-fg-dim hover:text-fg hover:bg-fg/6 flex h-7 w-7 items-center justify-center rounded-md transition';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => openAndConnect(cluster.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openAndConnect(cluster.id);
        }
      }}
      className={cn(
        'group/card glass relative flex flex-col gap-3 p-4 text-left transition-all duration-200',
        'hover:border-border-strong hover:-translate-y-0.5 hover:shadow-[0_10px_30px_-12px_rgb(0_0_0/0.25)]',
        state === 'connected' && 'border-accent/35 shadow-[0_0_0_1px_rgb(var(--accent)/0.12)]',
        state === 'error' && 'border-status-error/30',
      )}
    >
      {state === 'connected' && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-4 top-0 h-px"
          style={{
            background:
              'linear-gradient(90deg, transparent, rgb(var(--accent) / 0.4), transparent)',
          }}
        />
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <StatusDot status={state} size="md" />
          <span className="text-fg truncate text-[13.5px] font-semibold tracking-tight">
            {cluster.name}
          </span>
          {cluster.read_only && (
            <span title={i18n.t('Read-only')} className="text-fg-dim inline-flex shrink-0">
              <Lock className="h-3 w-3" />
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {status?.platform && (
            <span className="bg-fg/5 text-fg-muted rounded-md px-1.5 py-0.5 text-[10px] font-medium">
              {status.platform}
            </span>
          )}
          {env && (
            <span
              className={cn('rounded-md px-1.5 py-0.5 text-[10px] font-semibold ring-1', env.pill)}
            >
              {env.label}
            </span>
          )}
        </div>
      </div>

      <p
        className="text-fg-muted truncate font-mono text-[11.5px]"
        title={status?.server ?? cluster.context}
      >
        {status?.server ? serverLabel(status.server) : cluster.context}
        {version && <span className="text-fg-dim"> · {version}</span>}
      </p>

      {cluster.tags.length > 0 && (
        <div className="-mt-1 flex flex-wrap gap-1">
          {cluster.tags.map((tag) => (
            <span key={tag} className="text-fg-dim bg-fg/4 rounded px-1.5 py-px text-[10px]">
              #{tag}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        {state === 'connecting' ? (
          <button
            type="button"
            disabled
            className={cn(primary, 'border-status-starting/30 text-status-starting')}
          >
            <Loader2 className="h-3 w-3 animate-spin" />
            {i18n.t('Connecting')}
          </button>
        ) : live ? (
          <button
            type="button"
            onClick={() => void disconnectCluster(cluster.id)}
            className={cn(
              primary,
              'border-status-error/30 bg-status-error/10 text-status-error hover:bg-status-error/20',
            )}
          >
            <Square className="h-3 w-3 fill-current" />
            {i18n.t('Disconnect')}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void connectCluster(cluster.id)}
            className={cn(
              primary,
              'border-status-running/30 bg-status-running/10 text-status-running hover:bg-status-running/20',
            )}
          >
            {state === 'error' ? (
              <RotateCcw className="h-3 w-3" />
            ) : (
              <Play className="h-3 w-3 fill-current" />
            )}
            {state === 'error' ? i18n.t('Retry') : i18n.t('Connect')}
          </button>
        )}
        <button
          type="button"
          className={quiet}
          title={i18n.t('Open workbench')}
          aria-label={i18n.t('Open workbench')}
          onClick={() => openAndConnect(cluster.id)}
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={quiet}
          title={i18n.t('Cluster terminal')}
          aria-label={i18n.t('Cluster terminal')}
          onClick={() => {
            openAndConnect(cluster.id);
            dock.shell(cluster.id, cluster.name);
          }}
        >
          <SquareTerminal className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={quiet}
          title={i18n.t('Edit cluster')}
          aria-label={i18n.t('Edit cluster')}
          onClick={() => openClusterEditor({ mode: 'edit', cluster })}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        {state === 'connected' && overview && (
          <span className="text-fg-dim ml-auto font-mono text-[10.5px] tabular-nums">
            {i18n.t('{ready}/{total} nodes', {
              ready: overview.nodes.ready,
              total: overview.nodes.total,
            })}
          </span>
        )}
      </div>

      <CardTail
        state={state}
        error={status?.error ?? null}
        overview={overview}
        overviewError={overviewError}
        lastConnected={cluster.last_connected_at}
        trend={trend}
      />
    </div>
  );
});

function CardTail({
  state,
  error,
  overview,
  overviewError,
  lastConnected,
  trend,
}: {
  state: ReturnType<typeof connState>;
  error: string | null;
  overview: ClusterOverview | undefined;
  overviewError: string | undefined;
  lastConnected: number | null;
  trend: MetricsSeries | undefined;
}) {
  i18n.useLocale();
  const shell = 'bg-surface-muted/60 rounded-md px-3 py-2 font-mono text-[11px] leading-[1.6]';
  if (state === 'error')
    return (
      <div className={cn(shell, 'text-status-error line-clamp-3 break-words')}>
        {error ?? i18n.t('Connection failed')}
      </div>
    );
  if (state !== 'connected')
    return (
      <div className={cn(shell, 'text-fg-dim')}>
        {lastConnected
          ? i18n.t('Last connected {age} ago', { age: formatAge(lastConnected) })
          : i18n.t('Never connected')}
      </div>
    );
  if (!overview)
    return (
      <div className={cn(shell, 'text-fg-dim')}>
        {overviewError ?? <span className="animate-pulse">{i18n.t('Reading cluster…')}</span>}
      </div>
    );

  const cpuPct = overview.usage
    ? (overview.usage.cpu_millicores / Math.max(1, overview.allocatable.cpu_millicores)) * 100
    : null;
  const memPct = overview.usage
    ? (overview.usage.memory_bytes / Math.max(1, overview.allocatable.memory_bytes)) * 100
    : null;
  const latest = overview.warnings[0] as
    (KubeObject & { reason?: string; message?: string }) | undefined;

  return (
    <div className={cn(shell, 'space-y-1.5')}>
      <div className="flex items-center gap-3 tabular-nums">
        <span className="text-status-running">
          {i18n.t('{count} running', { count: overview.pods.running })}
        </span>
        {overview.pods.pending > 0 && (
          <span className="text-status-starting">
            {i18n.t('{count} pending', { count: overview.pods.pending })}
          </span>
        )}
        {overview.pods.failed > 0 && (
          <span className="text-status-error">
            {i18n.t('{count} failed', { count: overview.pods.failed })}
          </span>
        )}
        <span className="text-fg-dim ml-auto">
          {i18n.t('{count} pods', { count: overview.pods.total })}
        </span>
      </div>
      {cpuPct != null && memPct != null ? (
        <div className="grid grid-cols-2 gap-3">
          <UsageBar
            label={i18n.t('CPU')}
            percent={cpuPct}
            detail={formatCpu(overview.usage!.cpu_millicores)}
            trend={trend}
            metric="cpu_millicores"
          />
          <UsageBar
            label={i18n.t('MEM')}
            percent={memPct}
            detail={formatBytes(overview.usage!.memory_bytes)}
            trend={trend}
            metric="memory_bytes"
          />
        </div>
      ) : (
        <div className="text-fg-dim">{i18n.t('Metrics unavailable (no metrics-server)')}</div>
      )}
      {latest && (
        <div className="text-status-starting truncate" title={latest.message}>
          ⚠ {latest.reason}: {latest.message}
        </div>
      )}
    </div>
  );
}

function UsageBar({
  label,
  percent,
  detail,
  trend,
  metric,
}: {
  label: string;
  percent: number;
  detail: string;
  trend: MetricsSeries | undefined;
  metric: 'cpu_millicores' | 'memory_bytes';
}) {
  i18n.useLocale();
  const points = trend?.points ?? [];
  const to = points.at(-1)?.ts ?? 0;
  return (
    <div className="min-w-0" title={`${detail} · ${formatPercent(percent)}`}>
      <div className="text-fg-dim flex items-center justify-between text-[10px]">
        <span>{label}</span>
        <span className="text-fg-muted tabular-nums">{formatPercent(percent)}</span>
      </div>
      <div className="bg-fg/8 mt-0.5 h-1 overflow-hidden rounded-full">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500',
            usageBarClass(percent),
          )}
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </div>
      {points.length > 1 && (
        <Sparkline
          className="mt-1.5"
          height={18}
          points={points.map((p) => ({ t: p.ts, v: p[metric] }))}
          from={to - 60 * 60_000}
          to={to}
          intervalMs={(trend?.interval_secs ?? 60) * 1000}
          label={i18n.t('{metric} over the last hour', { metric: label })}
        />
      )}
    </div>
  );
}
