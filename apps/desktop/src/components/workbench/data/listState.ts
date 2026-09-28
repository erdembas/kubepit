import type { WatchSnapshot } from './watchCache';

/**
 * Completeness of a watched list. A batch that reports an error keeps the
 * rows it could read (`watchBatch.ts`), so a `ready` list can still miss a
 * namespace: views that compare lists or answer "who can" must treat it as
 * incomplete, never as the whole truth.
 */

export type ListState = Pick<WatchSnapshot, 'synced' | 'status' | 'error'>;

/** Every object is known: synced, with no error at all (not even a partial one). */
export function isListComplete(s: ListState): boolean {
  return s.synced && s.status !== 'error' && !s.error;
}

/** Report as unreadable or incomplete: the list failed, or loaded with an error on the side. */
export function hasListError(s: ListState): boolean {
  return s.status === 'error' || !!s.error;
}
