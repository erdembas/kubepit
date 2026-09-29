import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useEffect } from 'react';
import { ChevronRight, Loader2, Sparkles, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { refreshPolled, usePolled } from '@/components/workbench/data/polled';
import { openRecommendationsView } from '@/components/workbench/recommendations/navigation';
import { ScanNowButton } from '@/components/workbench/recommendations/ScanHeader';
import { useNow } from '@/components/workbench/util';
import { clusterColor } from '@/lib/clusterMeta';
import { cn } from '@/lib/cn';
import { formatMoney } from '@/lib/cost';
import { formatAge } from '@/lib/format';
import { isScanning, runErrorText, runTime, scanStateText } from '@/lib/kube/recommendations/model';
import { verdictLabel } from '@/lib/kube/rightsizing/model';
import { ipc } from '@/lib/ipc';
import { useVisibleStore } from '@/lib/useVisibleStore';
import { useAppStore } from '@/store/useAppStore';
import { onScanEnded, useRecommendationsStore } from '@/store/useRecommendationsStore';
import type { ClusterRecommendationSummary, RecommendationScanStatus } from '@/types';
import {
  RECOMMENDATIONS_FLEET_KEY,
  RECOMMENDATIONS_FLEET_REFRESH_MS,
  fleetRecommendationRows,
  fleetSavings,
  fleetTop,
  savingClusters,
  type FleetRecommendationRow,
  type FleetTopEntry,
} from './recommendationsFleet';

/**
 * Dashboard card of the stored recommendation scans: every cluster with a
 * stored scan (read from `history.db`, so disconnected clusters too) with
 * its potential saving, over- and under-provisioned and one-click counts,
 * scan age, a stale badge and its last failure, plus the largest changes
 * across the fleet. It re-reads the fleet whenever any scan ends. A row
 * opens the cluster's Recommendations view; hidden while no cluster has a
 * scan.
 */
export function RecommendationsFleetCard({ visible }: { visible: boolean }) {
  i18n.useLocale();
  const clusters = useVisibleStore(useAppStore, (s) => s.clusters, visible);
  const statuses = useVisibleStore(useAppStore, (s) => s.statuses, visible);
  const interval = useVisibleStore(
    useAppStore,
    (s) => s.settings?.recommendations.interval_minutes ?? 60,
    visible,
  );
  const recs = useVisibleStore(useRecommendationsStore, (s) => s.byCluster, visible);
  const fleet = usePolled<ClusterRecommendationSummary[]>(
    RECOMMENDATIONS_FLEET_KEY,
    () => ipc.recommendationsFleet(),
    RECOMMENDATIONS_FLEET_REFRESH_MS,
    visible,
  );
  const now = useNow(60_000, visible);

  useEffect(() => onScanEnded(() => refreshPolled(RECOMMENDATIONS_FLEET_KEY)), []);

  const rows = useMemo(
    () => fleetRecommendationRows(clusters, fleet.data ?? [], statuses, interval, now),
    [clusters, fleet.data, statuses, interval, now],
  );
  const savings = useMemo(() => fleetSavings(rows), [rows]);
  const top = useMemo(() => fleetTop(rows), [rows]);

  // "Scan now" and the progress of connected rows follow the scan status.
  const connectedIds = rows
    .filter((r) => r.connected)
    .map((r) => r.cluster.id)
    .join('|');
  useEffect(() => {
    if (!visible || !connectedIds) return;
    for (const id of connectedIds.split('|'))
      void useRecommendationsStore.getState().loadStatus(id);
  }, [visible, connectedIds]);

  if (!rows.length) return null;

  return (
    <section
      className="glass @container flex flex-col gap-3 px-5 py-4"
      aria-label={i18n.t('Recommendations')}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-fg-dim flex items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.18em] uppercase">
          <Sparkles className="h-3.5 w-3.5" />
          {i18n.t('Recommendations')}
        </span>
        <span className="text-fg-muted text-[11.5px] tabular-nums">
          {savings.length
            ? i18n.plural(
                '{amount} a month could be saved across {count} cluster',
                '{amount} a month could be saved across {count} clusters',
                savingClusters(rows),
                {
                  amount: savings
                    .map((s) => formatMoney(s.amount, s.currency, { compact: true }))
                    .join(' + '),
                },
              )
            : i18n.t('Right-sizing from the stored scans of each cluster')}
        </span>
      </header>
      <ul className="flex flex-col gap-0.5">
        {rows.map((row) => (
          <FleetRow
            key={row.cluster.id}
            row={row}
            status={recs[row.cluster.id]?.status ?? null}
            now={now}
          />
        ))}
      </ul>
      {top.length > 0 && (
        <div className="border-border/60 border-t pt-3">
          <p className="text-fg-dim mb-1 px-2 text-[10.5px] font-semibold tracking-[0.18em] uppercase">
            {i18n.t('Top across the fleet')}
          </p>
          <ul className="flex flex-col gap-0.5">
            {top.map((entry) => (
              <TopRow key={`${entry.clusterId}|${entry.key}`} entry={entry} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function FleetRow({
  row,
  status,
  now,
}: {
  row: FleetRecommendationRow;
  status: RecommendationScanStatus | null;
  now: number;
}) {
  i18n.useLocale();
  const { cluster, run, failure, summary } = row;
  const scanning = row.connected && isScanning(status);
  const staleTitle = !row.connected
    ? i18n.t('The cluster is disconnected; these are its stored results.')
    : run
      ? i18n.t(
          'These results are {age} old, more than twice the scan interval, so they may be out of date.',
          { age: formatAge(runTime(run), now) },
        )
      : undefined;
  return (
    <li className="group hover:bg-fg/4 flex items-center gap-1.5 rounded-md pr-1.5">
      <button
        type="button"
        onClick={() => openRecommendationsView(cluster.id)}
        title={i18n.t('Open the recommendations of {name}', { name: cluster.name })}
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 px-2 py-1.5 text-left"
      >
        <span className="flex min-w-0 flex-1 basis-44 items-center gap-2">
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: clusterColor(cluster) }}
          />
          <span className="text-fg min-w-0 truncate text-[12px] font-medium">{cluster.name}</span>
          {row.stale && (
            <Badge tone="warning" size="xs" title={staleTitle}>
              {i18n.t('Stale')}
            </Badge>
          )}
          {row.sourceChanged && (
            <Badge
              tone="info"
              size="xs"
              title={i18n.t(
                'The Prometheus configuration changed after the last scan. Scan again in the Recommendations view.',
              )}
            >
              {i18n.t('Source changed')}
            </Badge>
          )}
        </span>
        <span className="text-fg-dim inline-flex shrink-0 items-center gap-1 text-[11px] tabular-nums">
          {scanning && status ? (
            <>
              <Loader2 className="text-accent h-3 w-3 animate-spin" />
              {scanStateText(status)}
            </>
          ) : run ? (
            i18n.t('Scanned {age} ago', { age: formatAge(runTime(run), now) })
          ) : (
            i18n.t('No successful scan yet')
          )}
        </span>
        {summary && (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-[11px] tabular-nums @xl:ml-auto">
            <span
              className={cn(
                'font-semibold',
                summary.monthly_savings > 0 ? 'text-status-running' : 'text-fg-muted',
              )}
            >
              {i18n.t('{amount} / month', {
                amount: formatMoney(summary.monthly_savings, summary.currency, { compact: true }),
              })}
            </span>
            <span className="text-fg-dim/50" aria-hidden="true">
              ·
            </span>
            <span className={summary.over ? 'text-fg-muted' : 'text-fg-dim'}>
              {i18n.plural('{count} over-provisioned', '{count} over-provisioned', summary.over)}
            </span>
            <span className="text-fg-dim/50" aria-hidden="true">
              ·
            </span>
            <span className={summary.under ? 'text-status-starting' : 'text-fg-dim'}>
              {i18n.plural('{count} under-provisioned', '{count} under-provisioned', summary.under)}
            </span>
            {row.oneClick > 0 && (
              <>
                <span className="text-fg-dim/50" aria-hidden="true">
                  ·
                </span>
                <span
                  className="text-accent"
                  title={i18n.t(
                    'High-confidence changes without a raised limit: Apply handles them in one click.',
                  )}
                >
                  {i18n.plural('{count} ready to apply', '{count} ready to apply', row.oneClick)}
                </span>
              </>
            )}
          </span>
        )}
        {failure && (
          <span
            className="text-status-error flex min-w-0 basis-full items-center gap-1.5 text-[11px]"
            title={runErrorText(failure.error)}
          >
            <TriangleAlert className="h-3 w-3 shrink-0" />
            <span className="min-w-0 truncate">
              {i18n.t('Last scan failed {age} ago: {error}', {
                age: formatAge(runTime(failure), now),
                error: runErrorText(failure.error),
              })}
            </span>
          </span>
        )}
      </button>
      {row.connected && <ScanNowButton clusterId={cluster.id} status={status} />}
      <ChevronRight className="text-fg-dim/0 group-hover:text-fg-dim h-3.5 w-3.5 shrink-0" />
    </li>
  );
}

function TopRow({ entry }: { entry: FleetTopEntry }) {
  i18n.useLocale();
  return (
    <li>
      <button
        type="button"
        onClick={() => openRecommendationsView(entry.clusterId, entry.key)}
        className="hover:bg-fg/4 group flex w-full min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 rounded-md px-2 py-1.5 text-left"
      >
        <span className="flex min-w-0 flex-1 basis-48 flex-col @xl:flex-row @xl:items-baseline @xl:gap-2">
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              lang="en"
              className="text-fg-dim shrink-0 text-[10px] font-semibold tracking-wider uppercase"
            >
              {entry.kind}
            </span>
            <span className="text-fg min-w-0 truncate text-[12px] font-medium">{entry.name}</span>
          </span>
          <span className="text-fg-dim min-w-0 truncate text-[11px]">
            {entry.namespace} · {entry.clusterName}
          </span>
        </span>
        <Badge tone={entry.verdict === 'under' ? 'warning' : 'success'} size="xs">
          {verdictLabel(entry.verdict)}
        </Badge>
        <span
          className={cn(
            'w-24 shrink-0 text-right text-[11.5px] font-semibold tabular-nums',
            entry.monthly_delta < 0 ? 'text-status-running' : 'text-status-starting',
          )}
        >
          {i18n.t('{amount} / month', {
            amount: formatMoney(entry.monthly_delta, entry.currency, {
              compact: true,
              signed: true,
            }),
          })}
        </span>
        <ChevronRight className="text-fg-dim/0 group-hover:text-fg-dim h-3.5 w-3.5 shrink-0" />
      </button>
    </li>
  );
}
