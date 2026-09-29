import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { ArrowRight, Boxes, Gauge, TrendingDown, TrendingUp, TriangleAlert } from 'lucide-react';
import { formatMoney } from '@/lib/cost';
import { cn } from '@/lib/cn';
import { optimizationTotals } from '@/lib/kube/recommendations/model';
import { memoryText } from '@/lib/kube/rightsizing/model';
import type { ResourceTotals, WorkloadRecommendation } from '@/types';
import { cpuWithUnit } from '../metrics/UsageHistory';
import { Card, StatTile } from '../overview/charts';
import { signedPercent, totalsChange, type ChangeDirection } from './summaryModel';

const DIRECTION_TONE: Record<ChangeDirection, string> = {
  decrease: 'text-status-running',
  increase: 'text-status-starting',
  none: 'text-fg-dim',
};

/** "↓ 6.3 cores · −51%", or "No change". */
function ChangeText({
  now,
  after,
  format,
}: {
  now: number;
  after: number;
  format: (v: number) => string;
}) {
  i18n.useLocale();
  const change = totalsChange(now, after);
  if (change.direction === 'none')
    return <span className="text-fg-dim text-[11.5px]">{i18n.t('No change')}</span>;
  const Icon = change.direction === 'decrease' ? TrendingDown : TrendingUp;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[11.5px] font-medium whitespace-nowrap tabular-nums',
        DIRECTION_TONE[change.direction],
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {format(Math.abs(change.delta))}
      {change.ratio != null && (
        <>
          <span aria-hidden="true">·</span>
          <span>{signedPercent(change.ratio)}</span>
        </>
      )}
    </span>
  );
}

/** One total: label, Now → After, the difference and what it covers. */
function TotalBlock({
  label,
  now,
  after,
  format,
  note,
}: {
  label: string;
  now: number;
  after: number;
  format: (v: number) => string;
  note?: string;
}) {
  i18n.useLocale();
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="text-fg-dim text-[10.5px] font-semibold tracking-[0.12em] uppercase">
          {label}
        </span>
        <ChangeText now={now} after={after} format={format} />
      </div>
      <div className="mt-2 flex min-w-0 items-end gap-2 tabular-nums">
        <div className="min-w-0">
          <p className="text-fg-dim text-[10px] tracking-[0.08em] uppercase">{i18n.t('Now')}</p>
          <p className="text-fg-muted mt-0.5 truncate text-[15px] leading-none">{format(now)}</p>
        </div>
        <ArrowRight className="text-fg-dim mb-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <div className="min-w-0">
          <p className="text-fg-dim text-[10px] tracking-[0.08em] uppercase">{i18n.t('After')}</p>
          <p className="text-fg mt-0.5 truncate text-[20px] leading-none font-semibold tracking-tight">
            {format(after)}
          </p>
        </div>
      </div>
      {note && <p className="text-fg-dim mt-2 text-[11px]">{note}</p>}
    </div>
  );
}

/** "9/12 containers comparable · 2 without requests". */
function comparableText(totals: ResourceTotals, containers: number): string {
  return totals.unset > 0
    ? i18n.plural(
        '{comparable}/{count} container comparable · {unset} without requests',
        '{comparable}/{count} containers comparable · {unset} without requests',
        containers,
        { comparable: i18n.number(totals.comparable), unset: i18n.number(totals.unset) },
      )
    : i18n.plural(
        '{comparable}/{count} container comparable',
        '{comparable}/{count} containers comparable',
        containers,
        { comparable: i18n.number(totals.comparable) },
      );
}

/**
 * CPU and memory requests Now → After over the comparable containers of
 * `list` (× the replicas behind costs), the monthly requests cost, and the
 * honest footnote.
 */
export function OptimizationSummary({
  list,
  currency,
}: {
  list: readonly WorkloadRecommendation[];
  currency: string;
}) {
  i18n.useLocale();
  const totals = useMemo(() => optimizationTotals(list), [list]);
  const monthlyAfter = totals.monthly_current - totals.monthly_savings + totals.monthly_increases;
  const money = (v: number) => formatMoney(v, currency, { compact: true });

  return (
    <Card title={i18n.t('Optimization summary')} icon={<Gauge />} className="@container">
      <div className="divide-border/50 grid divide-y @md:grid-cols-2 @md:divide-x @md:divide-y-0">
        <TotalBlock
          label={i18n.t('CPU requests')}
          now={totals.cpu.current}
          after={totals.cpu.recommended}
          format={cpuWithUnit}
          note={comparableText(totals.cpu, totals.containers)}
        />
        <TotalBlock
          label={i18n.t('Memory requests')}
          now={totals.memory.current}
          after={totals.memory.recommended}
          format={memoryText}
          note={comparableText(totals.memory, totals.containers)}
        />
      </div>
      <div className="border-border/60 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-2">
        <span className="text-fg-dim text-[10.5px] font-semibold tracking-[0.12em] uppercase">
          {i18n.t('Monthly requests cost')}
        </span>
        <span className="inline-flex items-center gap-1.5 text-[12px] tabular-nums">
          <span className="text-fg-muted">{money(totals.monthly_current)}</span>
          <ArrowRight className="text-fg-dim h-3 w-3 shrink-0" aria-hidden />
          <span className="text-fg font-medium">{money(monthlyAfter)}</span>
        </span>
        <ChangeText now={totals.monthly_current} after={monthlyAfter} format={money} />
      </div>
      <p className="border-border/60 text-fg-dim border-t px-4 py-2 text-[11px]">
        {i18n.t('Totals use requests × current replicas. They are not freed node capacity.')}
      </p>
    </Card>
  );
}

/** Under-provisioned workloads; a click shows them in the list. */
export function AttentionTile({ count, onClick }: { count: number; onClick: () => void }) {
  i18n.useLocale();
  return (
    <StatTile
      icon={<TriangleAlert />}
      label={i18n.t('Attention')}
      value={i18n.number(count)}
      tone={count > 0 ? 'text-status-starting' : 'text-fg'}
      sub={i18n.plural('under-provisioned workload', 'under-provisioned workloads', count)}
      onClick={onClick}
    />
  );
}

/** Workloads, containers and namespaces in scope. */
export function InventoryTile({
  workloads,
  containers,
  namespaces,
}: {
  workloads: number;
  containers: number;
  namespaces: number;
}) {
  i18n.useLocale();
  const stats = [
    { key: 'workloads', value: workloads, label: i18n.plural('workload', 'workloads', workloads) },
    {
      key: 'containers',
      value: containers,
      label: i18n.plural('container', 'containers', containers),
    },
    {
      key: 'namespaces',
      value: namespaces,
      label: i18n.plural('namespace', 'namespaces', namespaces),
    },
  ];
  return (
    <div className="rounded-app border-border bg-surface-raised/40 flex min-w-0 flex-col border px-4 py-3">
      <span className="text-fg-dim flex items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.12em] uppercase">
        <Boxes className="h-3 w-3" aria-hidden />
        {i18n.t('Inventory')}
      </span>
      <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2 gap-y-0.5">
        {stats.map((s) => (
          <div key={s.key} className="col-span-2 grid grid-cols-subgrid items-baseline">
            <dt className="text-fg-dim col-start-2 row-start-1 truncate text-[11.5px]">
              {s.label}
            </dt>
            <dd className="text-fg col-start-1 row-start-1 text-right text-[14px] font-semibold tabular-nums">
              {i18n.number(s.value)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
