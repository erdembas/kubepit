import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STARTUP_UPDATE_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
  startUpdateScheduler,
} from './scheduler';

describe('automatic update scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('checks after the startup grace period, then every five minutes', async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    const stop = startUpdateScheduler(check);
    await vi.advanceTimersByTimeAsync(STARTUP_UPDATE_DELAY_MS - 1);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 3);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('never overlaps a slow check, and cleanup during a request prevents rescheduling', async () => {
    let resolve!: () => void;
    const check = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const stop = startUpdateScheduler(check);
    await vi.advanceTimersByTimeAsync(STARTUP_UPDATE_DELAY_MS + UPDATE_CHECK_INTERVAL_MS * 4);
    expect(check).toHaveBeenCalledTimes(1);
    stop();
    resolve();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 4);
    expect(check).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers from a rejected check and cancels an unstarted startup timer', async () => {
    const check = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const cancelled = startUpdateScheduler(check);
    cancelled();
    await vi.advanceTimersByTimeAsync(STARTUP_UPDATE_DELAY_MS);
    expect(check).not.toHaveBeenCalled();
    const stop = startUpdateScheduler(check);
    await vi.advanceTimersByTimeAsync(STARTUP_UPDATE_DELAY_MS + UPDATE_CHECK_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(2);
    stop();
  });
});
