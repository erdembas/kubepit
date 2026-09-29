import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState } from 'react';
import { ChevronLeft, ChevronRight, ListOrdered, Search, X } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { cn } from '@/lib/cn';
import { rankUsage, workloadKey } from '@/lib/kube/recommendations/model';
import { memoryText } from '@/lib/kube/rightsizing/model';
import type { WorkloadRecommendation } from '@/types';
import { cpuWithUnit } from '../metrics/UsageHistory';
import { Card } from '../overview/charts';
import { Segmented } from './Segmented';
import { pageOf, searchRanking, type RankedRow } from './rankingModel';

type Resource = 'cpu' | 'memory';
type Stat = 'avg' | 'peak';

/** #, workload / container, value; the namespace gets its own column from `@lg`. */
const GRID =
  'grid grid-cols-[1.75rem_minmax(0,1fr)_auto] @lg:grid-cols-[1.75rem_minmax(0,1fr)_minmax(0,10rem)_8rem]';

function valueLabel(resource: Resource, stat: Stat): string {
  if (resource === 'memory')
    return stat === 'avg' ? i18n.t('Average memory') : i18n.t('Peak memory');
  return stat === 'avg' ? i18n.t('Average CPU') : i18n.t('Peak CPU');
}

function RankingRow({
  row,
  top,
  format,
  active,
  onOpen,
}: {
  row: RankedRow;
  top: number;
  format: (v: number) => string;
  active: boolean;
  onOpen: () => void;
}) {
  i18n.useLocale();
  const { rec } = row;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={`${rec.kind} ${rec.namespace}/${rec.name} · ${row.container}`}
        className={cn(
          GRID,
          'border-border/50 relative w-full min-w-0 items-center gap-x-3 border-t px-4 py-1.5 text-left text-[12px] transition-colors',
          active ? 'bg-fg/6' : 'hover:bg-fg/4',
        )}
      >
        {active && <span className="bg-accent absolute inset-y-1 left-0 w-0.5 rounded-full" />}
        <span className="text-fg-dim text-[11px] tabular-nums">{i18n.number(row.rank)}</span>
        <span className="min-w-0">
          <span className="flex min-w-0 items-baseline gap-1">
            <span className="text-fg min-w-0 truncate font-medium">{rec.name}</span>
            <span className="text-fg-dim min-w-0 shrink-[2] truncate">/ {row.container}</span>
          </span>
          <span className="text-fg-dim block truncate text-[10.5px]">
            {rec.kind}
            <span className="@lg:hidden"> · {rec.namespace}</span>
          </span>
          <span className="bg-fg/7 mt-1 block h-1 overflow-hidden rounded-full" aria-hidden>
            <span
              className="bg-accent/70 block h-full rounded-full"
              style={{ width: `${top > 0 ? (row.value / top) * 100 : 0}%` }}
            />
          </span>
        </span>
        <span className="text-fg-muted hidden truncate text-[11.5px] @lg:block">
          {rec.namespace}
        </span>
        <span className="text-fg text-right font-medium whitespace-nowrap tabular-nums">
          {format(row.value)}
        </span>
      </button>
    </li>
  );
}

/**
 * Workload containers by memory or CPU usage (average or peak), highest
 * first, 8 per page, searchable by workload, container and namespace.
 * Containers without the value are left out and only counted in the
 * footer; a click opens the workload in the drawer.
 */
export function UsageRanking({
  list,
  onOpen,
  active = null,
}: {
  list: readonly WorkloadRecommendation[];
  onOpen: (rec: WorkloadRecommendation) => void;
  /** `workloadKey` of the row open in the drawer. */
  active?: string | null;
}) {
  i18n.useLocale();
  const [resource, setResource] = useState<Resource>('memory');
  const [stat, setStat] = useState<Stat>('avg');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const ranking = useMemo(() => rankUsage(list, resource, stat), [list, resource, stat]);
  const matched = useMemo(() => searchRanking(ranking.rows, query), [ranking, query]);
  const shown = pageOf(matched, page);
  const top = ranking.rows[0]?.value ?? 0;
  const format = resource === 'cpu' ? cpuWithUnit : memoryText;
  const restart =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPage(0);
    };

  return (
    <Card title={i18n.t('Usage ranking')} icon={<ListOrdered />} className="@container">
      <div className="border-border/60 flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <Segmented
          value={resource}
          onChange={restart(setResource)}
          label={i18n.t('Resource of the usage ranking')}
          options={[
            { key: 'memory', label: i18n.t('Memory') },
            { key: 'cpu', label: i18n.t('CPU') },
          ]}
        />
        <Segmented
          value={stat}
          onChange={restart(setStat)}
          label={i18n.t('Statistic of the usage ranking')}
          options={[
            { key: 'avg', label: i18n.t('Average') },
            { key: 'peak', label: i18n.t('Peak') },
          ]}
        />
        <div className="bg-surface border-border focus-within:border-accent/50 flex h-7 w-full min-w-0 items-center gap-2 rounded-lg border px-2 transition-colors @md:ml-auto @md:w-52">
          <Search className="text-fg-dim h-3.5 w-3.5 shrink-0" />
          <input
            value={query}
            onChange={(e) => restart(setQuery)(e.target.value)}
            placeholder={i18n.t('Filter workloads…')}
            aria-label={i18n.t('Filter the usage ranking')}
            className="text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent text-[12px] outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => restart(setQuery)('')}
              aria-label={i18n.t('Clear filter')}
              className="text-fg-dim hover:text-fg"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
      {ranking.total === 0 ? (
        <p className="text-fg-dim px-4 py-10 text-center text-[12px]">
          {i18n.t('No workloads in the namespaces in scope.')}
        </p>
      ) : ranking.available === 0 ? (
        <p className="text-fg-dim px-4 py-10 text-center text-[12px]">
          {i18n.t('No container has usage data in this scan.')}
        </p>
      ) : !matched.length ? (
        <p className="text-fg-dim px-4 py-10 text-center text-[12px]">
          {i18n.t('No workloads match the filters.')}
        </p>
      ) : (
        <>
          <div
            className={cn(
              GRID,
              'text-fg-dim bg-fg/[0.02] gap-x-3 px-4 py-1.5 text-[10px] font-semibold tracking-[0.08em] uppercase',
            )}
          >
            <span>#</span>
            <span className="truncate">
              {i18n.rich('Workload / {container}', { container: <span lang="en">container</span> })}
            </span>
            <span className="hidden truncate @lg:block">{i18n.t('Namespace')}</span>
            <span className="truncate text-right">{valueLabel(resource, stat)}</span>
          </div>
          <ol>
            {shown.rows.map((row) => (
              <RankingRow
                key={row.key}
                row={row}
                top={top}
                format={format}
                active={active === workloadKey(row.rec)}
                onOpen={() => onOpen(row.rec)}
              />
            ))}
          </ol>
        </>
      )}
      <div className="border-border/60 text-fg-dim flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-1.5 text-[11px]">
        <span className="min-w-0 flex-1">
          {i18n.plural(
            'Usage data available for {available} of {count} container.',
            'Usage data available for {available} of {count} containers.',
            ranking.total,
            { available: i18n.number(ranking.available) },
          )}
        </span>
        {shown.pages > 1 && (
          <span className="ml-auto flex items-center gap-1 tabular-nums">
            <span>
              {i18n.t('{from}–{to} of {count}', {
                from: i18n.number(shown.from),
                to: i18n.number(shown.to),
                count: i18n.number(matched.length),
              })}
            </span>
            <IconButton
              size="xs"
              label={i18n.t('Previous page')}
              icon={<ChevronLeft />}
              disabled={shown.page === 0}
              onClick={() => setPage(shown.page - 1)}
            />
            <IconButton
              size="xs"
              label={i18n.t('Next page')}
              icon={<ChevronRight />}
              disabled={shown.page >= shown.pages - 1}
              onClick={() => setPage(shown.page + 1)}
            />
          </span>
        )}
      </div>
    </Card>
  );
}
