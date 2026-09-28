import { describe, expect, it } from 'vitest';
import type { KubeObject, WatchBatch } from '@/types';
import { applyBatch, batchFlush, batchPatch } from './watchBatch';
import type { WatchSnapshot } from './watchCache';

const pod = (uid: string, namespace = 'a') =>
  ({ apiVersion: 'v1', kind: 'Pod', metadata: { name: uid, namespace, uid } }) as KubeObject;
const batch = (b: Partial<WatchBatch>): WatchBatch => ({
  watch_id: 'w',
  reset: false,
  upserts: [],
  deletes: [],
  synced: false,
  error: null,
  recovered: false,
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
  it('an error-only batch changes no rows', () => {
    const map = new Map([['a1', pod('a1')]]);
    expect(applyBatch(map, batch({ error: 'pods is forbidden', synced: true }))).toBe(false);
    expect(applyBatch(map, batch({ reset: true, upserts: [pod('a1')] }))).toBe(true);
    expect(applyBatch(map, batch({ deletes: ['a1'] }))).toBe(true);
  });
});

type State = Pick<WatchSnapshot, 'synced' | 'status' | 'error' | 'forbidden'>;

/** The `WatchEntry.apply` sequence without the frame scheduling. */
function run(batches: WatchBatch[]) {
  const map = new Map<string, KubeObject>();
  let state: State = { synced: false, status: 'loading', error: null, forbidden: false };
  const steps: Array<State & { rows: string[]; painted: boolean }> = [];
  for (const b of batches) {
    applyBatch(map, b);
    const patch = batchFlush(state, b, map.size);
    if (patch) state = { ...state, ...patch };
    steps.push({ ...state, rows: [...map.keys()].sort(), painted: !!patch });
  }
  return steps;
}

describe('watch batch sequences', () => {
  const forbiddenB =
    'pods is forbidden: User "dev" cannot list resource "pods" in the namespace "b"';

  it('a partial error keeps its rows until the backend reports recovery', () => {
    const [partial, update, retry, relist, recovered] = run([
      batch({ reset: true, upserts: [pod('a1')], synced: true, error: forbiddenB }),
      batch({ upserts: [pod('a2')], synced: true }),
      batch({ synced: true, error: forbiddenB }),
      // Namespace a re-lists (410 Gone) while b is still failing.
      batch({ reset: true, upserts: [pod('a1'), pod('a2')], synced: true }),
      // b's retried list succeeds: streamed without a reset.
      batch({ upserts: [pod('b1', 'b')], synced: true, recovered: true }),
    ]);
    expect(partial).toMatchObject({ status: 'ready', error: forbiddenB, forbidden: true });
    expect(partial!.rows).toEqual(['a1']);
    // Ordinary updates are coalesced and keep the notice.
    expect(update).toMatchObject({ status: 'ready', error: forbiddenB, painted: false });
    expect(update!.rows).toEqual(['a1', 'a2']);
    // A failing retry reports again, without touching the rows.
    expect(retry).toMatchObject({ status: 'ready', error: forbiddenB, painted: true });
    expect(retry!.rows).toEqual(['a1', 'a2']);
    // A reset alone proves nothing about b.
    expect(relist).toMatchObject({ status: 'ready', error: forbiddenB, painted: false });
    // The recovery clears it, although no reset was sent.
    expect(recovered).toMatchObject({
      status: 'ready',
      error: null,
      forbidden: false,
      painted: true,
    });
    expect(recovered!.rows).toEqual(['a1', 'a2', 'b1']);
  });

  it('a recovery with no rows (a quiet namespace) still clears the error', () => {
    const [, blip, recovered] = run([
      batch({ reset: true, upserts: [pod('a1')], synced: true }),
      batch({ synced: true, error: 'watch stream closed' }),
      batch({ synced: true, recovered: true }),
    ]);
    expect(blip).toMatchObject({ status: 'ready', error: 'watch stream closed' });
    expect(recovered).toMatchObject({ status: 'ready', error: null, painted: true });
    expect(recovered!.rows).toEqual(['a1']);
  });

  it('a failed list recovers when rows arrive', () => {
    const [failed, recovered] = run([
      batch({ reset: true, synced: true, error: forbiddenB }),
      batch({ upserts: [pod('b1', 'b')], synced: true, recovered: true }),
    ]);
    expect(failed).toMatchObject({ status: 'error', error: forbiddenB, forbidden: true });
    expect(recovered).toMatchObject({ status: 'ready', error: null, forbidden: false });
    expect(recovered!.rows).toEqual(['b1']);
  });

  it('rows of another namespace keep the error of a failed list', () => {
    // Namespace a is empty, b is forbidden: nothing to show, so `error`.
    const [failed, other] = run([
      batch({ reset: true, synced: true, error: forbiddenB }),
      // A pod appears in a; b has not recovered.
      batch({ upserts: [pod('a1')], synced: true }),
    ]);
    expect(failed).toMatchObject({ status: 'error', error: forbiddenB });
    expect(other).toMatchObject({ status: 'ready', error: forbiddenB, forbidden: true });
    expect(other!.rows).toEqual(['a1']);
  });

  it('an error before the other namespaces synced stays after the sync', () => {
    const [partial, synced] = run([
      batch({ reset: true, upserts: [pod('a1')], synced: false, error: forbiddenB }),
      batch({ upserts: [pod('a2')], synced: true }),
    ]);
    expect(partial).toMatchObject({ status: 'loading', error: forbiddenB, synced: false });
    expect(synced).toMatchObject({ status: 'ready', synced: true, error: forbiddenB });
  });
});
