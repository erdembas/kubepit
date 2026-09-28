import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState } from 'react';
import { ArrowDown, ArrowUp, Download, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { formatEfficiency, formatMoney } from '@/lib/cost';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import {
  LABEL_SUGGESTIONS,
  breakdownCsv,
  efficiencyTone,
  filterItems,
  itemLabel,
  share,
  sortItems,
  type CostSortKey,
} from '@/lib/kube/cost/breakdown';
import { exportFileName, toCsv } from '@/lib/tableExport';
import { useAppStore } from '@/store/useAppStore';
import { navigateTo } from '@/store/useWorkbenchStore';
import type { CostAggregate, CostItem, CostReport } from '@/types';
import { saveExportFile } from '../table/exportStore';
import { errorText } from '../util';
import { appsGvk } from './RightsizingDialog';
import { useCostPrefs } from './prefs';
import { EFFICIENCY_TEXT } from './tones';

const NAMESPACE_GVK = {
  group: '',
  version: 'v1',
  kind: 'Namespace',
  plural: 'namespaces',
  namespaced: false,
};

function aggregateLabel(a: CostAggregate): string {
  if (a === 'workload') return i18n.t('Workload');
  if (a === 'label') return i18n.t('Label');
  return i18n.t('Namespace');
}

/** Grid columns: name + total always; efficiency, resources and pods as the pane grows. */
const GRID =
  'grid grid-cols-[minmax(0,1fr)_96px] @lg:grid-cols-[minmax(0,1fr)_72px_96px] @2xl:grid-cols-[minmax(0,1fr)_80px_80px_72px_96px] @4xl:grid-cols-[minmax(0,1fr)_48px_80px_80px_80px_72px_96px]';

function HeaderCell({
  label,
  sort,
  current,
  desc,
  onSort,
  className,
  lang,
}: {
  label: string;
  lang?: string;
  sort: CostSortKey;
  current: CostSortKey;
  desc: boolean;
  onSort: (key: CostSortKey) => void;
  className?: string;
}) {
  const active = sort === current;
  const Icon = desc ? ArrowDown : ArrowUp;
  return (
    <button
      type="button"
      lang={lang}
      onClick={() => onSort(sort)}
      className={cn(
        'hover:text-fg inline-flex items-center gap-1 text-left uppercase',
        active && 'text-fg-muted',
        className,
      )}
    >
      <span className="truncate">{label}</span>
      {active && <Icon className="h-2.5 w-2.5 shrink-0" />}
    </button>
  );
}

function Row({
  item,
  report,
  base,
  onOpen,
}: {
  item: CostItem;
  report: CostReport;
  base: number;
  onOpen: (() => void) | null;
}) {
  const money = (v: number) => formatMoney(v, report.currency);
  const tone = efficiencyTone(item.efficiency);
  const label = itemLabel(item, report.aggregate);
  const sub =
    report.aggregate === 'workload' && !item.special
      ? `${item.kind ?? ''} · ${item.namespace ?? ''}`
      : report.aggregate === 'workload' && item.namespace
        ? item.namespace
        : null;
  return (
    <div className={cn(GRID, 'border-border/50 items-center gap-3 border-t px-4 py-2 text-[12px]')}>
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-2">
          {onOpen ? (
            <button
              type="button"
              onClick={onOpen}
              className="text-fg hover:text-accent min-w-0 truncate text-left font-medium"
              title={label}
            >
              {label}
            </button>
          ) : (
            <span
              className={cn(
                'min-w-0 truncate font-medium',
                item.special ? 'text-fg-muted italic' : 'text-fg',
              )}
              title={label}
            >
              {label}
            </span>
          )}
          {sub && <span className="text-fg-dim min-w-0 truncate text-[10.5px]">{sub}</span>}
        </div>
        <div className="bg-fg/7 mt-1 h-1 overflow-hidden rounded-full" aria-hidden>
          <div
            className={cn(
              'h-full rounded-full',
              item.special === 'idle' ? 'bg-fg/25' : 'bg-accent/70',
            )}
            style={{ width: `${share(item.total_cost, base) * 100}%` }}
          />
        </div>
      </div>
      <span className="text-fg-muted hidden text-right tabular-nums @4xl:block">
        {item.special === 'idle' ? '—' : item.pods}
      </span>
      <span className="text-fg-muted hidden text-right tabular-nums @2xl:block">
        {money(item.cpu_cost)}
      </span>
      <span className="text-fg-muted hidden text-right tabular-nums @2xl:block">
        {money(item.memory_cost)}
      </span>
      <span
        className="text-fg-muted hidden text-right tabular-nums @4xl:block"
        title={item.storage_bytes ? formatBytes(item.storage_bytes) : undefined}
      >
        {money(item.storage_cost + item.gpu_cost + item.other_cost)}
      </span>
      <span
        className={cn(
          'hidden text-right tabular-nums @lg:block',
          tone ? EFFICIENCY_TEXT[tone] : 'text-fg-dim',
        )}
      >
        {formatEfficiency(item.efficiency)}
      </span>
      <span className="text-fg text-right font-medium tabular-nums">{money(item.total_cost)}</span>
    </div>
  );
}

/** Breakdown table of the Cost view: group, filter, sort, export. */
export function CostBreakdown({
  clusterId,
  report,
  namespaces,
}: {
  clusterId: string;
  report: CostReport;
  namespaces: string[];
}) {
  i18n.useLocale();
  const aggregate = useCostPrefs((s) => s.aggregate);
  const label = useCostPrefs((s) => s.label);
  const showIdle = useCostPrefs((s) => s.showIdle);
  const update = useCostPrefs((s) => s.update);
  const clusterName = useAppStore((s) => s.clusters.find((c) => c.id === clusterId)?.name ?? '');
  const [labelDraft, setLabelDraft] = useState(label);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<CostSortKey>('total');
  const [desc, setDesc] = useState(true);

  const items = useMemo(
    () =>
      sortItems(
        filterItems(report.items, report.aggregate, namespaces, query, showIdle),
        sort,
        desc,
        report.aggregate,
      ),
    [report, namespaces, query, showIdle, sort, desc],
  );
  const base = useMemo(() => Math.max(0, ...items.map((i) => i.total_cost)), [items]);
  const shownTotal = items.reduce((s, i) => s + i.total_cost, 0);
  const scoped = report.aggregate !== 'label' && namespaces.length > 0;

  const onSort = (key: CostSortKey) => {
    if (key === sort) setDesc((d) => !d);
    else {
      setSort(key);
      setDesc(key !== 'name');
    }
  };
  const open = (item: CostItem): (() => void) | null => {
    if (item.special) return null;
    if (report.aggregate === 'namespace' && item.namespace)
      return () => navigateTo(clusterId, NAMESPACE_GVK, null, item.namespace);
    if (
      report.aggregate === 'workload' &&
      item.namespace &&
      (item.kind === 'Deployment' || item.kind === 'StatefulSet' || item.kind === 'DaemonSet')
    )
      return () => navigateTo(clusterId, appsGvk(item.kind!), item.namespace, item.name);
    return null;
  };
  const exportCsv = async () => {
    const { header, rows } = breakdownCsv(report, items);
    const name = exportFileName([clusterName, 'cost', report.aggregate, report.window], 'csv');
    try {
      const path = await saveExportFile(name, toCsv(header, rows), 'csv');
      if (path) useAppStore.getState().pushToast('success', i18n.t('Saved {path}', { path }));
    } catch (e) {
      useAppStore.getState().pushToast('error', errorText(e));
    }
  };
  const applyLabel = () => {
    const next = labelDraft.trim();
    if (next && next !== label) update({ label: next });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="bg-fg/4 inline-flex gap-0.5 rounded-lg p-0.5">
          {(['namespace', 'workload', 'label'] as const).map((a) => (
            <button
              key={a}
              type="button"
              aria-pressed={aggregate === a}
              onClick={() => update({ aggregate: a })}
              className={cn(
                'rounded-md px-2 py-0.5 text-[11.5px] transition',
                aggregate === a
                  ? 'bg-surface-overlay text-fg font-medium'
                  : 'text-fg-muted hover:text-fg',
              )}
            >
              {aggregateLabel(a)}
            </button>
          ))}
        </div>
        {aggregate === 'label' && (
          <span className="flex items-center gap-1.5">
            <input
              lang="en"
              list="kp-cost-label-keys"
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              onBlur={applyLabel}
              onKeyDown={(e) => e.key === 'Enter' && applyLabel()}
              aria-label={i18n.t('Label key')}
              placeholder="team"
              spellCheck={false}
              className="border-border bg-surface text-fg focus:border-accent/60 h-7 w-56 rounded-lg border px-2 font-mono text-[11.5px] outline-none"
            />
            <datalist id="kp-cost-label-keys">
              {LABEL_SUGGESTIONS.map((k) => (
                <option key={k} value={k} />
              ))}
            </datalist>
          </span>
        )}
        <Switch
          checked={showIdle}
          onChange={(v) => update({ showIdle: v })}
          label={<span className="text-[11.5px]">{i18n.t('Idle row')}</span>}
        />
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          <div className="bg-surface border-border focus-within:border-accent/50 flex h-7 w-48 min-w-24 shrink items-center gap-2 rounded-lg border px-2 transition-colors">
            <Search className="text-fg-dim h-3.5 w-3.5 shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={i18n.t('Filter…')}
              aria-label={i18n.t('Filter cost rows')}
              className="text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent text-[12px] outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={i18n.t('Clear filter')}
                className="text-fg-dim hover:text-fg"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <Button
            size="xs"
            variant="ghost"
            leftIcon={<Download className="h-3 w-3" />}
            onClick={() => void exportCsv()}
            disabled={!items.length}
          >
            {i18n.t('Export CSV')}
          </Button>
        </div>
      </div>
      <section className="rounded-app border-border bg-surface-raised/40 @container overflow-hidden border">
        <div
          className={cn(
            GRID,
            'text-fg-dim bg-fg/[0.02] gap-3 px-4 py-1.5 text-[10px] font-semibold tracking-[0.08em]',
          )}
        >
          <HeaderCell
            label={
              report.aggregate === 'label' && report.label
                ? report.label
                : aggregateLabel(report.aggregate)
            }
            lang={report.aggregate === 'label' && report.label ? 'en' : undefined}
            sort="name"
            current={sort}
            desc={desc}
            onSort={onSort}
          />
          <span className="hidden text-right uppercase @4xl:block">{i18n.t('Pods')}</span>
          <HeaderCell
            label={i18n.t('CPU')}
            sort="cpu"
            current={sort}
            desc={desc}
            onSort={onSort}
            className="hidden justify-end @2xl:inline-flex"
          />
          <HeaderCell
            label={i18n.t('Memory')}
            sort="memory"
            current={sort}
            desc={desc}
            onSort={onSort}
            className="hidden justify-end @2xl:inline-flex"
          />
          <HeaderCell
            label={i18n.t('Other')}
            sort="storage"
            current={sort}
            desc={desc}
            onSort={onSort}
            className="hidden justify-end @4xl:inline-flex"
          />
          <HeaderCell
            label={i18n.t('Efficiency')}
            sort="efficiency"
            current={sort}
            desc={desc}
            onSort={onSort}
            className="hidden justify-end @lg:inline-flex"
          />
          <HeaderCell
            label={i18n.t('Monthly')}
            sort="total"
            current={sort}
            desc={desc}
            onSort={onSort}
            className="justify-end"
          />
        </div>
        {items.length ? (
          items.map((item) => (
            <Row key={item.key} item={item} report={report} base={base} onOpen={open(item)} />
          ))
        ) : (
          <p className="text-fg-dim border-border/50 border-t px-4 py-8 text-center text-[12px]">
            {i18n.t('No cost rows match the filters.')}
          </p>
        )}
        <div className="text-fg-dim border-border/60 flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-2 text-[11px]">
          <span>{i18n.plural('{count} row', '{count} rows', items.length)}</span>
          {scoped && <span>{i18n.t('Filtered to the selected namespaces')}</span>}
          <span className="text-fg ml-auto font-medium tabular-nums">
            {i18n.t('{amount} / month', { amount: formatMoney(shownTotal, report.currency) })}
          </span>
        </div>
      </section>
    </div>
  );
}
