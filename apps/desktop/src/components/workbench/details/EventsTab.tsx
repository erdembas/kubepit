import * as i18n from '@/i18n';
import { useState } from 'react';
import { HardDrive, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ipc } from '@/lib/ipc';
import { asNumber, asObject, asString, field, lastTimestamp } from '@/lib/kube/accessors';
import type { ColumnContext } from '@/lib/kube/columns';
import { cn } from '@/lib/cn';
import { formatAge } from '@/lib/format';
import type { KubeObject } from '@/types';
import { mergeEvents, useHistoryObjectEvents, usePersistedHistory } from '../changes/useHistory';
import { usePolled } from '../data/polled';

export function EventList({
  events,
  ctx,
  empty,
}: {
  events: KubeObject[];
  ctx: ColumnContext;
  empty?: string;
}) {
  i18n.useLocale();
  if (!events.length)
    return (
      <p className="text-fg-dim px-4 py-10 text-center text-[12px]">
        {empty ?? i18n.t('No events for this object.')}
      </p>
    );
  return (
    <ul className="divide-border/50 divide-y">
      {events.map((e) => {
        const warning = asString(field(e, 'type')) === 'Warning';
        const count = asNumber(field(e, 'count'), 1);
        const src = asObject(field(e, 'source'));
        const source = [
          asString(src.component) || asString(field(e, 'reportingComponent')),
          asString(src.host),
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <li
            key={e.metadata.uid}
            className={cn('px-4 py-2.5', warning && 'bg-status-starting/[0.06]')}
          >
            <div className="flex items-center gap-2 text-[12px]">
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  warning ? 'bg-status-starting' : 'bg-fg-dim/60',
                )}
              />
              <span className={cn('font-medium', warning ? 'text-status-starting' : 'text-fg')}>
                {asString(field(e, 'reason'))}
              </span>
              {count > 1 && (
                <span className="text-fg-dim bg-fg/5 rounded px-1 text-[10px] tabular-nums">
                  ×{count}
                </span>
              )}
              <span
                className="text-fg-dim ml-auto shrink-0 text-[11px] tabular-nums"
                title={lastTimestamp(e)}
              >
                {formatAge(lastTimestamp(e), ctx.now)}
              </span>
            </div>
            <p className="text-fg-muted mt-1 pl-3.5 text-[12px] leading-relaxed break-words">
              {asString(field(e, 'message'))}
            </p>
            {source && (
              <p className="text-fg-dim mt-0.5 truncate pl-3.5 font-mono text-[10.5px]">{source}</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function EventsTab({
  clusterId,
  obj,
  isActive,
  ctx,
}: {
  clusterId: string;
  obj: KubeObject;
  isActive: boolean;
  ctx: ColumnContext;
}) {
  i18n.useLocale();
  const events = usePolled(
    `${clusterId}|events|${obj.metadata.uid}`,
    () => ipc.resourceEvents(clusterId, obj.metadata.namespace ?? null, obj.metadata.uid),
    10_000,
    isActive,
  );
  // Persistent history: events Kubernetes already expired, on demand.
  const persisted = usePersistedHistory(clusterId);
  const [olderLimit, setOlderLimit] = useState(0);
  const older = useHistoryObjectEvents(
    clusterId,
    obj,
    Math.max(1, olderLimit),
    isActive && persisted && olderLimit > 0,
  );
  const olderOnly =
    olderLimit > 0 && events.data
      ? mergeEvents(events.data, older.data?.events ?? []).slice(events.data.length)
      : [];
  const canLoadOlder =
    persisted && !!events.data && (olderLimit === 0 || older.data?.next_cursor != null);
  return (
    <div className="overlay-scroll min-h-0 flex-1 overflow-auto">
      {events.error && !events.data ? (
        <p className="text-status-error p-4 text-[12px] break-words">{events.error}</p>
      ) : !events.data ? (
        <div className="text-fg-muted flex items-center justify-center gap-2 py-10 text-[12px]">
          <Loader2 className="h-4 w-4 animate-spin" />
          {i18n.t('Loading…')}
        </div>
      ) : (
        <>
          {(events.data.length > 0 || !olderOnly.length) && (
            <EventList events={events.data} ctx={ctx} />
          )}
          {olderOnly.length > 0 && (
            <>
              <h4 className="border-border/50 text-fg-dim flex h-8 items-center gap-1.5 border-y px-4 text-[10.5px] font-semibold tracking-[0.08em] uppercase">
                <HardDrive className="h-3 w-3" />
                {i18n.t('From history')}
              </h4>
              <EventList events={olderOnly} ctx={ctx} />
            </>
          )}
          {olderLimit > 0 && older.data && !olderOnly.length && (
            <p className="text-fg-dim px-4 py-3 text-center text-[11.5px]">
              {i18n.t('No older events in the history.')}
            </p>
          )}
          {canLoadOlder && (
            <div className="flex justify-center py-3">
              <Button
                size="xs"
                variant="secondary"
                disabled={older.loading}
                onClick={() => setOlderLimit((l) => l + 100)}
              >
                {i18n.t('Load older events from history')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
