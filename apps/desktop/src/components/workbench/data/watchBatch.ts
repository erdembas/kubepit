import type { KubeObject, WatchBatch } from '@/types';
import type { WatchSnapshot } from './watchCache';

/**
 * Pure watch batch handling for `watchCache`. The backend reports a watch
 * error in the same batch as the pending `reset`, upserts and deletes (one
 * forbidden namespace of a multi-namespace watch, a dropped connection), so
 * the objects are always applied and the error only decides the status.
 */

export function isForbidden(message: string) {
  return /forbidden|\b403\b|cannot (list|watch|get)/i.test(message);
}

/**
 * Applies `reset`, then `upserts`, then `deletes` (uids), whether or not the
 * batch has an error. Returns false for a batch that carries no rows at all
 * (an error-only batch of a retrying watch), which needs no new version.
 */
export function applyBatch(map: Map<string, KubeObject>, batch: WatchBatch): boolean {
  if (batch.reset) map.clear();
  for (const obj of batch.upserts) map.set(obj.metadata.uid, obj);
  for (const uid of batch.deletes) map.delete(uid);
  return batch.reset || batch.upserts.length > 0 || batch.deletes.length > 0;
}

/**
 * Snapshot status after a batch that left `size` objects. An error turns the
 * list into `error` only when nothing is left to show; otherwise the rows
 * stay and the snapshot carries `error` and `forbidden` for a notice.
 */
export function batchPatch(
  prev: Pick<WatchSnapshot, 'synced'>,
  batch: Pick<WatchBatch, 'error' | 'synced'>,
  size: number,
): Partial<WatchSnapshot> {
  const synced = prev.synced || batch.synced;
  if (!batch.error)
    return synced
      ? { status: 'ready', error: null, forbidden: false, synced: true }
      : { status: 'loading', error: null, forbidden: false };
  const error = batch.error;
  const forbidden = isForbidden(error);
  if (size === 0) return { status: 'error', error, forbidden };
  return { status: synced ? 'ready' : 'loading', error, forbidden, synced };
}

/**
 * The patch to paint at once after a batch, or `null` to coalesce the batch
 * into the next frame. Painted at once: an error, the first sync or the
 * recovery from a failed list, and a clean `reset` (a full snapshot after a
 * reconnect or re-list) while an earlier error is still shown. A source that
 * still fails reports its error again on its next retry.
 */
export function batchFlush(
  prev: Pick<WatchSnapshot, 'synced' | 'status' | 'error'>,
  batch: WatchBatch,
  size: number,
): Partial<WatchSnapshot> | null {
  const synced = prev.synced || batch.synced;
  if (batch.error || (synced && prev.status !== 'ready') || (batch.reset && prev.error))
    return batchPatch(prev, batch, size);
  return null;
}
