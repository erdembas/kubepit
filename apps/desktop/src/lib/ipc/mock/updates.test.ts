import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { UpdateInfo } from '@/types';
import type { MockHandler } from './registry';

let handlers: Record<string, MockHandler>;
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('window', globalThis);
  ({ handlers } = await import('./registry'));
  await import('./updates');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('refuses an unreviewed version before emitting any installation progress', async () => {
  const onEvent = vi.fn();
  await expect(
    handlers.update_install!({ expectedVersion: 'wrong-version', onEvent }),
  ).rejects.toThrow('The available update changed.');
  expect(onEvent).not.toHaveBeenCalled();
});

it('simulates installation only for the exact reviewed version and then reports no update', async () => {
  const checking = handlers.update_check!({}) as Promise<UpdateInfo>;
  await vi.advanceTimersByTimeAsync(700);
  const update = await checking;
  const onEvent = vi.fn();
  const installing = handlers.update_install!({ expectedVersion: update.version, onEvent });
  await vi.advanceTimersByTimeAsync(3400);
  await installing;
  expect(onEvent).toHaveBeenLastCalledWith({ event: 'finished' });
  const rechecking = handlers.update_check!({});
  await vi.advanceTimersByTimeAsync(700);
  expect(await rechecking).toBeNull();
});
