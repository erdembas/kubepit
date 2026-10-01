import { describe, expect, it, vi } from 'vitest';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import type { KubeObject } from '@/types';

vi.mock('@/lib/ipc', () => ({ ipc: {} }));
vi.mock('@/store/useAccessStore', () => ({ reviewNow: vi.fn() }));
vi.mock('@/store/useAppStore', () => ({ useAppStore: { getState: vi.fn() } }));
import { applyReviewedConfig, restartReviewedConsumer, type MutationDependencies } from './actions';

const config: KubeObject = {
  kind: 'ConfigMap',
  apiVersion: 'v1',
  metadata: { name: 'config', namespace: 'app', uid: 'config-uid', resourceVersion: '2' },
  data: { url: 'old' },
};
const controller: KubeObject = {
  kind: 'Deployment',
  apiVersion: 'apps/v1',
  metadata: { name: 'api', namespace: 'app', uid: 'controller-uid', resourceVersion: '6' },
  spec: { template: { spec: { containers: [{ name: 'api', image: 'example:v1' }] } } },
};
const configGvk = toGvk(BUILTIN.ConfigMap);
const workloadGvk = toGvk(BUILTIN.Deployment);
function dependencies(live: KubeObject) {
  return {
    guard: vi.fn(),
    access: vi.fn(async () => {}),
    get: vi.fn(async () => structuredClone(live)),
    patch: vi.fn(async () => live),
  } satisfies MutationDependencies;
}

describe('reviewed configuration mutations', () => {
  it('rejects a changed or replaced configuration before issuing any patch', async () => {
    for (const metadata of [{ resourceVersion: '3' }, { uid: 'replacement' }]) {
      const deps = dependencies({ ...config, metadata: { ...config.metadata, ...metadata } });
      await expect(
        applyReviewedConfig('fixture', configGvk, config, { data: { url: 'new' } }, deps),
      ).rejects.toThrow('changed after review');
      expect(deps.patch).not.toHaveBeenCalled();
    }
  });

  it('includes the reviewed version and UID in the atomic config patch', async () => {
    const deps = dependencies(config);
    await applyReviewedConfig(
      'fixture',
      configGvk,
      config,
      { data: { url: 'new' }, metadata: { resourceVersion: 'unsafe' } },
      deps,
    );
    expect(deps.patch).toHaveBeenCalledWith(
      'fixture',
      configGvk,
      'app',
      'config',
      {
        data: { url: 'new' },
        metadata: { uid: 'config-uid', resourceVersion: '2' },
      },
      'merge',
    );
    expect(deps.guard).toHaveBeenCalledTimes(2);
  });

  it('enforces a read-only or permission denial without changing a workload', async () => {
    const readOnly = dependencies(controller);
    readOnly.guard.mockImplementation(() => {
      throw new Error('read-only');
    });
    await expect(
      restartReviewedConsumer('fixture', workloadGvk, controller, 'now', readOnly),
    ).rejects.toThrow('read-only');
    expect(readOnly.get).not.toHaveBeenCalled();
    const denied = dependencies(controller);
    denied.access.mockRejectedValue(new Error('denied'));
    await expect(
      restartReviewedConsumer('fixture', workloadGvk, controller, 'now', denied),
    ).rejects.toThrow('denied');
    expect(denied.patch).not.toHaveBeenCalled();
  });

  it('allows status progress but uses the freshest version to protect the restart patch', async () => {
    const deps = dependencies({
      ...controller,
      metadata: { ...controller.metadata, resourceVersion: '9' },
      status: { readyReplicas: 2 },
    });
    await restartReviewedConsumer('fixture', workloadGvk, controller, '2026-10-01T00:00:00Z', deps);
    expect(deps.patch).toHaveBeenCalledWith(
      'fixture',
      workloadGvk,
      'app',
      'api',
      {
        metadata: { uid: 'controller-uid', resourceVersion: '9' },
        spec: {
          template: {
            metadata: {
              annotations: { 'kubectl.kubernetes.io/restartedAt': '2026-10-01T00:00:00Z' },
            },
          },
        },
      },
      'merge',
    );
  });

  it('refuses workload replacement or spec changes after review', async () => {
    for (const live of [
      { ...controller, metadata: { ...controller.metadata, uid: 'new-controller' } },
      { ...controller, spec: { ...controller.spec, replicas: 0 } },
      {
        ...controller,
        metadata: {
          ...controller.metadata,
          annotations: { 'argocd.argoproj.io/tracking-id': 'new-owner' },
        },
      },
    ]) {
      const deps = dependencies(live);
      await expect(
        restartReviewedConsumer('fixture', workloadGvk, controller, 'now', deps),
      ).rejects.toThrow('changed after review');
      expect(deps.patch).not.toHaveBeenCalled();
    }
  });
});
