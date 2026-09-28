import * as i18n from '@/i18n';
import { CircleDollarSign, Loader2 } from 'lucide-react';
import { costSourceLabel, formatEfficiency, formatMoney, perMonth } from '@/lib/cost';
import { itemLabel, share } from '@/lib/kube/cost/breakdown';
import { VIEW_KEYS } from '@/lib/kube/nav';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import { Card, SegmentBar } from '../overview/charts';
import { useCostReport } from './useCost';

/** Cluster overview: monthly cost, allocated vs idle, top namespaces, source. */
export function CostOverviewCard({
  clusterId,
  isActive,
}: {
  clusterId: string;
  isActive: boolean;
}) {
  i18n.useLocale();
  const query = useCostReport(clusterId, '7d', 'namespace', null, isActive);
  const report = query.data;
  const open = () => useWorkbenchStore.getState().setActiveKind(clusterId, VIEW_KEYS.cost);
  const top = report ? report.items.filter((i) => !i.special).slice(0, 3) : [];

  return (
    <Card
      title={i18n.t('Cost')}
      icon={<CircleDollarSign />}
      actions={
        <button type="button" onClick={open} className="text-fg-dim hover:text-accent text-[11px]">
          {i18n.t('Open cost view')}
        </button>
      }
    >
      {!report ? (
        <div className="text-fg-muted flex items-center gap-2 px-4 py-4 text-[12px]">
          {query.error ? (
            <span className="text-fg-dim">{query.error}</span>
          ) : (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {i18n.t('Computing costs…')}
            </>
          )}
        </div>
      ) : (
        <div className="@container grid gap-4 px-4 py-3 @xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-fg text-[22px] leading-none font-semibold tracking-tight tabular-nums">
                {formatMoney(report.totals.total, report.currency, { compact: true })}
              </span>
              <span className="text-fg-dim text-[11px]">{i18n.t('per month')}</span>
            </div>
            <p className="text-fg-dim text-[11px]">
              {report.status.source === 'estimate'
                ? i18n.t('{source} · {platform} prices', {
                    source: costSourceLabel(report.status.source),
                    platform: report.status.pricing_custom
                      ? i18n.t('custom')
                      : (report.status.platform_label ?? i18n.t('generic')),
                  })
                : costSourceLabel(report.status.source)}
            </p>
            <SegmentBar
              label={i18n.t('Allocated and idle cost')}
              segments={[
                {
                  key: 'allocated',
                  label: i18n.t('Allocated'),
                  value: report.totals.allocated,
                  stroke: 'stroke-accent',
                  fill: 'bg-accent',
                },
                {
                  key: 'idle',
                  label: i18n.t('Idle'),
                  value: report.totals.idle ?? 0,
                  stroke: 'stroke-fg/25',
                  fill: 'bg-fg/25',
                },
              ]}
            />
            <p className="text-fg-muted text-[11px] tabular-nums">
              {report.totals.idle != null
                ? i18n.t('{idle} idle · efficiency {efficiency}', {
                    idle: formatEfficiency(share(report.totals.idle, report.totals.total)),
                    efficiency: formatEfficiency(report.totals.efficiency),
                  })
                : i18n.t('Efficiency {efficiency}', {
                    efficiency: formatEfficiency(report.totals.efficiency),
                  })}
            </p>
          </div>
          <ul className="min-w-0 space-y-1.5 text-[11.5px]">
            <li className="text-fg-dim text-[10px] font-semibold tracking-[0.12em] uppercase">
              {i18n.t('Top namespaces')}
            </li>
            {top.map((item) => (
              <li key={item.key} className="flex min-w-0 items-center gap-2">
                <span className="text-fg-muted min-w-0 flex-1 truncate">
                  {itemLabel(item, 'namespace')}
                </span>
                <span className="text-fg shrink-0 tabular-nums">
                  {perMonth(item.total_cost, report.currency, true)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
