import { describe, expect, it } from 'vitest';
import { pausedMemo, topologyDataKey } from './dataKey';

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
