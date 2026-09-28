import { describe, expect, it } from 'vitest';
import type { KubeObject, WatchBatch } from '@/types';
import { applyBatch, batchPatch } from './watchBatch';

const pod = (uid: string) =>
  ({ apiVersion: 'v1', kind: 'Pod', metadata: { name: uid, namespace: 'a', uid } }) as KubeObject;
const batch = (b: Partial<WatchBatch>): WatchBatch => ({
  watch_id: 'w',
  reset: false,
  upserts: [],
  deletes: [],
  synced: false,
  error: null,
  ...b,
});

describe('watch batches', () => {
  it('applies upserts of a batch that also carries an error', () => {
    const map = new Map<string, KubeObject>();
    applyBatch(
      map,
      batch({ reset: true, upserts: [pod('a1'), pod('a2')], error: 'namespaces "b" is forbidden' }),
    );
    expect([...map.keys()]).toEqual(['a1', 'a2']);
  });
  it('reset clears previous rows even when the batch has an error', () => {
    const map = new Map([['old', pod('old')]]);
    applyBatch(map, batch({ reset: true, upserts: [pod('n')], error: 'x' }));
    expect([...map.keys()]).toEqual(['n']);
  });
  it('status is error only when nothing is left', () => {
    expect(
      batchPatch({ synced: false }, { error: 'pods is forbidden', synced: true }, 0),
    ).toMatchObject({ status: 'error', error: 'pods is forbidden', forbidden: true });
    expect(
      batchPatch({ synced: false }, { error: 'pods is forbidden', synced: true }, 2),
    ).toMatchObject({ status: 'ready', error: 'pods is forbidden', forbidden: true, synced: true });
    expect(batchPatch({ synced: true }, { error: null, synced: true }, 2)).toMatchObject({
      error: null,
      forbidden: false,
    });
  });
});
