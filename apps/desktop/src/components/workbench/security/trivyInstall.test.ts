import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResourceInfo } from '@/types';

const ipc = vi.hoisted(() => ({
  helmRepoList: vi.fn(),
  helmRepoAdd: vi.fn(),
  helmRepoUpdate: vi.fn(),
  helmInstall: vi.fn(),
  apiResourcesRefresh: vi.fn(),
}));
vi.mock('@/lib/ipc', () => ({ ipc, events: {} }));
// The real workbench store persists to localStorage, which Node lacks.
const setApiResources = vi.hoisted(() => vi.fn());
vi.mock('@/store/useWorkbenchStore', () => ({
  useWorkbenchStore: { getState: () => ({ setApiResources }) },
}));

const { useAppStore } = await import('@/store/useAppStore');
const { installTrivy, useTrivyInstallStore } = await import('./trivyInstall');

const pushToast = vi.fn();
const state = () => useTrivyInstallStore.getState().byCluster.c1;

function resource(group: string, kind: string): ApiResourceInfo {
  return {
    group,
    version: 'v1alpha1',
    kind,
    plural: `${kind.toLowerCase()}s`,
    namespaced: true,
    api_version: `${group}/v1alpha1`,
    verbs: ['list', 'watch'],
    short_names: [],
    categories: [],
  };
}
const WITHOUT = [resource('', 'Pod')];
const WITH = [...WITHOUT, resource('aquasecurity.github.io', 'VulnerabilityReport')];

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ pushToast, statuses: { c1: { state: 'connected' } } as never });
  useTrivyInstallStore.setState({ byCluster: {} });
  ipc.helmRepoList.mockResolvedValue([]);
  ipc.helmRepoAdd.mockResolvedValue(undefined);
  ipc.helmRepoUpdate.mockResolvedValue([]);
  ipc.helmInstall.mockResolvedValue({ release: null });
  ipc.apiResourcesRefresh.mockResolvedValue(WITH);
});

afterEach(() => vi.useRealTimers());

describe('installTrivy', () => {
  it('adds the repository, installs the chart and rediscovers', async () => {
    await installTrivy('c1');
    expect(ipc.helmRepoAdd).toHaveBeenCalledWith(
      'aqua',
      'https://aquasecurity.github.io/helm-charts/',
      expect.objectContaining({ username: null, force_update: false }),
    );
    expect(ipc.helmRepoUpdate).not.toHaveBeenCalled();
    expect(ipc.helmInstall).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ chart_ref: 'aqua/trivy-operator', namespace: 'trivy-system' }),
    );
    expect(setApiResources).toHaveBeenCalledWith('c1', WITH);
    expect(state()).toBeUndefined();
    expect(pushToast).toHaveBeenCalledWith('success', expect.any(String));
  });

  it('updates a configured repository instead of adding it', async () => {
    ipc.helmRepoList.mockResolvedValue([
      { name: 'aquasec', url: 'https://aquasecurity.github.io/helm-charts' },
    ]);
    ipc.helmRepoUpdate.mockResolvedValue([{ name: 'aquasec', ok: true, error: null }]);
    await installTrivy('c1');
    expect(ipc.helmRepoAdd).not.toHaveBeenCalled();
    expect(ipc.helmRepoUpdate).toHaveBeenCalledWith(['aquasec']);
    expect(ipc.helmInstall.mock.calls[0]![1].chart_ref).toBe('aquasec/trivy-operator');
  });

  it('installs from a stale index when the repository update fails', async () => {
    ipc.helmRepoList.mockResolvedValue([
      { name: 'aqua', url: 'https://aquasecurity.github.io/helm-charts/' },
    ]);
    ipc.helmRepoUpdate.mockRejectedValue(new Error('helm repo update failed: offline'));
    await installTrivy('c1');
    expect(ipc.helmInstall).toHaveBeenCalledTimes(1);
    expect(state()).toBeUndefined();
  });

  it('does not reconnect a cluster disconnected during the install', async () => {
    ipc.helmInstall.mockImplementation(async () => {
      useAppStore.setState({ statuses: { c1: { state: 'disconnected' } } as never });
      return { release: null };
    });
    await installTrivy('c1');
    expect(ipc.apiResourcesRefresh).not.toHaveBeenCalled();
    expect(state()).toBeUndefined();
    expect(pushToast).toHaveBeenCalledWith('success', expect.any(String));
  });

  it('reports a failed install and starts over on retry', async () => {
    ipc.helmInstall.mockRejectedValueOnce(new Error('timed out waiting for the condition'));
    await installTrivy('c1');
    expect(state()).toEqual({
      status: 'failed',
      step: 'install',
      error: 'timed out waiting for the condition',
    });
    expect(ipc.apiResourcesRefresh).not.toHaveBeenCalled();
    await installTrivy('c1');
    expect(ipc.helmRepoList).toHaveBeenCalledTimes(2);
    expect(ipc.helmInstall).toHaveBeenCalledTimes(2);
    expect(state()).toBeUndefined();
  });

  it('only rediscovers when the chart installed but its CRDs were not served', async () => {
    vi.useFakeTimers();
    ipc.apiResourcesRefresh.mockResolvedValue(WITHOUT);
    const run = installTrivy('c1');
    await vi.runAllTimersAsync();
    await run;
    expect(ipc.apiResourcesRefresh).toHaveBeenCalledTimes(5);
    expect(state()).toMatchObject({ status: 'failed', step: 'discover' });

    ipc.apiResourcesRefresh.mockResolvedValue(WITH);
    await installTrivy('c1');
    expect(ipc.helmInstall).toHaveBeenCalledTimes(1);
    expect(state()).toBeUndefined();
  });

  it('ignores a second click while an install runs', async () => {
    let finish!: () => void;
    ipc.helmInstall.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const first = installTrivy('c1');
    await vi.waitFor(() => expect(state()).toMatchObject({ status: 'running', step: 'install' }));
    await installTrivy('c1');
    finish();
    await first;
    expect(ipc.helmRepoList).toHaveBeenCalledTimes(1);
    expect(ipc.helmInstall).toHaveBeenCalledTimes(1);
  });
});
