import * as i18n from '@/i18n';
import { ArrowRight, HardDrive, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatBytes, formatPercent } from '@/lib/format';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import { navigateTo, useWorkbenchStore } from '@/store/useWorkbenchStore';
import { usePrometheusPvcUsage } from '../metrics/usePrometheus';
import { Card } from './charts';

const PVC_GVK = toGvk(BUILTIN.PersistentVolumeClaim);

/** Optional overview: current fullness only, never a time-to-full prediction. */
export function PvcUsageCard({ clusterId, isActive }: { clusterId: string; isActive: boolean }) {
  i18n.useLocale();
  const query = usePrometheusPvcUsage(clusterId, isActive);
  const report = query.data;
  if (!report?.rows.length) return null;

  return (
    <Card
      title={i18n.t('PVC usage')}
      icon={<HardDrive />}
      actions={
        <>
          <span className="text-fg-dim hidden text-[11px] sm:inline">
            {i18n.t('All namespaces')}
          </span>
          <button
            type="button"
            onClick={() => {
              useWorkbenchStore.getState().setNamespaces(clusterId, [], PVC_GVK.plural);
              navigateTo(clusterId, PVC_GVK);
            }}
            className="text-fg-dim hover:text-accent flex items-center gap-1 text-[11px]"
          >
            {i18n.t('View PVCs')}
            <ArrowRight className="h-3 w-3" />
          </button>
        </>
      }
    >
      {(query.error || report.warnings.length > 0) && (
        <div
          className="border-border/60 text-tone-warning-fg flex items-start gap-2 border-b px-4 py-3 text-[11.5px]"
          role="status"
        >
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1" title={query.error ?? report.warnings.join('\n')}>
            {query.error
              ? i18n.t('PVC usage could not be refreshed. Showing the last available metrics.')
              : i18n.t('Some PVC metrics may be missing. This ranking may be incomplete.')}
          </span>
          {query.error && (
            <button
              type="button"
              onClick={() => void query.refresh()}
              className="hover:text-fg shrink-0 underline underline-offset-2"
            >
              {i18n.t('Retry')}
            </button>
          )}
        </div>
      )}
      <div className="space-y-3 p-4">
        <p className="text-fg-dim text-[11px]">
          {i18n.t('Up to 5 PVCs with the highest usage. Only PVCs with metrics are included.')}
        </p>
        <ul className="space-y-1">
          {report.rows.slice(0, 5).map((row) => {
            const percent = formatPercent(row.used_percent);
            const tone =
              row.used_percent >= 90
                ? 'text-tone-critical-fg'
                : row.used_percent >= 80
                  ? 'text-tone-warning-fg'
                  : 'text-fg';
            const fill =
              row.used_percent >= 90
                ? 'bg-status-error'
                : row.used_percent >= 80
                  ? 'bg-status-starting'
                  : 'bg-accent';
            return (
              <li key={`${row.namespace}/${row.name}`}>
                <button
                  type="button"
                  onClick={() => navigateTo(clusterId, PVC_GVK, row.namespace, row.name)}
                  className="hover:bg-fg/4 -mx-1.5 w-[calc(100%+12px)] space-y-1.5 rounded-md px-1.5 py-2 text-left"
                  title={`${row.namespace}/${row.name}`}
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="text-fg min-w-0 flex-1 truncate text-[12px]">{row.name}</span>
                    <span className={cn('shrink-0 text-[12px] font-semibold tabular-nums', tone)}>
                      {percent}
                    </span>
                  </span>
                  <span className="text-fg-dim flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px]">
                    <span className="min-w-0 truncate font-mono">{row.namespace}</span>
                    <span className="shrink-0 tabular-nums">
                      {i18n.t('{used} / {capacity} used', {
                        used: formatBytes(row.used_bytes),
                        capacity: formatBytes(row.capacity_bytes),
                      })}
                    </span>
                  </span>
                  <span className="bg-fg/7 block h-1.5 overflow-hidden rounded-full" aria-hidden>
                    <span
                      className={cn('block h-full rounded-full transition-[width]', fill)}
                      style={{ width: `${Math.min(100, Math.max(0, row.used_percent))}%` }}
                    />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="text-fg-dim text-[11px]">
          {i18n.t('Prometheus · Updated {time}', {
            time: i18n.date(report.checked_at, { timeStyle: 'short' }),
          })}
        </p>
      </div>
    </Card>
  );
}
