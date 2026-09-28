import type { HealthKind, HealthLists } from '@/lib/kube/health';
import { hasListError, isListComplete, type ListState } from '../data/listState';
import type { WatchSnapshot } from '../data/watchCache';

/**
 * Turns the health view's watch snapshots into scan lists and the set of
 * lists that loaded completely. Pure, so the loaded decision is testable.
 */

export type ListSnapshot = Pick<WatchSnapshot, 'items' | 'synced' | 'status' | 'error'>;

/**
 * Loaded: an unserved kind (nothing to read), or a list that synced with no
 * error at all. A partial error (rows of the other namespaces kept, one
 * namespace forbidden) is not loaded, so rules that compare lists skip
 * instead of reporting the objects they could not see.
 */
export function isListLoaded(served: boolean, s: ListState): boolean {
  return !served || isListComplete(s);
}

/** A served list to report as unreadable: failed, or loaded with an error on the side. */
export function hasListIssue(served: boolean, s: ListState): boolean {
  return served && hasListError(s);
}

export function scanLists(
  kinds: readonly HealthKind[],
  served: (kind: HealthKind) => boolean,
  snaps: Readonly<Record<HealthKind, ListSnapshot>>,
): { lists: HealthLists; loaded: Set<HealthKind> } {
  const loaded = new Set<HealthKind>();
  const lists = {} as HealthLists;
  for (const k of kinds) {
    const s = snaps[k];
    if (isListLoaded(served(k), s)) loaded.add(k);
    // Partial rows still feed the rules that need no complete list.
    lists[k] = served(k) && s.status !== 'error' ? s.items : [];
  }
  return { lists, loaded };
}
