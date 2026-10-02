import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResourceInfo, HelmRepo } from '@/types';

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
const {
  installOperator,
  useOperatorInstallStore,
  TRIVY_OPERATOR,
  KYVERNO_OPERATOR,
} = await import('./operatorInstall');

const pushToast = vi.fn();
const state = (id: string) => useOperatorInstallStore.getState().byCluster.c1?.[id];

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
const WITH_TRIVY = [...WITHOUT, resource('aquasecurity.github.io', 'VulnerabilityReport')];
const WITH_POLICY = [...WITHOUT, resource('wgpolicyk8s.io', 'PolicyReport')];
const WITH_BOTH = [...WITH_TRIVY, resource('wgpolicyk8s.io', 'PolicyReport')];

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ pushToast, statuses: { c1: { state: 'connected' } } as never });
  useOperatorInstallStore.setState({ byCluster: {} });
  ipc.helmRepoList.mockResolvedValue([]);
  ipc.helmRepoAdd.mockResolvedValue(undefined);
  ipc.helmRepoUpdate.mockResolvedValue([]);
  ipc.helmInstall.mockResolvedValue({ release: null });
  ipc.apiResourcesRefresh.mockResolvedValue(WITH_TRIVY);
});

afterEach(() => vi.useRealTimers());

describe('installOperator (Trivy)', () => {
  it('adds the repository, installs the chart and rediscovers', async () => {
    await installOperator('c1', TRIVY_OPERATOR);
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
    expect(setApiResources).toHaveBeenCalledWith('c1', WITH_TRIVY);
    expect(state('trivy')).toBeUndefined();
    expect(pushToast).toHaveBeenCalledWith('success', expect.any(String));
  });

  it('updates a configured repository instead of adding it', async () => {
    ipc.helmRepoList.mockResolvedValue([
      { name: 'aquasec', url: 'https://aquasecurity.github.io/helm-charts' },
    ]);
    ipc.helmRepoUpdate.mockResolvedValue([{ name: 'aquasec', ok: true, error: null }]);
    await installOperator('c1', TRIVY_OPERATOR);
    expect(ipc.helmRepoAdd).not.toHaveBeenCalled();
    expect(ipc.helmRepoUpdate).toHaveBeenCalledWith(['aquasec']);
    expect(ipc.helmInstall.mock.calls[0]![1].chart_ref).toBe('aquasec/trivy-operator');
  });

  it('installs from a stale index when the repository update fails', async () => {
    ipc.helmRepoList.mockResolvedValue([
      { name: 'aqua', url: 'https://aquasecurity.github.io/helm-charts/' },
    ] as HelmRepo[]);
    ipc.helmRepoUpdate.mockRejectedValue(new Error('helm repo update failed: offline'));
    await installOperator('c1', TRIVY_OPERATOR);
    expect(ipc.helmInstall).toHaveBeenCalledTimes(1);
    expect(state('trivy')).toBeUndefined();
  });

  it('does not reconnect a cluster disconnected during the install', async () => {
    ipc.helmInstall.mockImplementation(async () => {
      useAppStore.setState({ statuses: { c1: { state: 'disconnected' } } as never });
      return { release: null };
    });
    await installOperator('c1', TRIVY_OPERATOR);
    expect(ipc.apiResourcesRefresh).not.toHaveBeenCalled();
    expect(state('trivy')).toBeUndefined();
    expect(pushToast).toHaveBeenCalledWith('success', expect.any(String));
  });

  it('reports a failed install and starts over on retry', async () => {
    ipc.helmInstall.mockRejectedValueOnce(new Error('timed out waiting for the condition'));
    await installOperator('c1', TRIVY_OPERATOR);
    expect(state('trivy')).toEqual({
      status: 'failed',
      step: 'install',
      error: 'timed out waiting for the condition',
    });
    expect(ipc.apiResourcesRefresh).not.toHaveBeenCalled();
    await installOperator('c1', TRIVY_OPERATOR);
    expect(ipc.helmRepoList).toHaveBeenCalledTimes(2);
    expect(ipc.helmInstall).toHaveBeenCalledTimes(2);
    expect(state('trivy')).toBeUndefined();
  });

  it('only rediscovers when the chart installed but its CRDs were not served', async () => {
    vi.useFakeTimers();
    ipc.apiResourcesRefresh.mockResolvedValue(WITHOUT);
    const run = installOperator('c1', TRIVY_OPERATOR);
    await vi.runAllTimersAsync();
    await run;
    expect(ipc.apiResourcesRefresh).toHaveBeenCalledTimes(5);
    expect(state('trivy')).toMatchObject({ status: 'failed', step: 'discover' });

    ipc.apiResourcesRefresh.mockResolvedValue(WITH_TRIVY);
    await installOperator('c1', TRIVY_OPERATOR);
    expect(ipc.helmInstall).toHaveBeenCalledTimes(1);
    expect(state('trivy')).toBeUndefined();
  });

  it('ignores a second click while an install runs', async () => {
    let finish!: () => void;
    ipc.helmInstall.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const first = installOperator('c1', TRIVY_OPERATOR);
    await vi.waitFor(() => expect(state('trivy')).toMatchObject({ status: 'running', step: 'install' }));
    await installOperator('c1', TRIVY_OPERATOR);
    finish();
    await first;
    expect(ipc.helmRepoList).toHaveBeenCalledTimes(1);
    expect(ipc.helmInstall).toHaveBeenCalledTimes(1);
  });
});

describe('installOperator (Kyverno)', () => {
  beforeEach(() => {
    ipc.apiResourcesRefresh.mockResolvedValue(WITH_POLICY);
  });

  it('adds the kyverno repository and installs the chart into kyverno', async () => {
    await installOperator('c1', KYVERNO_OPERATOR);
    expect(ipc.helmRepoAdd).toHaveBeenCalledWith(
      'kyverno',
      'https://kyverno.github.io/kyverno',
      expect.objectContaining({ force_update: false }),
    );
    expect(ipc.helmInstall).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({
        release_name: 'kyverno',
        chart_ref: 'kyverno/kyverno',
        namespace: 'kyverno',
        create_namespace: true,
        wait: true,
        atomic: true,
      }),
    );
    expect(state('kyverno')).toBeUndefined();
    expect(pushToast).toHaveBeenCalledWith('success', expect.any(String));
  });

  it('reuses a configured repository and keeps installs independent per operator', async () => {
    ipc.helmRepoList.mockResolvedValue([
      { name: 'policies', url: 'https://kyverno.github.io/kyverno/' },
    ]);
    ipc.apiResourcesRefresh.mockResolvedValue(WITH_BOTH);
    await installOperator('c1', KYVERNO_OPERATOR);
    expect(ipc.helmRepoAdd).not.toHaveBeenCalled();
    expect(ipc.helmRepoUpdate).toHaveBeenCalledWith(['policies']);
    expect(ipc.helmInstall.mock.calls[0]![1].chart_ref).toBe('policies/kyverno');
    // A finished Kyverno install does not block a Trivy install.
    expect(state('kyverno')).toBeUndefined();
    await installOperator('c1', TRIVY_OPERATOR);
    expect(ipc.helmInstall).toHaveBeenCalledTimes(2);
  });

  it('fails when the policy report kinds never appear', async () => {
    vi.useFakeTimers();
    ipc.apiResourcesRefresh.mockResolvedValue(WITHOUT);
    const run = installOperator('c1', KYVERNO_OPERATOR);
    await vi.runAllTimersAsync();
    await run;
    expect(state('kyverno')).toMatchObject({ status: 'failed', step: 'discover' });
  });
});
