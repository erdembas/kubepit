import { persistsHistory } from '@/lib/history/audit';
import { ipc } from '@/lib/ipc';
import { useAppStore } from '@/store/useAppStore';
import type {
  ChangeFilter,
  ChangeJournalStatus,
  ClusterId,
  HistoryChangePage,
  HistoryEventPage,
  KubeObject,
} from '@/types';
import { usePolled } from '../data/polled';
import { changesKeyPrefix } from './useChanges';

/**
 * Persistent history for the Changes view and the details tabs: entries and
 * Warning events of opted-in clusters that are older than what the live
 * journal and the API server still hold. Nothing here runs when the cluster
 * does not keep history, so the in-memory path stays unchanged.
 */

/** Whether `clusterId` keeps its events and changes on disk. */
export function usePersistedHistory(clusterId: ClusterId): boolean {
  return useAppStore((s) => persistsHistory(s.settings, clusterId));
}

/**
 * Where the live journal's coverage begins: persisted entries before it are
 * not in memory any more (or never were). Epoch ms, exclusive.
 */
export function journalCoverageStart(status: ChangeJournalStatus | undefined): number | null {
  if (!status?.recording) return null;
  const started = status.started_at ?? 0;
  const oldest = status.evicted ? (status.oldest_ts ?? 0) : 0;
  return Math.max(started, oldest);
}

/**
 * Persisted journal entries older than the live journal's coverage
 * (`before`, `null` = everything on disk), newest first.
 */
export function useHistoryChanges(
  clusterId: ClusterId,
  filter: Omit<ChangeFilter, 'since' | 'until' | 'cursor'>,
  rangeMs: number | null,
  before: number | null,
  enabled: boolean,
  interval: number | null = 30_000,
) {
  const key = enabled
    ? `${changesKeyPrefix(clusterId)}history|${JSON.stringify(filter)}|${rangeMs ?? '*'}|${before ?? '*'}`
    : null;
  return usePolled<HistoryChangePage>(
    key,
    () =>
      ipc.historyChangesList(clusterId, {
        ...filter,
        since: rangeMs === null ? null : Date.now() - rangeMs,
        until: before === null ? null : before - 1,
        cursor: null,
      }),
    interval,
    enabled,
  );
}

/** Persisted Warning events of the selected namespace (or all) within the range. */
export function useHistoryWarnings(
  clusterId: ClusterId,
  namespaces: string[],
  rangeMs: number,
  enabled: boolean,
) {
  return usePolled<HistoryEventPage>(
    enabled
      ? `${changesKeyPrefix(clusterId)}history-warnings|${namespaces.join(',')}|${rangeMs}`
      : null,
    () =>
      ipc.historyEventsList(clusterId, {
        namespaces,
        involved_uid: null,
        involved_kind: null,
        involved_name: null,
        types: ['Warning'],
        text: null,
        since: Date.now() - rangeMs,
        until: null,
        limit: 1000,
        cursor: null,
      }),
    30_000,
    enabled,
  );
}

/** Persisted events of one object (and its earlier incarnations), newest first. */
export function useHistoryObjectEvents(
  clusterId: ClusterId,
  obj: KubeObject,
  limit: number,
  enabled: boolean,
) {
  return usePolled<HistoryEventPage>(
    enabled ? `${clusterId}|history-events|${obj.metadata.uid}|${limit}` : null,
    () =>
      ipc.historyEventsList(clusterId, {
        namespaces: [],
        involved_uid: obj.metadata.uid,
        involved_kind: obj.kind,
        involved_name: obj.metadata.name,
        types: [],
        text: null,
        since: null,
        until: null,
        limit,
        cursor: null,
      }),
    null,
    enabled,
  );
}

/** `live` plus the persisted events it does not contain, newest first. */
export function mergeEvents(live: readonly KubeObject[], persisted: readonly KubeObject[]) {
  const seen = new Set(live.map((e) => e.metadata.uid));
  return [...live, ...persisted.filter((e) => !seen.has(e.metadata.uid))];
}
