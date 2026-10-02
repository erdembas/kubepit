import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState } from 'react';
import { History, Loader2, TriangleAlert, X } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import type { ChangeDetail, ChangeSummary, KubeObject } from '@/types';
import { DiffView } from '../common/DiffView';
import { usePolled } from '../data/polled';
import {
  fallbackCandidates,
  liveYaml,
  mergeOldestFirst,
  pickStateAt,
  resolveState,
  snapshotYaml,
  type ResolvedState,
} from '@/lib/kube/changes/timetravel';

/**
 * "State at time T": reconstructs the object's normalized state from the
 * change journal (the last entry at or before T carries a full snapshot)
 * and diffs it with the live object. Entries never change once recorded,
 * so the details are fetched once per chosen time.
 */

const QUICK: Array<{ ms: number; label: () => string }> = [
  { ms: 15 * 60_000, label: () => i18n.t('{count} min', { count: 15 }) },
  { ms: 60 * 60_000, label: () => i18n.t('{count} hour', { count: 1 }) },
  { ms: 6 * 60 * 60_000, label: () => i18n.t('{count} hours', { count: 6 }) },
];

/** `datetime-local` input value of an epoch-ms timestamp. */
function toLocalInput(ms: number): string {
  const local = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function fromLocalInput(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timeText(ms: number): string {
  return i18n.date(ms, { dateStyle: 'medium', timeStyle: 'medium' });
}

export function TimeTravelPanel({
  clusterId,
  obj,
  entries,
  olderEntries,
  isActive,
  onClose,
}: {
  clusterId: string;
  obj: KubeObject;
  /** Journal entries of this object, newest first. */
  entries: readonly ChangeSummary[];
  /** Loaded history entries, newest first (older than the journal). */
  olderEntries: readonly ChangeSummary[];
  isActive: boolean;
  onClose: () => void;
}) {
  i18n.useLocale();
  const [at, setAt] = useState(() => entries[0]?.ts ?? Date.now());
  const merged = useMemo(() => mergeOldestFirst(entries, olderEntries), [entries, olderEntries]);
  const pick = useMemo(() => pickStateAt(merged, at), [merged, at]);
  const candidates = useMemo(
    () => (pick.kind === 'state' ? fallbackCandidates(merged, at) : []),
    [pick, merged, at],
  );

  const key = `${clusterId}|timetravel|${obj.metadata.uid}|${at}|${candidates
    .map((c) => `${c.source}${c.entry.id}`)
    .join(',')}`;
  const state = usePolled<{ resolved: ResolvedState | null }>(
    key,
    async () => ({
      resolved: await resolveState(candidates, (e) =>
        (e.source === 'journal'
          ? ipc.changesGet(clusterId, e.entry.id)
          : ipc.historyChangesGet(clusterId, e.entry.id)
        ).catch(() => null),
      ),
    }),
    null,
    isActive && pick.kind === 'state',
  );

  const resolved = state.data?.resolved ?? null;
  const detail: ChangeDetail | null = resolved?.detail ?? null;

  return (
    <div className="border-border/60 bg-surface-muted/30 border-b">
      <div className="flex h-9 shrink-0 flex-wrap items-center gap-2 px-3 py-1 text-[11px]">
        <History className="text-fg-dim h-3 w-3 shrink-0" />
        <span className="text-fg-dim shrink-0">{i18n.t('State at')}</span>
        <input
          type="datetime-local"
          value={toLocalInput(at)}
          max={toLocalInput(Date.now())}
          onChange={(e) => {
            const ms = fromLocalInput(e.target.value);
            if (ms !== null) setAt(ms);
          }}
          aria-label={i18n.t('State at')}
          className="bg-surface border-border text-fg focus:border-accent/50 h-6.5 rounded-md border px-1.5 text-[11px] tabular-nums outline-none"
        />
        <span className="flex items-center gap-1">
          {QUICK.map((q) => (
            <button
              key={q.ms}
              type="button"
              onClick={() => setAt(Date.now() - q.ms)}
              className="text-fg-dim hover:bg-fg/6 hover:text-fg h-6 rounded-md px-1.5 transition"
            >
              {q.label()}
            </button>
          ))}
        </span>
        {state.loading && <Loader2 className="text-fg-dim h-3 w-3 animate-spin" />}
        <span className="ml-auto">
          <IconButton size="xs" label={i18n.t('Close')} icon={<X />} onClick={onClose} />
        </span>
      </div>
      {pick.kind === 'unknown' ? (
        <p className="text-fg-dim flex items-start gap-2 px-3 py-2.5 text-[11.5px]">
          <TriangleAlert className="text-status-starting mt-0.5 h-3.5 w-3.5 shrink-0" />
          {pick.hasEntries
            ? i18n.t('The oldest known change of this object is at {time}. Nothing before it is recorded.', {
                time: timeText(pick.coverageStart ?? 0),
              })
            : i18n.t('No changes are known for this object yet.')}
        </p>
      ) : !state.data ? (
        <div className="text-fg-muted flex h-16 items-center justify-center gap-2 text-[12px]">
          {state.error ? (
            <span className="text-status-error px-4 text-center break-words">{state.error}</span>
          ) : (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {i18n.t('Loading change…')}
            </>
          )}
        </div>
      ) : !resolved || !detail ? (
        <p className="text-fg-dim flex items-start gap-2 px-3 py-2.5 text-[11.5px]">
          <TriangleAlert className="text-status-starting mt-0.5 h-3.5 w-3.5 shrink-0" />
          {i18n.t('The change bodies around this time were too large to keep in the journal.')}
        </p>
      ) : (
        <>
          <div className="flex h-[320px] min-h-0 flex-col">
            <DiffView
              original={snapshotYaml(
                resolved.entry.entry.op === 'deleted'
                  ? detail.before_yaml
                  : detail.after_yaml ?? detail.before_yaml,
              )}
              modified={liveYaml(obj)}
              originalLabel={i18n.t('State at {time}', { time: timeText(at) })}
              modifiedLabel={i18n.t('Live object')}
              identicalHint={i18n.t('Nothing changed since then that the journal records.')}
            />
          </div>
          <div className="text-fg-dim flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-1.5 text-[11px]">
            {resolved.entry.entry.op === 'deleted' && (
              <span className="text-status-starting inline-flex items-center gap-1.5">
                <TriangleAlert className="h-3 w-3 shrink-0" />
                {i18n.t('The object was deleted at this time; the left side is its state before deletion.')}
              </span>
            )}
            {resolved.skippedOmitted > 0 && (
              <span>
                {i18n.plural(
                  '{count} change was too large to keep; showing the state of the previous kept change.',
                  '{count} changes were too large to keep; showing the state of the previous kept change.',
                  resolved.skippedOmitted,
                )}
              </span>
            )}
            {detail.summary.truncated && (
              <span>{i18n.t('Some long values were shortened to fit the journal.')}</span>
            )}
            {pick.kind === 'state' && pick.next && (
              <span className={cn('tabular-nums')}>
                {i18n.t('Next change at {time}', { time: timeText(pick.next.entry.ts) })}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
