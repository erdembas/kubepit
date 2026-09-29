import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN } from '@/lib/kube/catalog';
import { buildTopology, type TopoGraph } from '@/lib/kube/topology';
import type { KubeObject } from '@/types';
import { CoalescedMemo, pausedMemo, SYNC_REBUILD_INTERVAL_MS, topologyDataKey } from './dataKey';

describe('topologyDataKey', () => {
  it('ignores status-only changes such as loading → idle on leave', () => {
    const a = [{ version: 3, synced: true, forbidden: false, status: 'loading' }];
    const b = [{ version: 3, synced: true, forbidden: false, status: 'idle' }];
    expect(topologyDataKey(a)).toBe(topologyDataKey(b));
  });
  it('changes with version, synced or forbidden', () => {
    const base = { version: 3, synced: true, forbidden: false };
    expect(topologyDataKey([base])).not.toBe(topologyDataKey([{ ...base, version: 4 }]));
    expect(topologyDataKey([base])).not.toBe(topologyDataKey([{ ...base, forbidden: true }]));
    expect(topologyDataKey([base])).not.toBe(topologyDataKey([{ ...base, synced: false }]));
  });
  it('changes when a watch fails without new data', () => {
    const base = { version: 0, synced: false, forbidden: false, error: null };
    expect(topologyDataKey([base])).not.toBe(
      topologyDataKey([{ ...base, error: 'the server could not find the requested resource' }]),
    );
  });
});

describe('pausedMemo', () => {
  it('keeps the previous value while inactive, whatever the dependencies do', () => {
    let runs = 0;
    const compute = () => ++runs;
    const first = pausedMemo(null, ['a'], true, compute);
    expect(first.value).toBe(1);
    const paused = pausedMemo(first, ['b'], false, compute);
    expect(paused).toBe(first);
    expect(runs).toBe(1);
  });
  it('recomputes on resume only when the dependencies changed', () => {
    let runs = 0;
    const compute = () => ++runs;
    const first = pausedMemo(null, ['a'], true, compute);
    expect(pausedMemo(first, ['a'], true, compute)).toBe(first);
    expect(pausedMemo(first, ['b'], true, compute).value).toBe(2);
  });
  it('computes a first value even while inactive', () => {
    expect(pausedMemo(null, [], false, () => 'x').value).toBe('x');
  });
});

describe('CoalescedMemo', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  const pod = (i: number): KubeObject => ({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: `p-${i}`, namespace: 'ns', uid: `uid-${i}` },
    spec: {},
  });
  const pods = (graph: TopoGraph) =>
    [...graph.nodes.values()].filter((n) => n.kind === 'Pod').length;

  /**
   * A map whose pod watch delivers `batches` batches of 5 pods, one every
   * `everyMs`, then the batch that completes the sync. `render` stands for
   * the hook: it runs on every batch and whenever the memo asks for it.
   */
  function syncMap(batches: number, everyMs: number) {
    const items: KubeObject[] = [];
    let version = 0;
    let synced = false;
    let builds = 0;
    let graph: TopoGraph | null = null;
    const render = () => {
      graph = memo.get(['ns'], [version, synced], true, !synced, () => {
        builds++;
        return buildTopology({
          lists: [{ gvk: BUILTIN.Pod, items: [...items], synced }],
          namespaces: ['ns'],
          apiResources: null,
        });
      });
    };
    const memo = new CoalescedMemo<TopoGraph>(render, SYNC_REBUILD_INTERVAL_MS, () => Date.now());
    render();
    for (let b = 0; b < batches; b++) {
      vi.advanceTimersByTime(everyMs);
      for (let i = 0; i < 5; i++) items.push(pod(b * 5 + i));
      version++;
      render();
    }
    return {
      memo,
      render,
      get builds() {
        return builds;
      },
      get graph() {
        return graph!;
      },
      complete() {
        vi.advanceTimersByTime(everyMs);
        synced = true;
        version++;
        render();
      },
      change() {
        items.push(pod(items.length));
        version++;
        render();
      },
    };
  }

  it('rebuilds a bounded number of times while syncing, and once more when synced', () => {
    // 100 batches over 2 s: one build per batch before coalescing.
    const map = syncMap(100, 20);
    expect(map.builds).toBeLessThanOrEqual(1 + Math.ceil(2000 / SYNC_REBUILD_INTERVAL_MS));
    const before = map.builds;
    map.complete();
    expect(map.builds).toBe(before + 1);
    expect(pods(map.graph)).toBe(500);
    // Nothing is left scheduled once synced.
    vi.advanceTimersByTime(10 * SYNC_REBUILD_INTERVAL_MS);
    expect(map.builds).toBe(before + 1);
  });

  it('builds the latest data when a coalesced rebuild falls due', () => {
    const map = syncMap(3, 20);
    // The first render built the empty map; the batches wait for the interval.
    expect(map.builds).toBe(1);
    expect(pods(map.graph)).toBe(0);
    vi.advanceTimersByTime(SYNC_REBUILD_INTERVAL_MS);
    expect(map.builds).toBe(2);
    expect(pods(map.graph)).toBe(15);
  });

  it('rebuilds every live change at once after the sync', () => {
    const map = syncMap(2, 20);
    map.complete();
    const before = map.builds;
    map.change();
    map.change();
    expect(map.builds).toBe(before + 2);
    expect(pods(map.graph)).toBe(12);
  });

  it('rebuilds at once when the structure changes, even while syncing', () => {
    const memo = new CoalescedMemo<string>(
      () => undefined,
      250,
      () => Date.now(),
    );
    expect(memo.get(['a'], [1], true, true, () => 'a1')).toBe('a1');
    expect(memo.get(['a'], [2], true, true, () => 'a2')).toBe('a1');
    expect(memo.get(['b'], [2], true, true, () => 'b2')).toBe('b2');
  });

  it('keeps the previous value while inactive and schedules nothing', () => {
    const due = vi.fn();
    const memo = new CoalescedMemo<string>(due, 250, () => Date.now());
    memo.get(['a'], [1], true, true, () => 'a1');
    memo.get(['a'], [2], true, true, () => 'a2');
    expect(memo.get(['a'], [3], false, true, () => 'a3')).toBe('a1');
    vi.advanceTimersByTime(1000);
    expect(due).not.toHaveBeenCalled();
    // On resume the changed data rebuilds (the interval has passed).
    expect(memo.get(['a'], [3], true, true, () => 'a3')).toBe('a3');
  });
});
