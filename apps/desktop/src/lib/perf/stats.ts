/** Probe math (pure): percentiles and frame-time reports. */

/** Nearest-rank percentile (`p` in 0–100); `NaN` for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)]!;
}

export interface FpsReport {
  frames: number;
  /** 1000 ÷ the median frame time. */
  medianFps: number;
  p95FrameMs: number;
  /** Frames longer than {@link LONG_FRAME_MS}. */
  longFrames: number;
}

/** A frame longer than this is a visible stall. */
export const LONG_FRAME_MS = 50;

/** Frame times (ms between animation frames) → fps and stalls. */
export function fpsReport(frameTimesMs: readonly number[]): FpsReport {
  const median = percentile(frameTimesMs, 50);
  return {
    frames: frameTimesMs.length,
    medianFps: median > 0 ? 1000 / median : 0,
    p95FrameMs: frameTimesMs.length ? percentile(frameTimesMs, 95) : 0,
    longFrames: frameTimesMs.filter((ms) => ms > LONG_FRAME_MS).length,
  };
}
