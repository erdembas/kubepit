import * as i18n from '@/i18n';
import { useEffect, useState } from 'react';
import { FileDiff, History, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import type { KubeObject } from '@/types';
import { ChangeRow } from '../changes/TimelineRows';
import { TimeTravelPanel } from '../changes/TimeTravelPanel';
import { useJournal } from '../changes/useChanges';
import {
  journalCoverageStart,
  useHistoryChanges,
  usePersistedHistory,
} from '../changes/useHistory';
import { useNow } from '../util';
import { requestFor, useDetailsTabRequest } from './detailsTabs';

/**
 * Journaled changes of one object (same kind, namespace and name, so earlier
 * incarnations of a re-created object show too), newest first, each
 * expandable to its before/after diff.
 */
export function ChangesTab({
  clusterId,
  obj,
  isActive,
}: {
  clusterId: string;
  obj: KubeObject;
  isActive: boolean;
}) {
  i18n.useLocale();
  const now = useNow(30_000, isActive);
  const namespace = obj.metadata.namespace ?? null;
  const journal = useJournal(
    clusterId,
    {
      namespaces: namespace ? [namespace] : [],
      kinds: [obj.kind],
      name: obj.metadata.name,
      text: null,
      limit: 200,
    },
    null,
    isActive,
    10_000,
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [timeTravel, setTimeTravel] = useState(false);
  const entries = journal.data?.entries ?? [];
  const status = journal.data?.status;
  // Persistent history: older entries on demand ("Load older").
  const persisted = usePersistedHistory(clusterId);
  const [olderLimit, setOlderLimit] = useState(0);
  const older = useHistoryChanges(
    clusterId,
    {
      namespaces: namespace ? [namespace] : [],
      kinds: [obj.kind],
      name: obj.metadata.name,
      text: null,
      limit: Math.max(1, olderLimit),
    },
    null,
    journalCoverageStart(status),
    isActive && persisted && olderLimit > 0 && !!journal.data,
    null,
  );
  const olderEntries = olderLimit > 0 ? (older.data?.entries ?? []) : [];
  const canLoadOlder =
    persisted && !!journal.data && (olderLimit === 0 || older.data?.next_cursor != null);

  // A timeline click opened this tab: open the newest entry right away.
  const request = useDetailsTabRequest((s) => requestFor(s.request, clusterId, obj.metadata.uid));
  useEffect(() => {
    if (!request || request.tab !== 'changes' || !journal.data) return;
    const newest = journal.data.entries[0];
    setExpanded(newest ? `c:${newest.id}` : null);
    useDetailsTabRequest.getState().clear();
  }, [request, journal.data]);

  const since = status?.started_at
    ? i18n.date(status.started_at, { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border/60 text-fg-dim flex h-9 shrink-0 items-center gap-2 border-b px-3 text-[11px]">
        <FileDiff className="h-3 w-3" />
        {journal.data && (
          <span className="tabular-nums">
            {i18n.plural('{count} change', '{count} changes', entries.length)}
          </span>
        )}
        {status?.recording && since && (
          <>
            <span className="text-fg-dim/40">·</span>
            <span>{i18n.t('Recording since {time}', { time: since })}</span>
          </>
        )}
        {journal.loading && <Loader2 className="h-3 w-3 animate-spin" />}
        <div className="ml-auto flex items-center gap-1">
          <IconButton
            size="xs"
            label={i18n.t('Compare a past state with the live object')}
            icon={<History />}
            onClick={() => setTimeTravel((v) => !v)}
            className={timeTravel ? 'text-accent' : undefined}
          />
          <IconButton
            size="xs"
            label={i18n.t('Refresh')}
            icon={<RefreshCw />}
            onClick={() => void journal.refresh()}
          />
        </div>
      </div>
      {timeTravel && (
        <TimeTravelPanel
          clusterId={clusterId}
          obj={obj}
          entries={entries}
          olderEntries={olderEntries}
          isActive={isActive}
          onClose={() => setTimeTravel(false)}
        />
      )}
      {!journal.data ? (
        <div className="text-fg-muted flex flex-1 items-center justify-center gap-2 p-6 text-[12px]">
          {journal.error ? (
            <span className="text-status-error text-center break-words">{journal.error}</span>
          ) : (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {i18n.t('Loading changes…')}
            </>
          )}
        </div>
      ) : !entries.length && !olderEntries.length ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
          <span className="bg-fg/5 text-fg-dim flex h-9 w-9 items-center justify-center rounded-xl">
            <FileDiff className="h-4.5 w-4.5" />
          </span>
          <p className="text-fg text-[12.5px] font-medium">{i18n.t('No changes recorded')}</p>
          <p className="text-fg-dim max-w-sm text-[11.5px]">
            {!status?.enabled
              ? i18n.t('Change recording is off for this cluster. Turn it on in the Changes view.')
              : since
                ? i18n.t('Nobody changed this object since Kubepit started recording at {time}.', {
                    time: since,
                  })
                : i18n.t('Kubepit records changes while the cluster is connected.')}
          </p>
          {canLoadOlder && (
            <Button
              size="xs"
              variant="secondary"
              className="mt-2"
              disabled={older.loading}
              onClick={() => setOlderLimit((l) => l + 100)}
            >
              {i18n.t('Load older changes from history')}
            </Button>
          )}
        </div>
      ) : (
        <ol className="overlay-scroll min-h-0 flex-1 overflow-auto py-1">
          {entries.map((entry, i) => (
            <ChangeRow
              key={entry.id}
              entry={entry}
              now={now}
              first={i === 0}
              last={i === entries.length - 1 && !olderEntries.length}
              expanded={expanded === `c:${entry.id}`}
              onToggle={() =>
                setExpanded((key) => (key === `c:${entry.id}` ? null : `c:${entry.id}`))
              }
              compact
            />
          ))}
          {olderEntries.map((entry, i) => (
            <ChangeRow
              key={`h${entry.id}`}
              entry={entry}
              now={now}
              first={i === 0 && !entries.length}
              last={i === olderEntries.length - 1}
              expanded={expanded === `h:${entry.id}`}
              onToggle={() =>
                setExpanded((key) => (key === `h:${entry.id}` ? null : `h:${entry.id}`))
              }
              compact
              historic
            />
          ))}
          {canLoadOlder && (
            <li className="flex justify-center py-3">
              <Button
                size="xs"
                variant="secondary"
                disabled={older.loading}
                onClick={() => setOlderLimit((l) => l + 100)}
              >
                {i18n.t('Load older changes from history')}
              </Button>
            </li>
          )}
        </ol>
      )}
    </div>
  );
}
