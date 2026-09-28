import { afterEach, describe, expect, it, vi } from 'vitest';

describe('probe', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });
  it('probe is inert when disabled', async () => {
    vi.stubGlobal('window', { location: { search: '' }, localStorage: { getItem: () => null } });
    const mark = vi.fn();
    vi.stubGlobal('performance', { mark, now: () => 0 });
    const p = await import('./probe');
    const { installPerfGlobal } = await import('./global');
    p.perfMark('table:navigate');
    p.recordDuration('watch:apply', 3);
    p.recordWatchCommit({ arrivedAt: 1, applyMs: 1, flushStart: 1, items: 1 });
    installPerfGlobal({} as never);
    await Promise.resolve();
    expect(mark).not.toHaveBeenCalled();
    expect(p.perfReport().durations).toEqual({});
    expect((globalThis.window as { __kubepitPerf?: unknown }).__kubepitPerf).toBeUndefined();
  });
  it('records durations when enabled with ?perf=1', async () => {
    vi.stubGlobal('window', {
      location: { search: '?perf=1' },
      localStorage: { getItem: () => null },
    });
    vi.stubGlobal('performance', { mark: vi.fn(), now: () => 0 });
    const p = await import('./probe');
    p.recordDuration('watch:apply', 3);
    p.recordDuration('watch:apply', 5);
    expect(p.perfReport().durations['watch:apply']).toEqual([3, 5]);
  });
  it('is enabled by the stored switch and exposes the driver', async () => {
    vi.stubGlobal('window', {
      location: { search: '' },
      localStorage: { getItem: (key: string) => (key === 'kubepit.perf' ? '1' : null) },
    });
    vi.stubGlobal('performance', { mark: vi.fn(), now: () => 0 });
    const { installPerfGlobal } = await import('./global');
    const driver = { reset: () => undefined };
    installPerfGlobal(driver as never);
    expect((globalThis.window as { __kubepitPerf?: unknown }).__kubepitPerf).toBe(driver);
  });
  it('records watch:apply after the commit the emit scheduled, without the frame wait', async () => {
    vi.stubGlobal('window', {
      location: { search: '?perf=1' },
      localStorage: { getItem: () => null },
    });
    let now = 0;
    vi.stubGlobal('performance', { mark: vi.fn(), now: () => now });
    const p = await import('./probe');
    // A batch arrived at 100 ms (applying it took 2 ms); the frame flushed at 114 ms.
    const flushStart = 114;
    now = 115;
    // The emit: React queues its sync render, which commits in 5 ms.
    queueMicrotask(() => (now += 5));
    p.recordWatchCommit({ arrivedAt: 100, applyMs: 2, flushStart, items: 20_000 });
    await Promise.resolve();
    await Promise.resolve();
    const { values, details } = p.perfSamples('watch:apply');
    expect(values).toEqual([8]);
    expect(details[0]).toEqual({
      items: 20_000,
      applyMs: 2,
      flushMs: 1,
      commitMs: 5,
      latencyMs: 20,
    });
  });
  it('records time to first rows and to synced once per navigation, after the commit', async () => {
    vi.stubGlobal('window', {
      location: { search: '?perf=1' },
      localStorage: { getItem: () => null },
    });
    let now = 100;
    vi.stubGlobal('performance', { mark: vi.fn(), now: () => now });
    const p = await import('./probe');
    p.perfTableRendered('pods', 10, false);
    p.perfTableNavigate('pods');
    now = 150;
    p.perfTableRendered('services', 5, true);
    p.perfTableRendered('pods', 0, false);
    p.perfTableRendered('pods', 500, false);
    now = 180;
    await Promise.resolve();
    now = 400;
    p.perfTableRendered('pods', 1000, true);
    p.perfTableRendered('pods', 1000, true);
    now = 420;
    await Promise.resolve();
    expect(p.perfReport().durations).toEqual({ 'table:ttfr': [80], 'table:synced': [320] });
  });
  it('waits for the next record', async () => {
    vi.stubGlobal('window', {
      location: { search: '?perf=1' },
      localStorage: { getItem: () => null },
    });
    vi.stubGlobal('performance', { mark: vi.fn(), now: () => 0 });
    const p = await import('./probe');
    const next = p.nextRecord('health:scan', 1000);
    p.recordDuration('map:view', 1);
    p.recordDuration('health:scan', 42);
    await expect(next).resolves.toBe(42);
  });
  it('keeps a bounded number of samples', async () => {
    vi.stubGlobal('window', {
      location: { search: '?perf=1' },
      localStorage: { getItem: () => null },
    });
    vi.stubGlobal('performance', { mark: vi.fn(), now: () => 0 });
    const p = await import('./probe');
    for (let i = 0; i < 10_001; i++) p.recordDuration('watch:apply', i, { items: i });
    const { values, details } = p.perfSamples('watch:apply');
    expect(values.length).toBe(5_001);
    expect(values[0]).toBe(5_000);
    expect(details[0]).toEqual({ items: 5_000 });
  });
});
