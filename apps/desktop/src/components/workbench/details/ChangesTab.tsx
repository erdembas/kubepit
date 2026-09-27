import * as i18n from '@/i18n';
import { useEffect, useState } from 'react';
import { FileDiff, Loader2, RefreshCw } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import type { KubeObject } from '@/types';
import { ChangeRow } from '../changes/TimelineRows';
import { useJournal } from '../changes/useChanges';
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
  const [expanded, setExpanded] = useState<number | null>(null);
  const entries = journal.data?.entries ?? [];
  const status = journal.data?.status;

  // A timeline click opened this tab: open the newest entry right away.
  const request = useDetailsTabRequest((s) => requestFor(s.request, clusterId, obj.metadata.uid));
  useEffect(() => {
    if (!request || request.tab !== 'changes' || !journal.data) return;
    setExpanded(journal.data.entries[0]?.id ?? null);
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
        <div className="ml-auto flex items-center">
          <IconButton
            size="xs"
            label={i18n.t('Refresh')}
            icon={<RefreshCw />}
            onClick={() => void journal.refresh()}
          />
        </div>
      </div>
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
      ) : !entries.length ? (
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
        </div>
      ) : (
        <ol className="overlay-scroll min-h-0 flex-1 overflow-auto py-1">
          {entries.map((entry, i) => (
            <ChangeRow
              key={entry.id}
              entry={entry}
              now={now}
              first={i === 0}
              last={i === entries.length - 1}
              expanded={expanded === entry.id}
              onToggle={() => setExpanded((id) => (id === entry.id ? null : entry.id))}
              compact
            />
          ))}
        </ol>
      )}
    </div>
  );
}
