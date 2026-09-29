import type { KubeObject, WatchBatch } from '@/types';
import type { WatchSnapshot, WatchStatus } from './watchCache';

/**
 * Pure watch batch handling for `watchCache`. The backend reports a watch
 * error in the same batch as the pending `reset`, upserts and deletes (one
 * forbidden namespace of a multi-namespace watch, a dropped connection), so
 * the objects are always applied and the error only decides the status.
 */

export function isForbidden(message: string) {
  return /forbidden|\b403\b|cannot (list|watch|get)/i.test(message);
}

export interface BatchRoute {
  apply(batch: WatchBatch): void;
  ack(batch: WatchBatch): void;
  restart(): void;
}

/**
 * Routes one batch of a backend watch. The watch's `current` generation
 * applies it; then every batch is acknowledged, a superseded generation's
 * too (that watch is being stopped anyway), so the backend's ack window
 * (4 batches) never stalls on a live view. Acks do not wait for a frame: a
 * background window keeps its watches. A `stopped` batch (the backend gave
 * up after 60 s without acks, the webview was frozen) restarts a current
 * watch instead.
 *
 * Never throws: a Tauri channel whose `onmessage` throws delivers nothing
 * after it (`@tauri-apps/api` does not advance past the message). A batch
 * that fails to apply is reported, acknowledged, and the watch restarts,
 * since its rows may be half-applied.
 */
export function routeBatch(batch: WatchBatch, current: boolean, route: BatchRoute) {
  if (batch.stopped) {
    if (current) route.restart();
    return;
  }
  let failed = false;
  try {
    if (current) route.apply(batch);
  } catch (error) {
    failed = true;
    console.error('A watch batch could not be applied; restarting the watch.', error);
  }
  route.ack(batch);
  if (failed) route.restart();
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
 *
 * Only the backend's `recovered` signal clears an earlier error: a clean
 * batch of another namespace proves nothing about the one that failed, so
 * the error (and `forbidden`) stays and only the status follows the rows.
 */
export function batchPatch(
  prev: Pick<WatchSnapshot, 'synced'> & Partial<Pick<WatchSnapshot, 'error'>>,
  batch: Pick<WatchBatch, 'error' | 'synced'> & Partial<Pick<WatchBatch, 'recovered'>>,
  size: number,
): Partial<WatchSnapshot> {
  const synced = prev.synced || batch.synced;
  const error = batch.error ?? (batch.recovered ? null : (prev.error ?? null));
  if (!error)
    return synced
      ? { status: 'ready', error: null, forbidden: false, synced: true }
      : { status: 'loading', error: null, forbidden: false };
  const status: WatchStatus = size === 0 ? 'error' : synced ? 'ready' : 'loading';
  const patch: Partial<WatchSnapshot> = batch.error
    ? { status, error, forbidden: isForbidden(error) }
    : { status };
  if (size > 0) patch.synced = synced;
  return patch;
}

/**
 * The patch to paint at once after a batch, or `null` to coalesce the batch
 * into the next frame. Painted at once: an error, the first sync or the
 * recovery from a failed list, and the backend's `recovered` signal (every
 * failing source delivered events again) while an error is still shown.
 * A `reset` alone keeps the error: another namespace may still be failing.
 */
export function batchFlush(
  prev: Pick<WatchSnapshot, 'synced' | 'status' | 'error'>,
  batch: WatchBatch,
  size: number,
): Partial<WatchSnapshot> | null {
  const synced = prev.synced || batch.synced;
  if (batch.error || (synced && prev.status !== 'ready') || (batch.recovered && prev.error))
    return batchPatch(prev, batch, size);
  return null;
}
