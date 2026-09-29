import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import type { ReactNode } from 'react';
import { Loader2, RefreshCw, Sparkles, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Select, type SelectOption } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { cn } from '@/lib/cn';
import { formatAge } from '@/lib/format';
import {
  SCAN_INTERVALS,
  intervalLabel,
  isScanning,
  runErrorText,
  scanSourceLabel,
} from '@/lib/kube/recommendations/model';
import { reportDays, strategyLabel } from '@/lib/kube/rightsizing/model';
import { useAppStore } from '@/store/useAppStore';
import { useRecommendationsStore } from '@/store/useRecommendationsStore';
import type {
  ClusterId,
  RecommendationLatest,
  RecommendationRun,
  RecommendationScanStatus,
  RecommendationScanView,
  RightsizingReport,
} from '@/types';
import { useNow } from '../util';
import { saveRecommendationSettings } from './saveSettings';

const LATEST = 'latest';
const NO_RUNS: RecommendationRun[] = [];

function scopeLabel(namespaces: readonly string[]) {
  if (!namespaces.length) return i18n.t('All namespaces');
  if (namespaces.length === 1) return namespaces[0]!;
  return i18n.t('{count} namespaces', { count: namespaces.length });
}

const dateTime = (ms: number) => i18n.date(ms, { dateStyle: 'medium', timeStyle: 'short' });

/** When a run's results were collected. */
export const runTime = (run: RecommendationRun) => run.finished_at ?? run.started_at;

/** "Workload history (automatic)". */
export function strategyText(report: RightsizingReport): string {
  const info = report.strategies.find((s) => s.id === report.strategy) ?? {
    id: report.strategy,
    name: report.strategy,
  };
  const label = strategyLabel(info);
  return report.strategy_auto ? i18n.t('{strategy} (automatic)', { strategy: label }) : label;
}

/**
 * "Scan now": disabled while disconnected, while a scan is queued or
 * running, and until `manual_available_at` (the backend's rate limit),
 * with the reason as its tooltip.
 */
export function ScanNowButton({
  clusterId,
  status,
  variant = 'secondary',
}: {
  clusterId: ClusterId;
  status: RecommendationScanStatus | null;
  variant?: 'primary' | 'secondary';
}) {
  i18n.useLocale();
  const connected = useAppStore((s) => s.statuses[clusterId]?.state === 'connected');
  const scanning = isScanning(status);
  const availableAt = status?.manual_available_at ?? 0;
  // Ticks only while the rate limit runs, so the button enables on time.
  const now = useNow(1_000, availableAt > Date.now());
  const wait = Math.ceil((availableAt - now) / 1000);
  const reason = !connected
    ? i18n.t('Connect to the cluster to scan it.')
    : scanning
      ? i18n.t('A scan is already running.')
      : wait > 0
        ? i18n.plural(
            'Scan now is available again in {count} second.',
            'Scan now is available again in {count} seconds.',
            wait,
          )
        : i18n.t('Read the usage history now and store new recommendations.');
  return (
    <span title={reason} className="inline-flex shrink-0">
      <Button
        size="xs"
        variant={variant}
        disabled={!connected || scanning || wait > 0}
        leftIcon={<RefreshCw className={cn('h-3 w-3', scanning && 'animate-spin')} />}
        onClick={() => void useRecommendationsStore.getState().scanNow(clusterId)}
      >
        {i18n.t('Scan now')}
      </Button>
    </span>
  );
}

/** Progress, the last failure or the scan age. */
function ScanState({
  latest,
  scan,
  status,
  now,
}: {
  latest: RecommendationLatest | null;
  scan: RecommendationScanView | null;
  status: RecommendationScanStatus | null;
  now: number;
}) {
  i18n.useLocale();
  if (status && isScanning(status)) {
    const progress = status.state === 'running' ? status.progress : null;
    const pct = progress && progress.total > 0 ? progress.completed / progress.total : 0;
    return (
      <span className="text-fg-muted inline-flex min-w-0 items-center gap-2" aria-live="polite">
        <Loader2 className="text-accent h-3 w-3 shrink-0 animate-spin" />
        {status.state === 'queued' ? (
          i18n.t('Waiting for a scan slot…')
        ) : progress && progress.total > 0 ? (
          <>
            <span
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.completed}
              aria-label={i18n.t('Scan progress')}
              className="bg-fg/8 relative h-1.5 w-20 shrink-0 overflow-hidden rounded-full"
            >
              <span
                className="bg-accent absolute inset-y-0 left-0 rounded-full transition-[width] duration-300"
                style={{ width: `${Math.round(pct * 100)}%` }}
              />
            </span>
            <span className="tabular-nums">
              {i18n.t('{completed}/{total} queries', {
                completed: i18n.number(progress.completed),
                total: i18n.number(progress.total),
              })}
            </span>
          </>
        ) : (
          i18n.t('Scanning…')
        )}
      </span>
    );
  }
  const failure = latest?.last_failure ?? null;
  if (failure) {
    return (
      <span className="text-status-error inline-flex min-w-0 items-start gap-1.5">
        <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
        <span className="min-w-0 break-words">
          {i18n.t('Last scan failed {age} ago: {error}', {
            age: formatAge(runTime(failure), now),
            error: runErrorText(failure.error),
          })}
          {scan && (
            <span className="text-fg-muted">
              {' '}
              {i18n.t('Showing results from {time}.', { time: dateTime(runTime(scan.run)) })}
            </span>
          )}
        </span>
      </span>
    );
  }
  if (!scan) return null;
  return (
    <span className="text-fg-muted" title={dateTime(runTime(scan.run))}>
      {i18n.t('Scanned {age} ago', { age: formatAge(runTime(scan.run), now) })}
    </span>
  );
}

/**
 * Header of the Recommendations view: title and scope, the source badge,
 * the strategy, the scan state (progress, last failure, age), "Scan now",
 * the background-scan switch with the interval, the run picker (a past run
 * is read-only) and the Settings and Export slots.
 */
export function ScanHeader({
  clusterId,
  namespaces,
  latest,
  scan,
  status,
  loading,
  settingsAction,
  exportAction,
}: {
  clusterId: ClusterId;
  namespaces: readonly string[];
  /** The latest scan's answer (its last failure). */
  latest: RecommendationLatest | null;
  /** The scan shown: the picked past run, else the latest. */
  scan: RecommendationScanView | null;
  status: RecommendationScanStatus | null;
  loading: boolean;
  settingsAction?: ReactNode;
  exportAction?: ReactNode;
}) {
  i18n.useLocale();
  const runs = useRecommendationsStore((s) => s.byCluster[clusterId]?.runs ?? NO_RUNS);
  const runId = useRecommendationsStore((s) => s.byCluster[clusterId]?.runId ?? null);
  const recSettings = useAppStore((s) => s.settings?.recommendations ?? null);
  const scanning = isScanning(status);
  const now = useNow(scanning ? 1_000 : 30_000, true);
  const report = scan?.report ?? null;
  const optedIn = recSettings?.scan_clusters.includes(clusterId) ?? false;
  const interval = recSettings?.interval_minutes ?? 60;

  const latestRunId = latest?.scan?.run.id ?? null;
  const runOptions = useMemo<SelectOption[]>(() => {
    const past = runs.filter((r) => r.status === 'success' && r.rows_kept && r.id !== latestRunId);
    return [
      {
        value: LATEST,
        label: i18n.t('Latest scan'),
        description: latest?.scan ? dateTime(runTime(latest.scan.run)) : undefined,
      },
      ...past.map((r) => ({
        value: String(r.id),
        label: dateTime(runTime(r)),
        description: r.trigger === 'manual' ? i18n.t('Manual scan') : i18n.t('Background scan'),
      })),
    ];
  }, [runs, latestRunId, latest]);
  const intervalOptions = useMemo<SelectOption[]>(
    () =>
      [...new Set([...SCAN_INTERVALS, interval])]
        .sort((a, b) => a - b)
        .map((m) => ({ value: String(m), label: intervalLabel(m) })),
    [interval],
  );

  return (
    <div className="border-border/60 @container shrink-0 border-b">
      <div className="flex h-12 items-center gap-2 px-4">
        <span className="bg-accent/10 text-accent flex h-6 w-6 shrink-0 items-center justify-center rounded-md">
          <Sparkles className="h-3.5 w-3.5" />
        </span>
        <h2 className="text-fg min-w-0 truncate text-[13px] font-semibold">
          {i18n.t('Recommendations')}
        </h2>
        <span className="text-fg-dim hidden truncate text-[11px] @2xl:inline">
          {scopeLabel(namespaces)}
        </span>
        {report && (
          <Badge
            tone={report.source === 'prometheus' ? 'success' : 'info'}
            size="sm"
            className="hidden @xl:inline-flex"
          >
            {scanSourceLabel(report.source, reportDays(report))}
          </Badge>
        )}
        {runId != null && <Badge tone="warning">{i18n.t('Past scan')}</Badge>}
        {loading && (
          <Loader2 className="text-fg-dim h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {exportAction}
          {settingsAction}
          <ScanNowButton clusterId={clusterId} status={status} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 pb-2 text-[11px]">
        {runOptions.length > 1 && (
          <Select
            value={runId == null ? LATEST : String(runId)}
            onChange={(v) =>
              void useRecommendationsStore
                .getState()
                .selectRun(clusterId, v === LATEST ? null : Number(v))
            }
            options={runOptions}
            ariaLabel={i18n.t('Scan to show')}
            className="shrink-0"
          />
        )}
        {report && (
          <Badge
            tone={report.source === 'prometheus' ? 'success' : 'info'}
            size="sm"
            className="@xl:hidden"
          >
            {scanSourceLabel(report.source, reportDays(report))}
          </Badge>
        )}
        {report && <span className="text-fg-muted">{strategyText(report)}</span>}
        <ScanState latest={latest} scan={scan} status={status} now={now} />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <label className="text-fg-muted inline-flex cursor-pointer items-center gap-1.5">
            <Switch
              bare
              checked={optedIn}
              disabled={!recSettings}
              onChange={(on) =>
                void saveRecommendationSettings((rec) => ({
                  ...rec,
                  scan_clusters: on
                    ? [...rec.scan_clusters, clusterId]
                    : rec.scan_clusters.filter((id) => id !== clusterId),
                }))
              }
            />
            {i18n.t('Background scans')}
          </label>
          <span title={i18n.t('The interval applies to every cluster.')}>
            <Select
              value={String(interval)}
              onChange={(v) =>
                void saveRecommendationSettings((rec) => ({ ...rec, interval_minutes: Number(v) }))
              }
              options={intervalOptions}
              ariaLabel={i18n.t('Scan interval')}
              disabled={!recSettings}
            />
          </span>
        </div>
      </div>
    </div>
  );
}
