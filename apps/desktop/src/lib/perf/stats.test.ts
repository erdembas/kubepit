import { describe, expect, it } from 'vitest';
import { fpsReport, percentile } from './stats';

describe('perf stats', () => {
  it('percentile uses nearest rank', () => {
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(percentile([], 50)).toBeNaN();
  });
  it('fpsReport turns frame times into fps and long frames', () => {
    const r = fpsReport([...Array(60).fill(16.7), 80]);
    expect(r.frames).toBe(61);
    expect(Math.round(r.medianFps)).toBe(60);
    expect(r.p95FrameMs).toBeCloseTo(16.7);
    expect(r.longFrames).toBe(1);
  });
  it('fpsReport of no frames is empty', () => {
    expect(fpsReport([])).toEqual({ frames: 0, medianFps: 0, p95FrameMs: 0, longFrames: 0 });
  });
});
