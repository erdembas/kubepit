import { describe, expect, it, vi } from 'vitest';
import type { AiAgentCatalog } from '@/types';
import { createAgentCatalogCache } from './agentCatalogCache';

const catalog: AiAgentCatalog = {
  kind: 'codex-cli',
  models: [],
  default_model: null,
  authenticated: null,
  auth_method: null,
  version: 'fixture',
};

describe('native agent catalog cache', () => {
  it('shares a pending probe and fresh results across consumers', async () => {
    const cache = createAgentCatalogCache();
    let resolve!: (value: AiAgentCatalog) => void;
    const loader = vi.fn(
      () =>
        new Promise<AiAgentCatalog>((done) => {
          resolve = done;
        }),
    );
    const notified = vi.fn();
    const unsubscribe = cache.subscribe('codex-cli', notified);
    const first = cache.load('codex-cli', loader);
    const second = cache.load('codex-cli', loader);
    expect(second).toBe(first);
    expect(cache.snapshot('codex-cli').status).toBe('loading');
    await Promise.resolve();
    resolve(catalog);
    await first;
    expect(await cache.load('codex-cli', loader)).toBe(catalog);
    expect(loader).toHaveBeenCalledExactlyOnceWith(false);
    expect(notified).toHaveBeenCalledTimes(2);
    unsubscribe();
    expect(cache.snapshot('claude-cli').catalog).toBeNull();
  });

  it('refreshes expired data, keeps stale models on failure, and retries only on request', async () => {
    let now = 0;
    const cache = createAgentCatalogCache(100, () => now);
    const loader = vi
      .fn()
      .mockResolvedValueOnce(catalog)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ...catalog, version: 'new' });
    await cache.load('codex-cli', loader);
    now = 101;
    const refresh = cache.load('codex-cli', loader);
    expect(cache.snapshot('codex-cli')).toMatchObject({ status: 'loading', catalog, stale: true });
    await expect(refresh).rejects.toThrow('offline');
    expect(cache.snapshot('codex-cli')).toMatchObject({
      status: 'error',
      catalog,
      stale: true,
      error: 'offline',
      updatedAt: 0,
    });
    await expect(cache.load('codex-cli', loader)).rejects.toThrow('offline');
    expect(loader).toHaveBeenCalledTimes(2);
    await cache.load('codex-cli', loader, true);
    expect(loader.mock.calls.map(([force]) => force)).toEqual([false, true, true]);
    expect(cache.snapshot('codex-cli')).toMatchObject({
      status: 'ready',
      stale: false,
      error: null,
      catalog: { version: 'new' },
    });
  });

  it('isolates kinds and handles synchronous probe failures without retry loops', async () => {
    const cache = createAgentCatalogCache();
    const loader = vi.fn(() => {
      throw new Error('not installed');
    });
    await expect(cache.load('claude-cli', loader)).rejects.toThrow('not installed');
    await expect(cache.load('claude-cli', loader)).rejects.toThrow('not installed');
    await cache.load('codex-cli', async () => catalog);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.snapshot('claude-cli')).toMatchObject({
      status: 'error',
      catalog: null,
      stale: false,
    });
    expect(cache.snapshot('codex-cli').status).toBe('ready');
  });
});
