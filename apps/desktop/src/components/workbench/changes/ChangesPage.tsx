import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState } from 'react';
import {
  Anchor,
  CircleSlash,
  FileDiff,
  History,
  Loader2,
  RefreshCw,
  Rocket,
  Search,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Switch } from '@/components/ui/Switch';
import { cn } from '@/lib/cn';
import { resolveRef } from '@/lib/kube/catalog';
import { journaledOrder } from '@/lib/kube/changes/kinds';
import {
  bucketize,
  changeItems,
  countBySource,
  helmItems,
  historyChangeItems,
  HISTORY_RANGES,
  isHistoryItem,
  kindFacets,
  LIVE_RANGES,
  mergeTimeline,
  rolloutItems,
  TIME_RANGES,
  TIMELINE_SOURCES,
  warningItems,
  type TimelineItem,
  type TimelineSource,
  type TimelineWindow,
  type TimeRange,
} from '@/lib/kube/changes/timeline';
import { navigateTo, useWorkbenchStore, VIEW } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo, ChangeJournalStatus } from '@/types';
import { openRolloutHistory } from '../details/detailsTabs';
import { useNow } from '../util';
import { ChangesHeader } from './ChangesHeader';
import { ChangeRow, HelmRow, RolloutRow, WarningRow } from './TimelineRows';
import {
  useDebounced,
  useHelmReleases,
  useJournal,
  useRecordingToggle,
  useReplicaSets,
  useWarningEvents,
} from './useChanges';
import {
  journalCoverageStart,
  mergeEvents,
  useHistoryChanges,
  useHistoryWarnings,
  usePersistedHistory,
} from './useHistory';

const PAGE = 300;
const MAX_LIMIT = 1000;

const SOURCE_ICON: Record<TimelineSource, LucideIcon> = {
  changes: FileDiff,
  warnings: TriangleAlert,
  helm: Anchor,
  rollouts: Rocket,
};

function sourceLabel(source: TimelineSource) {
  switch (source) {
    case 'changes':
      return i18n.t('Changes');
    case 'warnings':
      return i18n.t('Warnings');
    case 'helm':
      return i18n.t('Helm');
    default:
      return i18n.t('Rollouts');
  }
}

function rangeLabel(range: TimeRange) {
  switch (range) {
    case '15m':
      return i18n.t('{minutes}m', { minutes: 15 });
    case '1h':
      return i18n.t('{hours}h', { hours: 1 });
    case '6h':
      return i18n.t('{hours}h', { hours: 6 });
    case '7d':
      return i18n.t('{days}d', { days: 7 });
    case '30d':
      return i18n.t('{days}d', { days: 30 });
    default:
      return i18n.t('{hours}h', { hours: 24 });
  }
}

function rangeTitle(range: TimeRange) {
  if (range === '7d' || range === '30d')
    return i18n.t('Last {count} days (from the history on this machine)', {
      count: TIME_RANGES[range] / 86_400_000,
    });
  return range === '15m'
    ? i18n.t('Last {minutes} minutes', { minutes: 15 })
    : i18n.plural('Last hour', 'Last {count} hours', TIME_RANGES[range] / 3_600_000);
}

/**
 * "What changed in the last hour?": the cluster's change journal as a
 * timeline, interleaved with Warning events, Helm revisions and Deployment
 * rollouts. Entries expand to a before/after diff; objects open in the
 * details panel on their Changes tab.
 */
export function ChangesPage({
  clusterId,
  namespaces,
  isActive,
  apiResources,
}: {
  clusterId: string;
  namespaces: string[];
  isActive: boolean;
  apiResources: ApiResourceInfo[] | null;
}) {
  i18n.useLocale();
  const [range, setRange] = useState<TimeRange>('1h');
  const [text, setText] = useState('');
  const query = useDebounced(text.trim(), 250);
  const [kinds, setKinds] = useState<string[]>([]);
  const [hidden, setHidden] = useState<TimelineSource[]>([]);
  const [limit, setLimit] = useState(PAGE);
  const [expanded, setExpanded] = useState<string | null>(null);
  const now = useNow(15_000, isActive);
  const persisted = usePersistedHistory(clusterId);
  const rangeMs = TIME_RANGES[persisted || !HISTORY_RANGES.includes(range) ? range : '24h'];
  const shows = (source: TimelineSource) => !hidden.includes(source);

  const journal = useJournal(
    clusterId,
    { namespaces, kinds: [], name: null, text: query || null, limit },
    rangeMs,
    isActive,
  );
  const warnings = useWarningEvents(clusterId, namespaces, isActive && shows('warnings'));
  const helm = useHelmReleases(clusterId, namespaces, isActive && shows('helm'));
  const replicaSets = useReplicaSets(clusterId, namespaces, isActive && shows('rollouts'));
  const status = journal.data?.status;
  const entries = useMemo(() => journal.data?.entries ?? [], [journal.data]);
  // Persistent history: entries older than the live journal and expired warnings.
  const older = useHistoryChanges(
    clusterId,
    { namespaces, kinds: [], name: null, text: query || null, limit },
    rangeMs,
    journalCoverageStart(status),
    isActive && persisted && !!journal.data,
  );
  const olderWarnings = useHistoryWarnings(
    clusterId,
    namespaces,
    rangeMs,
    isActive && persisted && shows('warnings'),
  );
  const olderEntries = useMemo(() => older.data?.entries ?? [], [older.data]);

  const scope: TimelineWindow = useMemo(
    () => ({
      since: now - rangeMs,
      // Tolerate a clock slightly behind the API server's.
      until: now + 60_000,
      namespaces,
      text: query.toLowerCase(),
      kinds,
    }),
    [now, rangeMs, namespaces, query, kinds],
  );
  const bySource = useMemo(
    (): Record<TimelineSource, TimelineItem[]> => ({
      changes: [...changeItems(entries, scope), ...historyChangeItems(olderEntries, scope)],
      warnings: warningItems(
        mergeEvents(warnings.data ?? [], olderWarnings.data?.events ?? []),
        scope,
      ),
      helm: helmItems(helm.data ?? [], scope),
      rollouts: rolloutItems(replicaSets.data ?? [], scope),
    }),
    [entries, olderEntries, scope, warnings.data, olderWarnings.data, helm.data, replicaSets.data],
  );
  const counts = countBySource(TIMELINE_SOURCES.flatMap((s) => bySource[s]));
  const items = useMemo(
    () => mergeTimeline(...TIMELINE_SOURCES.filter(shows).map((s) => bySource[s])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bySource, hidden],
  );
  const buckets = useMemo(() => bucketize(items, now), [items, now]);
  const facets = useMemo(
    () =>
      kindFacets([...entries, ...olderEntries]).sort(
        (a, b) => b[1] - a[1] || journaledOrder(a[0]) - journaledOrder(b[0]),
      ),
    [entries, olderEntries],
  );
  const filtered = !!query || kinds.length > 0 || hidden.length > 0;
  const clear = () => {
    setText('');
    setKinds([]);
    setHidden([]);
  };
  const toggleKind = (kind: string) =>
    setKinds((k) => (k.includes(kind) ? k.filter((x) => x !== kind) : [...k, kind]));
  const toggleSource = (source: TimelineSource) =>
    setHidden((h) => (h.includes(source) ? h.filter((x) => x !== source) : [...h, source]));
  const refresh = () => {
    void journal.refresh();
    if (persisted) void older.refresh();
    if (shows('warnings')) void warnings.refresh();
    if (shows('helm')) void helm.refresh();
    if (shows('rollouts')) void replicaSets.refresh();
  };
  const truncatedPage = journal.data?.next_cursor != null || older.data?.next_cursor != null;

  const openWarning = (item: Extract<TimelineItem, { type: 'warning' }>) => {
    const gvk = resolveRef(item.object.apiVersion || undefined, item.object.kind, apiResources);
    return gvk ? () => navigateTo(clusterId, gvk, item.object.namespace, item.object.name) : null;
  };
  const openHelm = (item: Extract<TimelineItem, { type: 'helm' }>) => {
    const store = useWorkbenchStore.getState();
    store.setActiveKind(clusterId, VIEW.helmReleases);
    store.select(clusterId, VIEW.helmReleases, {
      key: VIEW.helmReleases,
      namespace: item.release.namespace,
      name: item.release.name,
    });
  };
  const openRollout = (item: Extract<TimelineItem, { type: 'rollout' }>) => {
    const gvk = resolveRef(item.owner.apiVersion, item.owner.kind, apiResources);
    if (!gvk) return;
    openRolloutHistory(clusterId, gvk, {
      apiVersion: item.owner.apiVersion,
      kind: item.owner.kind,
      metadata: {
        name: item.owner.name,
        namespace: item.owner.namespace ?? undefined,
        uid: item.owner.uid,
      },
    });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ChangesHeader
        count={items.length}
        recording={<RecordingIndicator clusterId={clusterId} status={status} />}
        ranges={
          <div className="bg-fg/4 inline-flex shrink-0 gap-0.5 rounded-md p-0.5" role="group">
            {[...LIVE_RANGES, ...(persisted ? HISTORY_RANGES : [])].map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={TIME_RANGES[r] === rangeMs}
                onClick={() => {
                  setRange(r);
                  setLimit(PAGE);
                }}
                title={rangeTitle(r)}
                className={cn(
                  'rounded px-2 py-0.5 text-[11px] tabular-nums transition-colors',
                  TIME_RANGES[r] === rangeMs
                    ? 'bg-surface-raised text-fg font-medium shadow-sm'
                    : 'text-fg-dim hover:text-fg',
                )}
              >
                {rangeLabel(r)}
              </button>
            ))}
          </div>
        }
        search={
          <>
            <Search className="text-fg-dim h-3.5 w-3.5 shrink-0" />
            <input
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setLimit(PAGE);
              }}
              placeholder={i18n.t('Filter by name, field, actor…')}
              aria-label={i18n.t('Filter changes')}
              className="text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent text-[12px] outline-none"
            />
            {text && (
              <button
                type="button"
                onClick={() => setText('')}
                aria-label={i18n.t('Clear filter')}
                className="text-fg-dim hover:text-fg"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </>
        }
        refresh={
          <IconButton
            label={i18n.t('Refresh')}
            icon={journal.loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            onClick={refresh}
          />
        }
      />

      <div className="border-border/60 flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b px-4 py-1.5">
        {TIMELINE_SOURCES.map((source) => {
          const Icon = SOURCE_ICON[source];
          const on = shows(source);
          return (
            <button
              key={source}
              type="button"
              aria-pressed={on}
              onClick={() => toggleSource(source)}
              title={
                on
                  ? i18n.t('Hide {source}', { source: sourceLabel(source) })
                  : i18n.t('Show {source}', { source: sourceLabel(source) })
              }
              className={cn(
                'flex h-6 items-center gap-1.5 rounded-md px-2 text-[11.5px] ring-1 transition',
                on
                  ? 'bg-fg/5 text-fg ring-border/70 hover:bg-fg/8'
                  : 'text-fg-dim ring-border/40 hover:bg-fg/4 line-through',
              )}
            >
              <Icon className="h-3 w-3" />
              {sourceLabel(source)}
              {on && (
                <span className="text-fg-dim text-[10.5px] tabular-nums">{counts[source]}</span>
              )}
            </button>
          );
        })}
        {facets.length > 0 && <span className="bg-border/80 mx-1.5 h-4 w-px" aria-hidden />}
        {facets.map(([kind, count]) => {
          const on = kinds.includes(kind);
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={on}
              onClick={() => toggleKind(kind)}
              title={on ? i18n.t('Show every kind') : i18n.t('Only {kind} changes', { kind })}
              className={cn(
                'flex h-6 items-center gap-1.5 rounded-md px-2 text-[11.5px] transition',
                on
                  ? 'bg-accent/12 text-accent ring-accent/30 ring-1'
                  : 'text-fg-muted hover:bg-fg/5',
              )}
            >
              {kind}
              <span
                className={cn('text-[10.5px] tabular-nums', on ? 'text-accent/80' : 'text-fg-dim')}
              >
                {count}
              </span>
            </button>
          );
        })}
        {filtered && (
          <Button size="xs" variant="ghost" className="ml-auto" onClick={clear}>
            {i18n.t('Clear filters')}
          </Button>
        )}
      </div>

      <JournalNotices clusterId={clusterId} status={status} />

      {!journal.data ? (
        <div className="text-fg-muted flex flex-1 items-center justify-center gap-2 text-[12px]">
          {journal.error ? (
            <span className="text-status-error px-6 text-center break-words">{journal.error}</span>
          ) : (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {i18n.t('Loading changes…')}
            </>
          )}
        </div>
      ) : !items.length ? (
        <EmptyTimeline filtered={filtered} range={range} status={status} onClear={clear} />
      ) : (
        <div className="overlay-scroll min-h-0 flex-1 overflow-auto pb-4">
          {buckets.map((bucket) => (
            <section key={bucket.key} aria-label={bucket.label}>
              <h3 className="border-border/50 bg-surface/95 text-fg-dim sticky top-0 z-10 flex h-8 items-center gap-2 border-b px-4 text-[10.5px] font-semibold tracking-[0.08em] uppercase backdrop-blur">
                {bucket.label}
                <span className="text-fg-dim/70 tabular-nums">{bucket.items.length}</span>
              </h3>
              <ol className="py-1">
                {bucket.items.map((item, i) => {
                  const first = i === 0;
                  const last = i === bucket.items.length - 1;
                  if (item.type === 'change')
                    return (
                      <ChangeRow
                        key={item.key}
                        entry={item.change}
                        now={now}
                        first={first}
                        last={last}
                        expanded={expanded === item.key}
                        onToggle={() => setExpanded((k) => (k === item.key ? null : item.key))}
                        historic={isHistoryItem(item)}
                      />
                    );
                  if (item.type === 'warning')
                    return (
                      <WarningRow
                        key={item.key}
                        item={item}
                        now={now}
                        first={first}
                        last={last}
                        onOpen={openWarning(item)}
                      />
                    );
                  if (item.type === 'helm')
                    return (
                      <HelmRow
                        key={item.key}
                        item={item}
                        now={now}
                        first={first}
                        last={last}
                        onOpen={() => openHelm(item)}
                      />
                    );
                  return (
                    <RolloutRow
                      key={item.key}
                      item={item}
                      now={now}
                      first={first}
                      last={last}
                      onOpen={() => openRollout(item)}
                    />
                  );
                })}
              </ol>
            </section>
          ))}
          <TimelineFooter
            persisted={persisted}
            status={status}
            since={now - rangeMs}
            truncated={truncatedPage}
            canLoadMore={truncatedPage && limit < MAX_LIMIT}
            onLoadMore={() => setLimit((l) => Math.min(MAX_LIMIT, l + PAGE))}
          />
        </div>
      )}
    </div>
  );
}

function RecordingIndicator({
  clusterId,
  status,
}: {
  clusterId: string;
  status: ChangeJournalStatus | undefined;
}) {
  i18n.useLocale();
  const toggle = useRecordingToggle(clusterId);
  if (!status || !toggle.ready) return null;
  const recording = status.recording;
  const since = status.started_at
    ? i18n.date(status.started_at, { hour: '2-digit', minute: '2-digit' })
    : null;
  const label = recording
    ? status.synced
      ? since
        ? i18n.t('Recording since {time}', { time: since })
        : i18n.t('Recording')
      : i18n.t('Building baseline…')
    : i18n.t('Not recording');
  return (
    <span className="flex shrink-0 items-center gap-2 @2xl:ml-2">
      <span
        className="text-fg-dim flex items-center gap-1.5 text-[11px]"
        // The label hides in narrow panes; the tooltip always carries it.
        title={
          recording && since
            ? i18n.t('Recording since {time}. Changes before that are unknown.', { time: since })
            : label
        }
      >
        <span
          aria-hidden
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            recording
              ? status.synced
                ? 'bg-status-running animate-pulse'
                : 'bg-status-starting animate-pulse'
              : 'bg-fg-dim/50',
          )}
        />
        <span className="hidden @2xl:inline">{label}</span>
      </span>
      {toggle.globallyOn && (
        <span title={i18n.t('Record changes of this cluster')}>
          <Switch
            checked={toggle.on}
            disabled={toggle.saving}
            onChange={(on) => void toggle.setOn(on)}
            label={
              <span className="text-fg-muted text-[11px] font-normal">{i18n.t('Record')}</span>
            }
            className="items-center gap-1.5"
          />
        </span>
      )}
    </span>
  );
}

function JournalNotices({
  clusterId,
  status,
}: {
  clusterId: string;
  status: ChangeJournalStatus | undefined;
}) {
  i18n.useLocale();
  const toggle = useRecordingToggle(clusterId);
  if (!status) return null;
  if (!status.enabled)
    return (
      <div className="border-border/60 bg-fg/3 flex shrink-0 items-center gap-2.5 border-b px-4 py-2 text-[12px]">
        <CircleSlash className="text-fg-dim h-3.5 w-3.5 shrink-0" />
        <span className="text-fg-muted">
          {toggle.globallyOn
            ? i18n.t('Change recording is off for this cluster.')
            : i18n.t('Change recording is turned off for every cluster in Settings.')}{' '}
          {i18n.t('Warnings, Helm revisions and rollouts still show below.')}
        </span>
        <Button
          size="xs"
          variant="secondary"
          className="ml-auto"
          disabled={toggle.saving || !toggle.ready}
          onClick={() => void toggle.setOn(true)}
        >
          {toggle.globallyOn ? i18n.t('Record this cluster') : i18n.t('Turn on recording')}
        </Button>
      </div>
    );
  const skipped = status.kinds.filter((k) => k.state === 'forbidden' || k.state === 'not-served');
  const failing = status.kinds.filter((k) => k.state === 'error');
  if (!skipped.length && !failing.length) return null;
  const describe = (k: (typeof status.kinds)[number]) =>
    k.state === 'forbidden'
      ? i18n.t('{kind} (forbidden)', { kind: k.kind })
      : k.state === 'not-served'
        ? i18n.t('{kind} (not served)', { kind: k.kind })
        : i18n.t('{kind} (retrying)', { kind: k.kind });
  return (
    <div
      className="border-border/60 text-fg-dim flex shrink-0 items-start gap-2 border-b px-4 py-1.5 text-[11.5px]"
      title={[...failing, ...skipped]
        .map((k) => (k.message ? `${k.kind}: ${k.message}` : k.kind))
        .join('\n')}
    >
      <TriangleAlert className="text-status-starting mt-0.5 h-3 w-3 shrink-0" />
      <span className="min-w-0">
        {i18n.t('Not recorded: {kinds}', {
          kinds: [...failing, ...skipped].map(describe).join(', '),
        })}
      </span>
    </div>
  );
}

function EmptyTimeline({
  filtered,
  range,
  status,
  onClear,
}: {
  filtered: boolean;
  range: TimeRange;
  status: ChangeJournalStatus | undefined;
  onClear: () => void;
}) {
  i18n.useLocale();
  const since =
    status?.recording && status.started_at
      ? i18n.date(status.started_at, { hour: '2-digit', minute: '2-digit' })
      : null;
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <div className="bg-fg/5 text-fg-dim mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl">
          <History className="h-5 w-5" />
        </div>
        <h3 className="text-fg text-[13.5px] font-semibold">
          {filtered
            ? i18n.t('Nothing matches the filters')
            : i18n.t('Nothing changed in this time range')}
        </h3>
        <p className="text-fg-muted mt-1.5 text-[12px] leading-relaxed">
          {filtered
            ? i18n.t('Clear the filters or widen the time range.')
            : since
              ? i18n.t(
                  'Changes appear here as they happen. Kubepit has been recording since {time}.',
                  { time: since },
                )
              : i18n.t('Kubepit records changes while the cluster is connected.')}
        </p>
        {filtered ? (
          <Button className="mt-4" size="sm" variant="secondary" onClick={onClear}>
            {i18n.t('Clear filters')}
          </Button>
        ) : (
          <p className="text-fg-dim mt-3 text-[11px]">{rangeTitle(range)}</p>
        )}
      </div>
    </div>
  );
}

function TimelineFooter({
  persisted = false,
  status,
  since,
  truncated,
  canLoadMore,
  onLoadMore,
}: {
  /** Older entries come from the persistent history. */
  persisted?: boolean;
  status: ChangeJournalStatus | undefined;
  since: number;
  truncated: boolean;
  canLoadMore: boolean;
  onLoadMore: () => void;
}) {
  i18n.useLocale();
  const started = status?.recording ? status.started_at : null;
  return (
    <div className="text-fg-dim flex flex-col items-center gap-2 px-4 pt-4 text-center text-[11px]">
      {canLoadMore ? (
        <Button size="xs" variant="secondary" onClick={onLoadMore}>
          {i18n.t('Load older changes')}
        </Button>
      ) : truncated ? (
        <span>
          {i18n.t('Showing the newest changes only. Narrow the filters to see older ones.')}
        </span>
      ) : null}
      {persisted && (
        <span>
          {i18n.t('Entries older than the live journal come from the history on this machine.')}
        </span>
      )}
      {!persisted && started !== null && started > since && (
        <span className="flex items-center gap-2">
          <span className="bg-border h-px w-8" aria-hidden />
          {i18n.t('Recording started at {time}; earlier changes are unknown.', {
            time: i18n.date(started, { hour: '2-digit', minute: '2-digit' }),
          })}
          <span className="bg-border h-px w-8" aria-hidden />
        </span>
      )}
      {!!status?.evicted && (
        <span>{i18n.t('The oldest changes were dropped to stay within memory limits.')}</span>
      )}
    </div>
  );
}
