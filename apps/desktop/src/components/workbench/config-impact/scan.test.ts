import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Gvk, KubeObject } from '@/types';

const fixtures = vi.hoisted(() => ({ connected: true, list: vi.fn() }));
vi.mock('@/lib/ipc', () => ({ ipc: { resourceList: fixtures.list } }));
vi.mock('@/store/useAppStore', () => ({
  useAppStore: {
    getState: () => ({
      statuses: { fixture: { state: fixtures.connected ? 'connected' : 'disconnected' } },
    }),
  },
}));
import { scanConfigImpact } from './scan';

const target = { kind: 'ConfigMap' as const, namespace: 'app', name: 'config' };
const changes = [{ key: 'url', operation: 'changed' as const }];
afterEach(() => {
  fixtures.list.mockReset();
  fixtures.connected = true;
  vi.useRealTimers();
});

describe('configuration impact snapshot reads', () => {
  it('carries object-level reference mode through the scan for empty configurations', async () => {
    fixtures.list.mockImplementation(async (_id: string, gvk: Gvk) => ({
      resource_version: '1',
      items:
        gvk.kind === 'Deployment'
          ? [
              {
                apiVersion: 'apps/v1',
                kind: 'Deployment',
                metadata: { name: 'api', namespace: 'app', uid: 'api', resourceVersion: '1' },
                spec: {
                  template: {
                    spec: {
                      containers: [
                        { name: 'api', envFrom: [{ configMapRef: { name: 'config' } }] },
                      ],
                    },
                  },
                },
              },
            ]
          : [],
    }));
    expect(
      (await scanConfigImpact('fixture', target, [], 'all-references')).consumers,
    ).toHaveLength(1);
    expect((await scanConfigImpact('fixture', target, [])).consumers).toEqual([]);
  });

  it('does not connect or issue resource requests while offline', async () => {
    fixtures.connected = false;
    const result = await scanConfigImpact('fixture', target, changes);
    expect(fixtures.list).not.toHaveBeenCalled();
    expect(result.sources).toHaveLength(8);
    expect(result.sources.every((source) => source.state === 'unavailable')).toBe(true);
  });

  it('keeps accessible evidence when another kind is forbidden and reports object limits', async () => {
    fixtures.list.mockImplementation(async (_id: string, gvk: Gvk, namespace: string) => {
      expect(namespace).toBe('app');
      expect(['Secret', 'ConfigMap']).not.toContain(gvk.kind);
      if (gvk.kind === 'Job') throw new Error('forbidden fixture');
      const items: KubeObject[] =
        gvk.kind === 'Deployment'
          ? Array.from({ length: 501 }, (_, index) => ({
              apiVersion: 'apps/v1',
              kind: 'Deployment',
              metadata: {
                name: `api-${index}`,
                namespace,
                uid: String(index),
                resourceVersion: '1',
              },
              spec: {
                template: {
                  spec: {
                    containers: [{ name: 'api', envFrom: [{ configMapRef: { name: 'config' } }] }],
                  },
                },
              },
            }))
          : [];
      return { items, resource_version: '1' };
    });
    const result = await scanConfigImpact('fixture', target, changes);
    expect(result.sources.find((source) => source.kind === 'Deployment')).toMatchObject({
      state: 'limited',
      inspected: 500,
    });
    expect(result.sources.find((source) => source.kind === 'Job')).toMatchObject({
      state: 'unavailable',
      error: 'forbidden fixture',
    });
    expect(result.inspected).toBe(500);
    expect(result.consumers).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });

  it('finishes after the total deadline when API reads never resolve', async () => {
    vi.useFakeTimers();
    fixtures.list.mockImplementation(() => new Promise(() => {}));
    const pending = scanConfigImpact('fixture', target, changes);
    await vi.advanceTimersByTimeAsync(25_000);
    const result = await pending;
    expect(result.sources.every((source) => source.state === 'unavailable')).toBe(true);
    expect(fixtures.list.mock.calls.length).toBeLessThanOrEqual(6);
    expect(result.consumers).toEqual([]);
  });
});
