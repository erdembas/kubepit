import * as i18n from '@/i18n';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Hourglass,
  Loader2,
  Lock,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Checkbox } from '@/components/ui/Choice';
import { ClusterAvatar } from '@/components/workbench/ClusterAvatar';
import { clusterColor } from '@/lib/clusterMeta';
import { cn } from '@/lib/cn';
import { deprecatedApi, deprecationMessage } from '@/lib/kube/deprecations';
import { useAppStore } from '@/store/useAppStore';
import type { ClusterDef } from '@/types';
import { DiffView } from '../../common/DiffView';
import { MonacoView } from '../../common/MonacoView';
import { BADGE_TONE, badgeLabel, filterLabel } from './labels';
import {
  BADGES,
  cellSides,
  countCells,
  countDocs,
  defaultSelection,
  doneCells,
  groupBySource,
  matchesFilter,
  planApply,
  type ApplyCell,
  type ApplyPlan,
  type Cell,
  type Filter,
  type ReviewDoc,
  type ReviewTarget,
} from './model';
import type { FleetReview } from './useFleetReview';

// -- Selection & apply plan ---------------------------------------------------

export interface ReviewControls {
  selected: Set<string>;
  included: Set<string>;
  toggleDoc: (id: string) => void;
  setSelected: (ids: Set<string>) => void;
  toggleTarget: (key: string) => void;
  cells: Record<string, Cell[]>;
  plan: ApplyPlan;
  /** A dry run is still running on some target. */
  running: boolean;
  /** An apply is running on some target. */
  applying: boolean;
}

/**
 * Which documents and targets an apply covers. Every new review starts
 * with all writable targets included; the selection defaults to the
 * documents that change somewhere and fail nowhere, until the user edits it.
 */
export function useReviewControls(review: FleetReview | null): ReviewControls {
  const [selected, setSelectedState] = useState<Set<string>>(() => new Set());
  const [included, setIncluded] = useState<Set<string>>(() => new Set());
  const touched = useRef(false);
  const startedAt = review?.startedAt;

  useEffect(() => {
    touched.current = false;
    setSelectedState(new Set());
    setIncluded(new Set(review?.targets.filter((t) => !t.readOnly).map((t) => t.key) ?? []));
    // A new review (startedAt) resets both.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startedAt]);

  const cells = useMemo(() => (review ? doneCells(review.runs) : {}), [review]);
  useEffect(() => {
    if (review && !touched.current) setSelectedState(defaultSelection(review.docs, cells));
    // Recomputed as targets finish, until the user takes over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells]);

  const setSelected = useCallback((ids: Set<string>) => {
    touched.current = true;
    setSelectedState(ids);
  }, []);
  const toggleDoc = useCallback((id: string) => {
    touched.current = true;
    setSelectedState((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const toggleTarget = useCallback((key: string) => {
    setIncluded((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const plan = useMemo(
    () =>
      review
        ? planApply(review.docs, review.targets, review.runs, selected, included)
        : { targets: [], changes: 0, errors: 0, unchecked: 0 },
    [review, selected, included],
  );
  const running = !!review && Object.values(review.runs).some((r) => r.status === 'running');
  const applying = !!review && Object.values(review.applies).some((a) => a.status === 'running');
  return {
    selected,
    included,
    toggleDoc,
    setSelected,
    toggleTarget,
    cells,
    plan,
    running,
    applying,
  };
}

// -- Matrix + detail ----------------------------------------------------------

interface Focus {
  index: number;
  target: string | null;
}

const COLUMN = 104;
const NO_CELLS: Record<string, Cell[]> = {};

/**
 * The review matrix (documents × targets) with filters and selection, and
 * the detail of the focused cell: its diff, the server's error, or the
 * local manifest before any dry run.
 */
export function FleetReviewPane({
  docs,
  targets,
  review,
  controls,
  groupSources,
  stale,
}: {
  /** Rows: the review's documents, or the rendered ones before a dry run. */
  docs: ReviewDoc[];
  /** Columns: the review's targets, or the picked ones before a dry run. */
  targets: ReviewTarget[];
  review: FleetReview | null;
  controls: ReviewControls;
  /** Group rows under their source file. */
  groupSources: boolean;
  /** The documents changed since the dry run. */
  stale: boolean;
}) {
  i18n.useLocale();
  const clusters = useAppStore((s) => s.clusters);
  const clusterOf = useCallback(
    (id: string) => clusters.find((c) => c.id === id) ?? null,
    [clusters],
  );
  const [filter, setFilter] = useState<Filter>('all');
  const [focus, setFocus] = useState<Focus>({ index: 0, target: null });
  const reviewed = !!review;
  const cells = reviewed ? controls.cells : NO_CELLS;
  const { selected } = controls;

  const docCounts = useMemo(() => countDocs(docs.length, cells), [docs.length, cells]);
  const visible = useMemo(
    () => docs.map((_, i) => i).filter((i) => matchesFilter(i, filter, cells)),
    [docs, filter, cells],
  );
  const groups = useMemo(
    () => (groupSources ? groupBySource(visible, docs) : [{ source: '', indexes: visible }]),
    [groupSources, visible, docs],
  );

  // Keep the focus on a visible document; prefer an error, then a change.
  const reviewKey = review?.startedAt ?? 0;
  useEffect(() => {
    setFilter('all');
    setFocus({ index: 0, target: null });
  }, [reviewKey, docs.length]);
  useEffect(() => {
    if (!reviewed) return;
    setFocus((f) => {
      if (f.target && cells[f.target]) return f;
      for (const badge of ['error', 'create', 'update'] as const) {
        for (const t of targets) {
          const i = cells[t.key]?.findIndex((c) => c.badge === badge) ?? -1;
          if (i >= 0) return { index: i, target: t.key };
        }
      }
      const first = targets.find((t) => cells[t.key]);
      return first ? { index: f.index, target: first.key } : f;
    });
  }, [cells, reviewed, targets]);

  const selectable = docs.filter((_, i) =>
    Object.values(cells).some((c) => c[i]?.badge === 'create' || c[i]?.badge === 'update'),
  );
  const focusDoc = docs[focus.index] ?? docs[0];
  const focusTarget = targets.find((t) => t.key === focus.target) ?? null;
  const gridColumns = `28px minmax(200px, 1fr) repeat(${targets.length}, ${COLUMN}px)`;

  return (
    <div className="flex min-h-0 flex-1">
      <div
        className="border-border/60 flex max-w-[64%] min-w-[340px] shrink-0 flex-col border-r"
        style={{ width: 28 + 260 + targets.length * COLUMN }}
      >
        <div className="border-border/60 flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b px-2">
          {(['all', ...BADGES] as Filter[]).map((f) => {
            const count = f === 'all' ? docs.length : docCounts[f];
            const disabled = f !== 'all' && (!reviewed || count === 0);
            return (
              <button
                key={f}
                type="button"
                disabled={disabled}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  'flex h-5.5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors disabled:opacity-40',
                  filter === f ? 'bg-fg/8 text-fg font-medium' : 'text-fg-dim hover:text-fg',
                )}
              >
                {filterLabel(f)}
                <span
                  className={cn(
                    'tabular-nums',
                    f === 'error' && count > 0 ? 'text-status-error' : 'text-fg-dim',
                  )}
                >
                  {reviewed || f === 'all' ? count : '–'}
                </span>
              </button>
            );
          })}
          {reviewed && (
            <span className="text-fg-dim ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-[11px]">
              <span className="tabular-nums">
                {i18n.t('{count} selected', { count: selected.size })}
              </span>
              <button
                type="button"
                className="hover:text-fg"
                onClick={() => controls.setSelected(new Set(selectable.map((d) => d.id)))}
              >
                {i18n.t('All changes')}
              </button>
              <span aria-hidden>·</span>
              <button
                type="button"
                className="hover:text-fg"
                onClick={() => controls.setSelected(new Set())}
              >
                {i18n.t('None')}
              </button>
            </span>
          )}
        </div>
        <div className="overlay-scroll min-h-0 flex-1 overflow-auto">
          <div className="min-w-max" role="grid" aria-label={i18n.t('Objects per cluster')}>
            <div
              role="row"
              className="bg-surface border-border/60 sticky top-0 z-10 grid items-end gap-x-2 border-b px-2 py-1.5"
              style={{ gridTemplateColumns: gridColumns }}
            >
              <span />
              <span className="text-fg-dim text-[10.5px] font-semibold tracking-[0.08em] uppercase">
                {i18n.t('Object')}
              </span>
              {targets.map((t) => (
                <TargetHeader
                  key={t.key}
                  target={t}
                  cluster={clusterOf(t.clusterId)}
                  review={review}
                  cells={cells[t.key]}
                  included={controls.included.has(t.key)}
                  onToggle={() => controls.toggleTarget(t.key)}
                />
              ))}
            </div>
            {visible.length === 0 && (
              <p className="text-fg-dim px-3 py-6 text-center text-[12px]">
                {i18n.t('No objects match this filter.')}
              </p>
            )}
            {groups.map((group) => (
              <div key={group.source} role="rowgroup">
                {groupSources && (
                  <div
                    className="text-fg-muted flex items-center gap-1.5 px-2 pt-2 pb-0.5 font-mono text-[10.5px]"
                    title={group.source}
                  >
                    <FileText className="text-fg-dim h-3 w-3 shrink-0" />
                    <span className="truncate">{group.source}</span>
                    <span className="text-fg-dim tabular-nums">{group.indexes.length}</span>
                  </div>
                )}
                {group.indexes.map((index) => {
                  const doc = docs[index]!;
                  const focused = index === focus.index;
                  const changing = selectable.includes(doc);
                  return (
                    <div
                      key={doc.id}
                      role="row"
                      className={cn(
                        'grid min-h-7 items-center gap-x-2 rounded-md px-2 text-[12px]',
                        focused ? 'bg-fg/6' : 'hover:bg-fg/4',
                      )}
                      style={{ gridTemplateColumns: gridColumns }}
                    >
                      <span className="flex items-center">
                        {reviewed && (
                          <Checkbox
                            checked={selected.has(doc.id)}
                            disabled={!changing && !selected.has(doc.id)}
                            onChange={() => controls.toggleDoc(doc.id)}
                            aria-label={i18n.t('Apply {name}', { name: `${doc.kind}/${doc.name}` })}
                            className="mt-0"
                          />
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() => setFocus((f) => ({ index, target: f.target }))}
                        className="flex min-w-0 items-baseline gap-1.5 py-1 text-left"
                        title={`${doc.apiVersion} ${doc.kind} ${doc.namespace ? `${doc.namespace}/` : ''}${doc.name}\n${doc.source}${doc.line ? `:${doc.line}` : ''}`}
                      >
                        <span className="text-fg-dim shrink-0 text-[10.5px]">{doc.kind}</span>
                        <span className="text-fg min-w-0 truncate font-mono text-[11.5px]">
                          {doc.name || '—'}
                        </span>
                        <DeprecatedApiIcon apiVersion={doc.apiVersion} kind={doc.kind} />
                        {doc.namespace && (
                          <span className="text-fg-dim min-w-0 shrink truncate font-mono text-[10px]">
                            {doc.namespace}
                          </span>
                        )}
                      </button>
                      {targets.map((t) => (
                        <MatrixCell
                          key={t.key}
                          review={review}
                          target={t}
                          index={index}
                          cell={cells[t.key]?.[index]}
                          focused={focused && focus.target === t.key}
                          onFocus={() => setFocus({ index, target: t.key })}
                        />
                      ))}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {focusDoc ? (
          <Detail
            doc={focusDoc}
            target={focusTarget}
            cluster={focusTarget ? clusterOf(focusTarget.clusterId) : null}
            review={review}
            cell={focusTarget ? cells[focusTarget.key]?.[focus.index] : undefined}
            apply={focusTarget ? review?.applies[focusTarget.key]?.cells[focus.index] : undefined}
            stale={stale}
          />
        ) : (
          <div className="text-fg-dim flex flex-1 items-center justify-center text-[12px]">
            {i18n.t('No objects.')}
          </div>
        )}
      </div>
    </div>
  );
}

function TargetHeader({
  target,
  cluster,
  review,
  cells,
  included,
  onToggle,
}: {
  target: ReviewTarget;
  cluster: ClusterDef | null;
  review: FleetReview | null;
  cells: Cell[] | undefined;
  included: boolean;
  onToggle: () => void;
}) {
  i18n.useLocale();
  const run = review?.runs[target.key];
  const counts = cells ? countCells(cells) : null;
  const name = cluster?.name ?? target.clusterId;
  return (
    <div className="flex min-w-0 flex-col gap-0.5" role="columnheader">
      <span className="flex min-w-0 items-center gap-1">
        {cluster && (
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: clusterColor(cluster) }}
          />
        )}
        <span className="text-fg min-w-0 truncate text-[11px] font-medium" title={name}>
          {name}
        </span>
      </span>
      {target.namespace && (
        <span className="text-fg-dim truncate font-mono text-[10px]" title={target.namespace}>
          {target.namespace}
        </span>
      )}
      <span className="flex h-4 items-center gap-1 text-[10px] tabular-nums">
        {target.readOnly ? (
          <span
            className="text-fg-dim flex items-center gap-1"
            title={i18n.t('Read-only cluster: diffed, but excluded from apply')}
          >
            <Lock className="h-2.5 w-2.5" />
            {i18n.t('Diff only')}
          </span>
        ) : review ? (
          <label
            className="text-fg-dim hover:text-fg flex cursor-pointer items-center gap-1"
            title={i18n.t('Include this cluster when applying')}
          >
            <Checkbox
              checked={included}
              onChange={onToggle}
              aria-label={i18n.t('Apply to {cluster}', { cluster: name })}
              className="mt-0"
            />
            {i18n.t('Apply')}
          </label>
        ) : null}
        {run?.status === 'running' && <Loader2 className="text-accent h-3 w-3 animate-spin" />}
        {run?.status === 'error' && (
          <span className="text-status-error flex items-center gap-0.5" title={run.message}>
            <AlertTriangle className="h-3 w-3" />
            {i18n.t('Failed')}
          </span>
        )}
      </span>
      {counts && (
        <span className="flex gap-1.5 font-mono text-[10px] tabular-nums">
          <span className={counts.create ? 'text-status-running' : 'text-fg-dim'}>
            +{counts.create}
          </span>
          <span className={counts.update ? 'text-tone-info-fg' : 'text-fg-dim'}>
            ~{counts.update}
          </span>
          <span className={counts.error ? 'text-status-error' : 'text-fg-dim'}>
            !{counts.error}
          </span>
        </span>
      )}
    </div>
  );
}

function MatrixCell({
  review,
  target,
  index,
  cell,
  focused,
  onFocus,
}: {
  review: FleetReview | null;
  target: ReviewTarget;
  index: number;
  cell: Cell | undefined;
  focused: boolean;
  onFocus: () => void;
}) {
  i18n.useLocale();
  const run = review?.runs[target.key];
  const applied = review?.applies[target.key]?.cells[index];
  let body;
  if (!run) body = <span className="text-fg-dim">—</span>;
  else if (run.status === 'running')
    body = <Loader2 className="text-fg-dim h-3 w-3 animate-spin" />;
  else if (run.status === 'error') body = <span className="text-fg-dim">—</span>;
  else if (applied) body = <ApplyBadge cell={applied} />;
  else if (cell)
    body = (
      <Badge
        tone={BADGE_TONE[cell.badge]}
        icon={cell.pending ? <Hourglass className="h-2.5 w-2.5" /> : undefined}
        className="max-w-full"
      >
        {badgeLabel(cell.badge)}
      </Badge>
    );
  return (
    <button
      type="button"
      role="gridcell"
      onClick={onFocus}
      disabled={!run || run.status !== 'done'}
      className={cn(
        'flex h-6 min-w-0 items-center rounded-md px-1 text-left transition',
        run?.status === 'done' && 'hover:bg-fg/6',
        focused && 'bg-accent/8',
      )}
    >
      {body}
    </button>
  );
}

function ApplyBadge({ cell }: { cell: ApplyCell }) {
  i18n.useLocale();
  if (cell.status === 'running')
    return (
      <span className="text-fg-muted flex items-center gap-1 text-[10.5px]">
        <Loader2 className="text-accent h-3 w-3 animate-spin" />
        {i18n.t('Applying…')}
      </span>
    );
  if (cell.status === 'ok')
    return (
      <Badge tone="success" variant="solid" icon={<CheckCircle2 className="h-2.5 w-2.5" />}>
        {i18n.t('Applied')}
      </Badge>
    );
  return (
    <Badge tone="critical" variant="solid" icon={<XCircle className="h-2.5 w-2.5" />}>
      {i18n.t('Failed')}
    </Badge>
  );
}

function Detail({
  doc,
  target,
  cluster,
  review,
  cell,
  apply,
  stale,
}: {
  doc: ReviewDoc;
  target: ReviewTarget | null;
  cluster: ClusterDef | null;
  review: FleetReview | null;
  cell: Cell | undefined;
  apply: ApplyCell | undefined;
  stale: boolean;
}) {
  i18n.useLocale();
  const run = target ? review?.runs[target.key] : undefined;
  const sides = useMemo(
    () => (cell && !cell.result.error ? cellSides(doc, cell) : null),
    [doc, cell],
  );
  const pendingSides = useMemo(() => (cell?.pending ? cellSides(doc, cell) : null), [doc, cell]);
  const label = `${doc.kind}/${doc.name || '?'}`;
  const clusterName = cluster?.name ?? target?.clusterId ?? '';

  let content;
  if (!review || !target || !run) {
    content = (
      <>
        <DetailNote>
          {i18n.t('Local manifest. Run the diff to compare it with the selected clusters.')}
        </DetailNote>
        <MonacoView value={doc.yaml} />
      </>
    );
  } else if (run.status === 'running') {
    content = (
      <div className="text-fg-dim flex flex-1 items-center justify-center gap-2 text-[12px]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {i18n.t('Running a server-side dry run on {cluster}…', { cluster: clusterName })}
      </div>
    );
  } else if (run.status === 'error') {
    content = (
      <ErrorBox title={i18n.t('The dry run failed on {cluster}', { cluster: clusterName })}>
        {run.message}
      </ErrorBox>
    );
  } else if (!cell) {
    content = null;
  } else if (cell.pending && pendingSides) {
    content = (
      <>
        <DetailNote tone="info">
          {cell.pending === 'namespace'
            ? i18n.t(
                'Its namespace is created by this set first, so the server could not check it yet. Showing the manifest as it will be sent.',
              )
            : i18n.t(
                'Its CustomResourceDefinition is created by this set first, so the server could not check it yet. Showing the manifest as it will be sent.',
              )}
        </DetailNote>
        <DiffView
          original={pendingSides.original}
          modified={pendingSides.modified}
          originalLabel={i18n.t('Not in the cluster')}
          modifiedLabel={i18n.t('Manifest')}
        />
      </>
    );
  } else if (cell.result.error) {
    content = (
      <ErrorBox
        title={i18n.t('{name} was rejected by {cluster}', { name: label, cluster: clusterName })}
      >
        {cell.result.error}
      </ErrorBox>
    );
  } else if (sides) {
    content = (
      <DiffView
        original={sides.original}
        modified={sides.modified}
        originalLabel={
          cell.result.live
            ? i18n.t('Live on {cluster}', { cluster: clusterName })
            : i18n.t('Not in the cluster')
        }
        modifiedLabel={i18n.t('After apply')}
        identicalHint={i18n.t('The server would leave this object unchanged.')}
      />
    );
  }

  return (
    <>
      <div className="border-border/60 flex h-8 shrink-0 items-center gap-2 border-b px-3 text-[11.5px]">
        <span className="text-fg-dim shrink-0">{doc.kind}</span>
        <span className="text-fg min-w-0 truncate font-mono">
          {doc.namespace ? `${doc.namespace}/` : ''}
          {doc.name || '—'}
        </span>
        <span className="text-fg-dim min-w-0 truncate font-mono text-[10.5px]" title={doc.source}>
          {doc.source}
          {doc.line ? `:${doc.line}` : ''}
        </span>
        {cluster && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <ClusterAvatar cluster={cluster} />
            <span className="text-fg-muted max-w-40 truncate">{cluster.name}</span>
          </span>
        )}
      </div>
      <DeprecatedApiNote apiVersion={doc.apiVersion} kind={doc.kind} />
      {stale && review && (
        <DetailNote tone="warning">
          {i18n.t('The manifests changed after this diff. Run the diff again before applying.')}
        </DetailNote>
      )}
      {apply?.status === 'error' && (
        <DetailNote tone="error">
          {i18n.t('Apply failed: {message}', { message: apply.message })}
        </DetailNote>
      )}
      {apply?.status === 'ok' && (
        <DetailNote tone="success">
          {i18n.t('Applied to {cluster}. Run the diff again to see the new state.', {
            cluster: clusterName,
          })}
        </DetailNote>
      )}
      {content}
    </>
  );
}

/** Documents whose apiVersion is deprecated or removed (`lib/kube/deprecations.ts`). */
function DeprecatedApiIcon({ apiVersion, kind }: { apiVersion: string; kind: string }) {
  const entry = deprecatedApi(apiVersion, kind);
  if (!entry) return null;
  const message = deprecationMessage(entry);
  return (
    <span className="self-center" title={message}>
      <AlertTriangle className="text-tone-warning-fg h-3 w-3 shrink-0" aria-label={message} />
    </span>
  );
}

function DeprecatedApiNote({ apiVersion, kind }: { apiVersion: string; kind: string }) {
  const entry = deprecatedApi(apiVersion, kind);
  if (!entry) return null;
  return <DetailNote tone="warning">{deprecationMessage(entry)}</DetailNote>;
}

function DetailNote({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'info' | 'warning' | 'error' | 'success';
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'shrink-0 border-b px-3 py-1.5 text-[11.5px] break-words',
        tone === 'neutral' && 'border-border/60 text-fg-dim',
        tone === 'info' && 'border-tone-info/25 bg-tone-info/6 text-tone-info-fg',
        tone === 'warning' && 'border-tone-warning/30 bg-tone-warning/8 text-tone-warning-fg',
        tone === 'error' && 'border-tone-critical/30 bg-tone-critical/5 text-tone-critical-fg',
        tone === 'success' && 'border-tone-success/25 bg-tone-success/6 text-tone-success-fg',
      )}
    >
      {children}
    </div>
  );
}

function ErrorBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="overlay-scroll flex min-h-0 flex-1 flex-col overflow-auto p-3">
      <div className="border-tone-critical/30 bg-tone-critical/5 text-tone-critical-fg rounded-app-sm border px-3 py-2">
        <p className="mb-1 flex items-center gap-1.5 text-[12px] font-medium">
          <XCircle className="h-3.5 w-3.5 shrink-0" />
          {title}
        </p>
        <p className="font-mono text-[11.5px] break-words whitespace-pre-wrap">{children}</p>
      </div>
    </div>
  );
}
