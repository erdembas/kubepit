import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import { ArrowDownWideNarrow, Search, X, Zap } from 'lucide-react';
import { Checkbox } from '@/components/ui/Choice';
import { IconButton } from '@/components/ui/IconButton';
import { Select } from '@/components/ui/Select';
import { cn } from '@/lib/cn';
import {
  REC_SORTS,
  RECOMMENDATION_LENSES,
  applyMode,
  lensLabel,
  sortLabel,
  verdictFilterLabel,
  workloadKey,
  type ApplyMode,
} from '@/lib/kube/recommendations/model';
import { useAppStore } from '@/store/useAppStore';
import { useRecommendationsStore } from '@/store/useRecommendationsStore';
import { VIEW, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type {
  ClusterDef,
  ClusterId,
  RecommendationLens,
  RightsizingReport,
  WorkloadRecommendation,
} from '@/types';
import { RightsizingDialog } from '../cost/RightsizingDialog';
import { Card } from '../overview/charts';
import { useEvent } from '../util';
import { ExportFormatMenu, useClusterName } from './ExportMenu';
import { RecommendationRow, ROW_GRID } from './RecommendationRow';
import { exportRecommendations, workloadRefs } from './exportRecommendations';
import { VERDICT_FILTERS, listRows, pruneSelection, toggleAll, toggleSelection } from './listModel';
import type { SectionProps } from './sectionProps';
import { updateRecommendationsView, useRecommendationsView } from './viewState';

/** Rows rendered at first, and added per "Show more": rows vary in height, so the list pages instead of windowing. */
const PAGE = 100;
const STEP = 200;

const NO_KEYS: ReadonlySet<string> = new Set();
const NO_APPLIED: Record<string, number> = {};
/** Until the cluster is known, nothing is one-click. */
const UNKNOWN_CLUSTER: Pick<ClusterDef, 'read_only' | 'environment'> = {
  read_only: false,
  environment: 'production',
};

export interface RecommendationListProps {
  clusterId: ClusterId;
  report: RightsizingReport;
  /** The rows in scope (`SectionProps.rows`). */
  rows: WorkloadRecommendation[];
  /** The picked past run (null = the latest), for exports. */
  runId: number | null;
  /** A past run is shown: nothing is applied from it. */
  readOnlyRun: boolean;
  connected: boolean;
  /**
   * Checked rows (`workloadKey`s). The selection bar's actions reach the
   * checked rows the tab, lenses and search still show.
   */
  selected: ReadonlySet<string>;
  onSelect: (next: ReadonlySet<string>) => void;
  /** Opens a row in the drawer (`workloadKey`). */
  onOpen: (key: string) => void;
  /** "Apply" of a `one-click` row. */
  onApply: (rec: WorkloadRecommendation) => void;
  /** "Review & apply" (`review`) or "Review" (`read-only`): the review dialog. */
  onReview: (rec: WorkloadRecommendation) => void;
  /** "Apply {n} high-confidence" for the checked `one-click` rows; the action shows only when set. */
  onBatchApply?: (recs: WorkloadRecommendation[]) => void;
}

/** Verdict tabs with their counts (search applied). */
function VerdictTabs({
  counts,
  value,
  onChange,
}: {
  counts: Record<(typeof VERDICT_FILTERS)[number], number>;
  value: (typeof VERDICT_FILTERS)[number];
  onChange: (next: (typeof VERDICT_FILTERS)[number]) => void;
}) {
  i18n.useLocale();
  return (
    <div
      role="group"
      aria-label={i18n.t('Filter by verdict')}
      className="bg-fg/4 inline-flex max-w-full flex-wrap gap-0.5 rounded-lg p-0.5"
    >
      {VERDICT_FILTERS.map((f) => (
        <button
          key={f}
          type="button"
          aria-pressed={value === f}
          onClick={() => onChange(f)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11.5px] transition',
            value === f ? 'bg-surface-overlay text-fg font-medium' : 'text-fg-muted hover:text-fg',
          )}
        >
          {verdictFilterLabel(f)}
          <span className="text-fg-dim text-[10.5px] font-normal tabular-nums">
            {i18n.number(counts[f])}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Lens chips: each narrows the rows shown further (every picked lens applies). */
function LensChips({
  counts,
  picked,
  onToggle,
}: {
  counts: Record<RecommendationLens, number>;
  picked: readonly RecommendationLens[];
  onToggle: (lens: RecommendationLens) => void;
}) {
  i18n.useLocale();
  return (
    <div role="group" aria-label={i18n.t('Narrow the list')} className="flex flex-wrap gap-1.5">
      {RECOMMENDATION_LENSES.map((lens) => {
        const on = picked.includes(lens);
        const count = counts[lens] ?? 0;
        return (
          <button
            key={lens}
            type="button"
            aria-pressed={on}
            disabled={!on && count === 0}
            onClick={() => onToggle(lens)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] transition disabled:cursor-default disabled:opacity-40',
              on
                ? 'bg-accent/12 text-accent font-medium'
                : 'bg-fg/5 text-fg-muted enabled:hover:bg-fg/8 enabled:hover:text-fg',
            )}
          >
            {lensLabel(lens)}
            <span className="text-[10.5px] tabular-nums opacity-80">{i18n.number(count)}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The recommendation list (spec §9.1, 5): verdict tabs and lens chips with
 * counts, the view's search, a sort, checkbox selection (select-all covers
 * every row shown, not only the rendered ones) with a selection bar that
 * exports the checked rows, and one `RecommendationRow` per workload. Tab,
 * lenses and sort are `useRecommendationsView` state, the search is the
 * view's workbench filter. Long lists render in pages.
 */
export function RecommendationList({
  clusterId,
  report,
  rows,
  runId,
  readOnlyRun,
  connected,
  selected,
  onSelect,
  onOpen,
  onApply,
  onReview,
  onBatchApply,
}: RecommendationListProps) {
  i18n.useLocale();
  const [view, updateView] = useRecommendationsView(clusterId);
  const filterKey = `${clusterId}|${VIEW.recommendations}`;
  const query = useWorkbenchStore((s) => s.filters[filterKey] ?? '');
  const setQuery = (text: string) =>
    useWorkbenchStore.getState().setFilter(clusterId, VIEW.recommendations, text);
  // Typing stays responsive on large lists: the rows follow a beat later.
  const deferredQuery = useDeferredValue(query);
  const cluster = useAppStore((s) => s.clusters.find((c) => c.id === clusterId));
  const clusterName = useClusterName(clusterId);
  const applied = useRecommendationsStore((s) => s.byCluster[clusterId]?.applied ?? NO_APPLIED);

  const { tabs, lenses, shown } = useMemo(
    () => listRows(rows, view, deferredQuery),
    // `view` also holds the namespace and the open row, which do not change the rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, view.filter, view.lenses, view.sort, deferredQuery],
  );
  const keys = useMemo(() => shown.map(workloadKey), [shown]);
  const targets = useMemo(
    () => (selected.size ? shown.filter((_, i) => selected.has(keys[i]!)) : []),
    [selected, shown, keys],
  );
  const modeOf = useCallback(
    (rec: WorkloadRecommendation): ApplyMode => applyMode(rec, cluster ?? UNKNOWN_CLUSTER),
    [cluster],
  );
  const oneClick = useMemo(
    () => targets.filter((rec) => modeOf(rec) === 'one-click'),
    [targets, modeOf],
  );

  // Paging: back to the first page when the rows change; the open row is always rendered.
  const pageKey = `${view.filter}|${view.lenses.join(',')}|${view.sort}|${deferredQuery}|${rows.length}`;
  const [paging, setPaging] = useState({ key: pageKey, limit: PAGE });
  const openIndex = view.open ? keys.indexOf(view.open) : -1;
  const limit = Math.max(paging.key === pageKey ? paging.limit : PAGE, openIndex + 1);
  const rendered = shown.length > limit ? shown.slice(0, limit) : shown;
  const hidden = shown.length - rendered.length;

  // Stable handlers keep the memoized rows from re-rendering.
  const anchor = useRef<string | null>(null);
  const onToggle = useEvent((key: string, shift: boolean) => {
    onSelect(toggleSelection(selected, keys, key, anchor.current, shift));
    anchor.current = key;
  });
  const onToggleAll = () => onSelect(toggleAll(selected, keys));
  const open = useEvent(onOpen);
  const apply = useEvent(onApply);
  const review = useEvent(onReview);

  const allChecked = keys.length > 0 && targets.length === keys.length;
  const filtered = view.lenses.length > 0 || !!query.trim();
  const sortOptions = useMemo(() => REC_SORTS.map((s) => ({ value: s, label: sortLabel(s) })), []);

  return (
    <div className="@container min-w-0">
      <Card
        title={i18n.t('Recommendations')}
        actions={
          <span className="text-fg-dim text-[11px] tabular-nums">
            {i18n.plural('{count} workload', '{count} workloads', shown.length)}
          </span>
        }
      >
        <div className="border-border/60 space-y-2 border-b px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <VerdictTabs
              counts={tabs}
              value={view.filter}
              onChange={(filter) => updateView({ filter })}
            />
            <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2">
              <div className="bg-surface border-border focus-within:border-accent/50 flex h-7 w-52 min-w-24 shrink items-center gap-2 rounded-lg border px-2 transition-colors">
                <Search className="text-fg-dim h-3.5 w-3.5 shrink-0" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
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
              <Select
                value={view.sort}
                onChange={(sort) => updateView({ sort })}
                options={sortOptions}
                ariaLabel={i18n.t('Sort by')}
                leading={<ArrowDownWideNarrow className="text-fg-dim h-3 w-3 shrink-0" />}
                className="shrink-0"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <LensChips
              counts={lenses}
              picked={view.lenses}
              onToggle={(lens) =>
                updateView({
                  lenses: view.lenses.includes(lens)
                    ? view.lenses.filter((l) => l !== lens)
                    : [...view.lenses, lens],
                })
              }
            />
            {filtered && (
              <button
                type="button"
                onClick={() => {
                  updateView({ lenses: [] });
                  setQuery('');
                }}
                className="text-fg-dim hover:text-fg text-[11px]"
              >
                {i18n.t('Clear filters')}
              </button>
            )}
          </div>
        </div>
        {!shown.length ? (
          <p className="text-fg-dim px-4 py-10 text-center text-[12px]">
            {!rows.length
              ? i18n.t('No right-sizable workloads in scope.')
              : view.filter === 'changed' && !filtered
                ? i18n.t('Every workload is sized well for its usage.')
                : i18n.t('No workloads match the filters.')}
          </p>
        ) : (
          <>
            <div
              className={cn(
                ROW_GRID,
                'border-border/60 text-fg-dim items-center border-b px-4 py-1.5 text-[10.5px] font-semibold tracking-[0.08em] uppercase',
              )}
            >
              <Checkbox
                checked={allChecked}
                onChange={onToggleAll}
                aria-label={i18n.t('Select all')}
                className="mt-0"
              />
              <span className="truncate">{i18n.t('Workload')}</span>
              <span className="hidden truncate @3xl:block">{i18n.t('Requests')}</span>
              <span className="hidden truncate text-right @3xl:block">
                {i18n.t('Monthly change')}
              </span>
            </div>
            <ul aria-label={i18n.t('Recommendations')}>
              {rendered.map((rec) => {
                const key = workloadKey(rec);
                return (
                  <RecommendationRow
                    key={key}
                    rec={rec}
                    rowKey={key}
                    mode={modeOf(rec)}
                    currency={report.currency}
                    active={key === view.open}
                    selected={selected.has(key)}
                    applied={key in applied}
                    actions={!readOnlyRun}
                    connected={connected}
                    onToggle={onToggle}
                    onOpen={open}
                    onApply={apply}
                    onReview={review}
                  />
                );
              })}
            </ul>
            {hidden > 0 && (
              <div className="border-border/40 border-t px-4 py-2">
                <button
                  type="button"
                  onClick={() => setPaging({ key: pageKey, limit: limit + STEP })}
                  className="text-accent text-[11.5px] hover:underline"
                >
                  {i18n.t('Show {count} more', { count: i18n.number(Math.min(hidden, STEP)) })}
                </button>
              </div>
            )}
          </>
        )}
      </Card>
      {targets.length > 0 && (
        <div className="@container pointer-events-none sticky bottom-3 z-20 mt-2 flex justify-center">
          <div
            role="toolbar"
            aria-label={i18n.t('Selection actions')}
            className="border-border bg-surface-overlay animate-fade-in pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-xl border p-1 shadow-[0_16px_48px_-12px_rgb(0_0_0/0.5)]"
          >
            <span className="bg-accent/10 text-accent flex h-7 shrink-0 items-center rounded-lg px-2.5 text-[12px] font-medium tabular-nums">
              {i18n.t('{count} selected', { count: targets.length })}
            </span>
            {targets.length < keys.length && (
              <button
                type="button"
                onClick={() => onSelect(new Set([...selected, ...keys]))}
                className="text-fg-dim hover:bg-fg/8 hover:text-fg hidden h-7 shrink-0 rounded-lg px-2 text-[12px] tabular-nums transition-colors @lg:block"
              >
                {i18n.t('Select all {count}', { count: keys.length })}
              </button>
            )}
            <span className="bg-border mx-1 h-5 w-px shrink-0" aria-hidden />
            {onBatchApply && !readOnlyRun && (
              <button
                type="button"
                disabled={!oneClick.length || !connected}
                title={
                  !connected
                    ? i18n.t('Connect to the cluster to apply.')
                    : i18n.t('Checked rows with a high-confidence change and no raised limit')
                }
                onClick={() => onBatchApply(oneClick)}
                className="text-fg-muted enabled:hover:bg-fg/8 enabled:hover:text-fg flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Zap className="text-accent h-3.5 w-3.5 shrink-0" />
                {i18n.t('Apply {count} high-confidence', { count: oneClick.length })}
              </button>
            )}
            <ExportFormatMenu
              variant="bar"
              label={i18n.t('Export selected')}
              onPick={(format) =>
                exportRecommendations(clusterId, runId, workloadRefs(targets), format, clusterName)
              }
            />
            <span className="bg-border mx-1 h-5 w-px shrink-0" aria-hidden />
            <IconButton
              size="sm"
              label={i18n.t('Clear selection')}
              icon={<X />}
              onClick={() => onSelect(NO_KEYS)}
              className="shrink-0 rounded-lg"
            />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Body section 3 (spec §9.1): the `RecommendationList` over `rows`, the
 * checkbox selection (kept while the scan keeps the rows) and the review
 * dialog. Opening a row sets the view's `open`, which the drawer beside it
 * shows. Every apply goes through the audited `RightsizingDialog` (dry run,
 * read-only refusal, typed confirmation on production); Task 26 plugs
 * one-click (`quickApply`) into `onApply` and the batch dialog into
 * `onBatchApply` here.
 */
export function ListSection({ clusterId, report, rows, runId, past, connected }: SectionProps) {
  i18n.useLocale();
  const [selected, setSelected] = useState<ReadonlySet<string>>(NO_KEYS);
  const [reviewing, setReviewing] = useState<WorkloadRecommendation | null>(null);

  // Checks of rows gone from the scope (another namespace, a new scan) are dropped.
  useEffect(() => {
    setSelected((prev) => pruneSelection(prev, new Set(rows.map(workloadKey))));
  }, [rows]);

  const onOpen = useCallback(
    (key: string) => updateRecommendationsView(clusterId, { open: key }),
    [clusterId],
  );
  const onReview = useCallback((rec: WorkloadRecommendation) => setReviewing(rec), []);

  return (
    <>
      <RecommendationList
        clusterId={clusterId}
        report={report}
        rows={rows}
        runId={runId}
        readOnlyRun={past}
        connected={connected}
        selected={selected}
        onSelect={setSelected}
        onOpen={onOpen}
        onApply={onReview}
        onReview={onReview}
      />
      {reviewing && (
        <RightsizingDialog
          clusterId={clusterId}
          rec={reviewing}
          currency={report.currency}
          onApplied={() =>
            useRecommendationsStore.getState().markApplied(clusterId, workloadKey(reviewing))
          }
          onClose={() => setReviewing(null)}
        />
      )}
    </>
  );
}
