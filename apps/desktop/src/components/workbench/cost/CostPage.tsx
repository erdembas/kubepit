import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import {
  BadgeDollarSign,
  CircleDollarSign,
  Gauge,
  LineChart,
  Loader2,
  PiggyBank,
  RefreshCw,
  Tags,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { IconButton } from '@/components/ui/IconButton';
import { Tabs } from '@/components/ui/Tabs';
import {
  costPlatformLabel,
  costServiceLabel,
  costSourceLabel,
  formatEfficiency,
  formatMoney,
  pricingSummary,
} from '@/lib/cost';
import { cn } from '@/lib/cn';
import { efficiencyTone, share } from '@/lib/kube/cost/breakdown';
import { seriesColor } from '@/lib/prometheus';
import type { CostReport, CostUsageSource, CostWindow } from '@/types';
import { useSelectedNamespaces } from '../data/hooks';
import { NamespacePicker } from '../header/NamespacePicker';
import { ProxyForbiddenNotice } from '../common/ProxyForbiddenNotice';
import { MultiSeriesChart } from '../overview/MultiSeriesChart';
import { Card, Legend, SegmentBar, StatTile, type Segment } from '../overview/charts';
import { CostBreakdown } from './CostBreakdown';
import { CostNotes } from './CostNotes';
import { RightsizingSummaryCard } from './RightsizingSummaryCard';
import { useCostPrefs, type CostTab } from './prefs';
import { EFFICIENCY_TEXT } from './tones';
import { useCostReport } from './useCost';

const DAY = 86_400_000;

function scopeLabel(namespaces: string[]) {
  if (!namespaces.length) return i18n.t('All namespaces');
  if (namespaces.length === 1) return namespaces[0]!;
  return i18n.t('{count} namespaces', { count: namespaces.length });
}

function usageLabel(usage: CostUsageSource, window: CostWindow): string {
  switch (usage) {
    case 'cost-api':
      return i18n.t('Usage averages from the cost API');
    case 'prometheus':
      return window === '30d'
        ? i18n.t('Usage: Prometheus average over 30 days')
        : i18n.t('Usage: Prometheus average over 7 days');
    case 'metrics-server':
      return i18n.t('Usage: current metrics-server snapshot');
    default:
      return i18n.t('No usage data: requests only');
  }
}

/** Source, price model and what the numbers are based on. */
export function PriceModelCard({ report }: { report: CostReport }) {
  i18n.useLocale();
  const st = report.status;
  const api = st.source !== 'estimate';
  return (
    <Card title={i18n.t('Source and price model')} icon={<Tags />}>
      <div className="space-y-2 px-4 py-3 text-[12px]">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={api ? 'success' : 'info'}>{costSourceLabel(st.source)}</Badge>
          {st.service && api && (
            <span className="text-fg-dim font-mono text-[11px]">
              {costServiceLabel(st.service)}
            </span>
          )}
          {st.configured && (
            <span className="text-fg-dim text-[11px]">{i18n.t('set in the cluster settings')}</span>
          )}
        </div>
        {api ? (
          <p className="text-fg-muted text-[11.5px]">
            {i18n.t(
              '{source} allocates costs with its own prices (cloud billing or its configured price list), including idle capacity, volumes and network.',
              { source: costSourceLabel(st.source) },
            )}
          </p>
        ) : (
          <>
            <p className="text-fg-muted text-[11.5px]">
              {st.pricing_custom
                ? i18n.t('Custom price model from the cluster settings.')
                : i18n.t(
                    'Default list prices for {platform}: an estimate without discounts, spot or control plane fees.',
                    { platform: costPlatformLabel(st.platform) },
                  )}
            </p>
            <ul className="text-fg-dim space-y-0.5 text-[11px] tabular-nums">
              {pricingSummary(st.pricing).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {st.forbidden && st.service ? (
              <ProxyForbiddenNotice
                what={costSourceLabel(st.service.kind)}
                namespace={st.service.namespace}
                message={st.error}
                className="max-w-none"
              />
            ) : st.error && st.service ? (
              <p className="text-fg-dim text-[11px] break-words">
                {i18n.t('{service} was found but did not answer: {error}', {
                  service: costServiceLabel(st.service),
                  error: st.error,
                })}
              </p>
            ) : null}
          </>
        )}
        <p className="text-fg-dim text-[11px]">{usageLabel(report.usage, report.window)}</p>
      </div>
    </Card>
  );
}

function AllocationCard({ report }: { report: CostReport }) {
  i18n.useLocale();
  const t = report.totals;
  const money = (v: number) => formatMoney(v, report.currency, { compact: true });
  const segments: Segment[] = [
    { key: 'cpu', label: i18n.t('CPU'), value: t.cpu, stroke: 'stroke-accent', fill: 'bg-accent' },
    {
      key: 'memory',
      label: i18n.t('Memory'),
      value: t.memory,
      stroke: 'stroke-cat-frontend',
      fill: 'bg-cat-frontend',
    },
    {
      key: 'storage',
      label: i18n.t('Volumes'),
      value: t.storage,
      stroke: 'stroke-cat-database',
      fill: 'bg-cat-database',
    },
    {
      key: 'gpu',
      label: i18n.t('GPU'),
      value: t.gpu,
      stroke: 'stroke-cat-backend',
      fill: 'bg-cat-backend',
    },
    {
      key: 'other',
      label: i18n.t('Network and other'),
      value: t.other,
      stroke: 'stroke-cat-tooling',
      fill: 'bg-cat-tooling',
    },
  ].filter((s) => s.value > 0);
  const allocation: Segment[] = [
    {
      key: 'allocated',
      label: i18n.t('Allocated'),
      value: t.allocated,
      stroke: 'stroke-accent',
      fill: 'bg-accent',
    },
    ...(t.idle != null
      ? [
          {
            key: 'idle',
            label: i18n.t('Idle'),
            value: t.idle,
            stroke: 'stroke-fg/25',
            fill: 'bg-fg/25',
          },
        ]
      : []),
  ];
  return (
    <Card title={i18n.t('Where the money goes')} icon={<CircleDollarSign />}>
      <div className="space-y-4 px-4 py-3">
        <div className="space-y-2">
          <SegmentBar segments={allocation} label={i18n.t('Allocated and idle cost')} />
          <Legend
            items={allocation.map((s) => ({
              key: s.key,
              label: s.label,
              fill: s.fill,
              value: money(s.value),
              pct: formatEfficiency(share(s.value, t.total)),
            }))}
          />
          {t.idle == null && (
            <p className="text-fg-dim text-[11px]">
              {i18n.t('Idle is unknown without node access.')}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <SegmentBar segments={segments} label={i18n.t('Cost by resource')} />
          <Legend
            items={segments.map((s) => ({
              key: s.key,
              label: s.label,
              fill: s.fill,
              value: money(s.value),
              pct: formatEfficiency(share(s.value, t.total)),
            }))}
          />
        </div>
      </div>
    </Card>
  );
}

function TrendCard({ report }: { report: CostReport }) {
  i18n.useLocale();
  const points = useMemo(() => report.trend.map((p) => ({ t: p.ts, v: p.total })), [report]);
  const title =
    report.trend_basis === 'requests' ? i18n.t('Requested cost per day') : i18n.t('Cost per day');
  return (
    <Card
      title={title}
      icon={<LineChart />}
      actions={
        <span className="text-fg-dim text-[11px]">
          {report.window === '30d' ? i18n.t('Last 30 days') : i18n.t('Last 7 days')}
        </span>
      }
    >
      {points.length ? (
        <div className="px-2 pt-2 pb-1">
          <MultiSeriesChart
            series={[{ key: 'cost', label: title, points, color: seriesColor(0) }]}
            from={report.start}
            to={report.end}
            intervalMs={DAY}
            formatValue={(v) => formatMoney(v, report.currency, { compact: true })}
            height={180}
            label={title}
          />
        </div>
      ) : (
        <p className="text-fg-dim px-4 py-8 text-center text-[12px]">
          {i18n.t('A trend needs OpenCost, Kubecost or Prometheus on this cluster.')}
        </p>
      )}
      {report.trend_basis === 'requests' && points.length > 0 && (
        <p className="text-fg-dim border-border/60 border-t px-4 py-2 text-[11px]">
          {i18n.t('Requests × prices per day from Prometheus; idle capacity is not included.')}
        </p>
      )}
    </Card>
  );
}

/** The `@cost` view: monthly cost, breakdown, trend and the right-sizing summary. */
export function CostPage({
  clusterId,
  viewKey,
  isActive,
}: {
  clusterId: string;
  viewKey: string;
  isActive: boolean;
}) {
  i18n.useLocale();
  const namespaces = useSelectedNamespaces(clusterId, viewKey);
  const window = useCostPrefs((s) => s.window);
  const aggregate = useCostPrefs((s) => s.aggregate);
  const label = useCostPrefs((s) => s.label);
  const tab = useCostPrefs((s) => s.tab);
  const update = useCostPrefs((s) => s.update);
  const query = useCostReport(clusterId, window, aggregate, label, isActive);
  const report = query.data;
  const t = report?.totals;
  const eff = efficiencyTone(t?.efficiency ?? null);

  const tabs = useMemo(
    () => [
      { key: 'breakdown' as CostTab, label: i18n.t('Breakdown') },
      { key: 'rightsizing' as CostTab, label: i18n.t('Right-sizing') },
    ],
    [],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="border-border/60 @container flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <span className="bg-accent/10 text-accent flex h-6 w-6 shrink-0 items-center justify-center rounded-md">
          <BadgeDollarSign className="h-3.5 w-3.5" />
        </span>
        <h2 className="text-fg shrink-0 text-[13px] font-semibold">{i18n.t('Cost')}</h2>
        <span className="text-fg-dim hidden truncate text-[11px] @lg:inline">
          {scopeLabel(namespaces)}
        </span>
        {report && (
          <Badge
            tone={report.status.source === 'estimate' ? 'info' : 'success'}
            className="hidden @md:inline-flex"
          >
            {costSourceLabel(report.status.source)}
          </Badge>
        )}
        {query.loading && <Loader2 className="text-fg-dim h-3 w-3 animate-spin" />}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <NamespacePicker clusterId={clusterId} viewKey={viewKey} isActive={isActive} />
          <div className="bg-fg/4 inline-flex gap-0.5 rounded-lg p-0.5">
            {(['7d', '30d'] as const).map((w) => (
              <button
                key={w}
                type="button"
                aria-pressed={window === w}
                onClick={() => update({ window: w })}
                className={cn(
                  'rounded-md px-2 py-0.5 text-[11.5px] tabular-nums transition',
                  window === w
                    ? 'bg-surface-overlay text-fg font-medium'
                    : 'text-fg-muted hover:text-fg',
                )}
              >
                {w === '7d' ? i18n.t('7 days') : i18n.t('30 days')}
              </button>
            ))}
          </div>
          <IconButton
            label={i18n.t('Detect again and refresh')}
            icon={<RefreshCw />}
            onClick={query.forceRefresh}
          />
        </div>
      </div>
      <div className="overlay-scroll min-h-0 flex-1 overflow-auto">
        <div className="@container mx-auto max-w-6xl space-y-4 p-5">
          {!report ? (
            <div className="text-fg-muted flex items-center justify-center gap-2 py-16 text-[12.5px]">
              {query.error ? (
                <span className="text-status-error">{query.error}</span>
              ) : (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {i18n.t('Computing costs…')}
                </>
              )}
            </div>
          ) : (
            <>
              <CostNotes notes={report.notes} api={report.status.service?.kind ?? null} />
              <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
                <StatTile
                  icon={<CircleDollarSign />}
                  label={i18n.t('Monthly cost')}
                  value={formatMoney(t!.total, report.currency, { compact: true })}
                  sub={
                    report.status.source === 'estimate'
                      ? i18n.t('estimated run rate')
                      : i18n.t('run rate from {source}', {
                          source: costSourceLabel(report.status.source),
                        })
                  }
                />
                <StatTile
                  icon={<PiggyBank />}
                  label={i18n.t('Idle')}
                  value={
                    t!.idle != null ? formatMoney(t!.idle, report.currency, { compact: true }) : '—'
                  }
                  sub={
                    t!.idle != null
                      ? i18n.t('{percent} of the total', {
                          percent: formatEfficiency(share(t!.idle, t!.total)),
                        })
                      : i18n.t('capacity unknown')
                  }
                />
                <StatTile
                  icon={<Gauge />}
                  label={i18n.t('Efficiency')}
                  value={formatEfficiency(t!.efficiency)}
                  tone={eff ? EFFICIENCY_TEXT[eff] : 'text-fg'}
                  sub={i18n.t('usage ÷ requests')}
                />
                <StatTile
                  label={i18n.t('Allocated')}
                  value={formatMoney(t!.allocated, report.currency, { compact: true })}
                  sub={i18n.t('CPU {cpu} · memory {memory}', {
                    cpu: formatEfficiency(t!.cpu_efficiency),
                    memory: formatEfficiency(t!.memory_efficiency),
                  })}
                />
              </div>
              <div className="grid gap-3 @3xl:grid-cols-2">
                <AllocationCard report={report} />
                <PriceModelCard report={report} />
              </div>
              <TrendCard report={report} />
            </>
          )}
          <Tabs tabs={tabs} value={tab} onChange={(k) => update({ tab: k })} />
          {tab === 'breakdown' ? (
            report ? (
              <CostBreakdown clusterId={clusterId} report={report} namespaces={namespaces} />
            ) : null
          ) : (
            <RightsizingSummaryCard clusterId={clusterId} enabled={isActive} />
          )}
        </div>
      </div>
    </div>
  );
}
