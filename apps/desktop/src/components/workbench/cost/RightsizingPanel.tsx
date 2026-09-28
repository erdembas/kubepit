import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState } from 'react';
import {
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { formatMoney } from '@/lib/cost';
import { cn } from '@/lib/cn';
import {
  DEFAULT_RIGHTSIZING,
  confidenceLabel,
  containerChanged,
  cpuText,
  filterRecommendations,
  memoryText,
  reportDays,
  rightsizingTotals,
  sourceLabel,
  strategyLabel,
  verdictLabel,
  workloadGvk,
  type RightsizingFilter,
} from '@/lib/kube/rightsizing/model';
import { navigateTo } from '@/store/useWorkbenchStore';
import type { RightsizingSettings, WorkloadRecommendation } from '@/types';
import { Card, StatTile } from '../overview/charts';
import { ChangeCell, RaisedTag, RightsizingDialog } from './RightsizingDialog';
import { NoteBanner, rightsizingNoteText } from './CostNotes';
import { useCostPrefs } from './prefs';
import { CONFIDENCE_TONE, VERDICT_TONE } from './tones';
import { useRightsizing } from './useCost';

const FILTERS: RightsizingFilter[] = ['changed', 'over', 'under', 'all'];

function filterLabel(f: RightsizingFilter): string {
  switch (f) {
    case 'changed':
      return i18n.t('With changes');
    case 'over':
      return i18n.t('Over-provisioned');
    case 'under':
      return i18n.t('Under-provisioned');
    default:
      return i18n.t('All workloads');
  }
}

function NumberField({
  label,
  value,
  suffix,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  suffix: string;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-fg-dim text-[10.5px] font-semibold tracking-[0.1em] uppercase">
        {label}
      </span>
      <span className="flex items-center gap-1.5">
        <Input
          inputMode="decimal"
          value={text}
          className="h-7 w-20 py-1 text-[12px] tabular-nums"
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            const n = Number(text.replace(',', '.'));
            const next = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : value;
            setText(String(next));
            if (next !== value) onChange(next);
          }}
        />
        <span className="text-fg-dim text-[11px]">{suffix}</span>
      </span>
    </label>
  );
}

function SettingsCard({
  settings,
  onChange,
}: {
  settings: RightsizingSettings;
  onChange: (s: RightsizingSettings) => void;
}) {
  i18n.useLocale();
  const set = <K extends keyof RightsizingSettings>(key: K, v: RightsizingSettings[K]) =>
    onChange({ ...settings, [key]: v });
  const key = JSON.stringify(settings);
  return (
    <Card
      title={i18n.t('Recommendation settings')}
      icon={<SlidersHorizontal />}
      actions={
        <button
          type="button"
          onClick={() => onChange(DEFAULT_RIGHTSIZING)}
          className="text-fg-dim hover:text-fg inline-flex items-center gap-1 text-[11px]"
        >
          <RotateCcw className="h-3 w-3" />
          {i18n.t('Defaults')}
        </button>
      }
    >
      <div key={key} className="flex flex-wrap gap-x-5 gap-y-3 px-4 py-3">
        <NumberField
          label={i18n.t('CPU headroom')}
          value={settings.cpu_headroom_percent}
          suffix="%"
          min={0}
          max={300}
          onChange={(v) => set('cpu_headroom_percent', v)}
        />
        <NumberField
          label={i18n.t('Memory headroom')}
          value={settings.memory_headroom_percent}
          suffix="%"
          min={0}
          max={300}
          onChange={(v) => set('memory_headroom_percent', v)}
        />
        <NumberField
          label={i18n.t('Memory limit headroom')}
          value={settings.memory_limit_headroom_percent}
          suffix="%"
          min={0}
          max={300}
          onChange={(v) => set('memory_limit_headroom_percent', v)}
        />
        <NumberField
          label={i18n.t('History')}
          value={settings.days}
          suffix={i18n.t('days')}
          min={1}
          max={30}
          onChange={(v) => set('days', Math.round(v))}
        />
      </div>
      <p className="text-fg-dim border-border/60 border-t px-4 py-2 text-[11px]">
        {i18n.t(
          'CPU requests follow the p95 of usage, memory requests and limits the peak; values round up and never go below what was observed.',
        )}
      </p>
    </Card>
  );
}

function RecommendationRow({
  rec,
  currency,
  onOpen,
  onApply,
}: {
  rec: WorkloadRecommendation;
  currency: string;
  onOpen: () => void;
  onApply: () => void;
}) {
  i18n.useLocale();
  const delta = rec.monthly_delta;
  const shown = rec.containers.filter((c) => containerChanged(c) || !rec.changed);
  return (
    <div className="border-border/50 grid gap-x-4 gap-y-1.5 border-t px-4 py-2.5 first:border-t-0 @2xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_auto] @2xl:items-center">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-fg-dim shrink-0 text-[10.5px]">{rec.kind}</span>
          <button
            type="button"
            onClick={onOpen}
            className="text-fg hover:text-accent min-w-0 truncate text-left text-[12.5px] font-medium"
            title={`${rec.namespace}/${rec.name}`}
          >
            {rec.name}
          </button>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          <span className="text-fg-dim mr-1 truncate text-[11px]">{rec.namespace}</span>
          <Badge tone={VERDICT_TONE[rec.verdict]} size="xs">
            {verdictLabel(rec.verdict)}
          </Badge>
          {rec.verdict !== 'no-data' && (
            <Badge tone={CONFIDENCE_TONE[rec.confidence]} size="xs">
              {confidenceLabel(rec.confidence)}
            </Badge>
          )}
        </div>
      </div>
      <ul className="min-w-0 space-y-0.5 text-[11.5px]">
        {shown.map((c) => (
          <li key={c.name} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-fg-muted max-w-[140px] truncate font-medium" title={c.name}>
              {c.name}
            </span>
            <span className="text-fg-dim">{i18n.t('CPU')}</span>
            <ChangeCell
              current={c.current.cpu_request}
              next={c.recommended.cpu_request}
              change={c.cpu}
              format={cpuText}
            />
            <span className="text-fg-dim">{i18n.t('Memory')}</span>
            <ChangeCell
              current={c.current.memory_request}
              next={c.recommended.memory_request}
              change={c.memory}
              format={memoryText}
            />
            {(c.cpu_limit_raised || c.memory_limit_raised) && <RaisedTag ratio={null} />}
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-3 @2xl:justify-end">
        {rec.changed ? (
          <span
            className={cn(
              'inline-flex items-center gap-1 text-[12px] font-medium whitespace-nowrap tabular-nums',
              delta < 0 ? 'text-status-running' : 'text-status-starting',
            )}
          >
            {delta < 0 ? (
              <TrendingDown className="h-3.5 w-3.5" />
            ) : (
              <TrendingUp className="h-3.5 w-3.5" />
            )}
            {i18n.t('{amount} / month', {
              amount: formatMoney(delta, currency, { signed: true }),
            })}
          </span>
        ) : (
          <span className="text-fg-dim text-[11.5px]">{i18n.t('No change')}</span>
        )}
        <Button size="xs" variant="secondary" disabled={!rec.changed} onClick={onApply}>
          {i18n.t('Review & apply')}
        </Button>
      </div>
    </div>
  );
}

/** Right-sizing tab of the Cost view. */
export function RightsizingPanel({
  clusterId,
  namespaces,
  isActive,
}: {
  clusterId: string;
  namespaces: string[];
  isActive: boolean;
}) {
  i18n.useLocale();
  const settings = useCostPrefs((s) => s.settings);
  const strategy = useCostPrefs((s) => s.strategy);
  const update = useCostPrefs((s) => s.update);
  const report = useRightsizing(clusterId, namespaces, null, settings, strategy, isActive);
  const [filter, setFilter] = useState<RightsizingFilter>('changed');
  const [query, setQuery] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [applying, setApplying] = useState<WorkloadRecommendation | null>(null);
  const data = report.data;

  const list = useMemo(
    () => (data ? filterRecommendations(data.workloads, filter, namespaces, query) : []),
    [data, filter, namespaces, query],
  );
  const totals = useMemo(
    () =>
      rightsizingTotals(data ? filterRecommendations(data.workloads, 'all', namespaces, '') : []),
    [data, namespaces],
  );
  const currency = data?.currency ?? 'USD';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
        <Sparkles className="text-accent h-3.5 w-3.5 shrink-0" />
        <span className="text-fg-muted">
          {data
            ? i18n.t('Usage: {source}', { source: sourceLabel(data.source, reportDays(data)) })
            : i18n.t('Reading usage history…')}
        </span>
        {data && data.strategies.length > 1 && (
          <Select
            value={data.strategy}
            onChange={(v) => update({ strategy: v })}
            ariaLabel={i18n.t('Strategy')}
            options={data.strategies.map((s) => ({ value: s.id, label: strategyLabel(s) }))}
          />
        )}
        {data && data.strategies.length <= 1 && (
          <span className="text-fg-dim">
            {i18n.t('Strategy: {name}', {
              name: strategyLabel(
                data.strategies.find((s) => s.id === data.strategy) ?? {
                  id: data.strategy,
                  name: data.strategy,
                },
              ),
            })}
          </span>
        )}
        {report.loading && <Loader2 className="text-fg-dim h-3 w-3 animate-spin" />}
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="xs"
            variant={showSettings ? 'secondary' : 'ghost'}
            leftIcon={<SlidersHorizontal className="h-3 w-3" />}
            onClick={() => setShowSettings((v) => !v)}
          >
            {i18n.t('Settings')}
          </Button>
          <IconButton
            size="xs"
            label={i18n.t('Recompute')}
            icon={<RefreshCw />}
            onClick={() => void report.refresh()}
          />
        </div>
      </div>
      {showSettings && (
        <SettingsCard settings={settings} onChange={(s) => update({ settings: s })} />
      )}
      {report.error && !data && <NoteBanner>{report.error}</NoteBanner>}
      {data?.notes.map((n) => (
        <NoteBanner key={n.kind}>{rightsizingNoteText(n)}</NoteBanner>
      ))}
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <StatTile
          icon={<TrendingDown />}
          label={i18n.t('Potential saving')}
          value={data ? formatMoney(totals.savings, currency, { compact: true }) : '—'}
          tone={totals.savings > 0 ? 'text-status-running' : 'text-fg'}
          sub={i18n.t('per month')}
        />
        <StatTile
          icon={<TrendingUp />}
          label={i18n.t('Needed increases')}
          value={data ? formatMoney(totals.increases, currency, { compact: true }) : '—'}
          tone={totals.increases > 0 ? 'text-status-starting' : 'text-fg'}
          sub={i18n.t('per month')}
        />
        <StatTile
          label={i18n.t('Over-provisioned')}
          value={data ? totals.over : '—'}
          sub={i18n.plural(
            '{count} workload checked',
            '{count} workloads checked',
            totals.workloads,
          )}
          onClick={() => setFilter('over')}
        />
        <StatTile
          label={i18n.t('Under-provisioned')}
          value={data ? totals.under : '—'}
          tone={totals.under > 0 ? 'text-status-starting' : 'text-fg'}
          sub={i18n.t('usage above requests')}
          onClick={() => setFilter('under')}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="bg-fg/4 inline-flex flex-wrap gap-0.5 rounded-lg p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                'rounded-md px-2 py-0.5 text-[11.5px] transition',
                filter === f
                  ? 'bg-surface-overlay text-fg font-medium'
                  : 'text-fg-muted hover:text-fg',
              )}
            >
              {filterLabel(f)}
            </button>
          ))}
        </div>
        <div className="bg-surface border-border focus-within:border-accent/50 ml-auto flex h-7 w-52 min-w-24 shrink items-center gap-2 rounded-lg border px-2 transition-colors">
          <Search className="text-fg-dim h-3.5 w-3.5 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={i18n.t('Filter workloads…')}
            aria-label={i18n.t('Filter workloads')}
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
      </div>
      <Card
        title={i18n.t('Recommendations')}
        actions={
          data ? (
            <span className="text-fg-dim text-[11px] tabular-nums">
              {i18n.plural('{count} workload', '{count} workloads', list.length)}
            </span>
          ) : undefined
        }
      >
        {!data ? (
          <div className="text-fg-muted flex items-center justify-center gap-2 px-4 py-10 text-[12px]">
            {report.error ? (
              <span className="text-status-error">{report.error}</span>
            ) : (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {i18n.t('Computing recommendations…')}
              </>
            )}
          </div>
        ) : !list.length ? (
          <p className="text-fg-dim px-4 py-10 text-center text-[12px]">
            {filter === 'changed' && !query
              ? i18n.t('Every workload is sized well for its usage.')
              : i18n.t('No workloads match the filters.')}
          </p>
        ) : (
          list.map((rec) => (
            <RecommendationRow
              key={`${rec.kind}/${rec.namespace}/${rec.name}`}
              rec={rec}
              currency={currency}
              onOpen={() => navigateTo(clusterId, workloadGvk(rec.kind), rec.namespace, rec.name)}
              onApply={() => setApplying(rec)}
            />
          ))
        )}
      </Card>
      {applying && (
        <RightsizingDialog
          clusterId={clusterId}
          rec={applying}
          currency={currency}
          onClose={() => setApplying(null)}
        />
      )}
    </div>
  );
}
