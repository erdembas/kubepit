import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResourceInfo, GatewayApiCrdsManifest } from '@/types';

const ipc = vi.hoisted(() => ({
  gatewayApiCrdsManifest: vi.fn(),
  resourceApplyYaml: vi.fn(),
  apiResourcesRefresh: vi.fn(),
}));
vi.mock('@/lib/ipc', () => ({ ipc, events: {} }));
// The real workbench store persists to localStorage, which Node lacks.
const setApiResources = vi.hoisted(() => vi.fn());
vi.mock('@/store/useWorkbenchStore', () => ({
  useWorkbenchStore: { getState: () => ({ setApiResources }) },
}));

const { useAppStore } = await import('@/store/useAppStore');
const { installGatewayCrds, retriesDiscoverOnly, useCrdInstallStore } =
  await import('./crdInstall');

const pushToast = vi.fn();
const state = () => useCrdInstallStore.getState().byCluster.c1;

const GATEWAY: ApiResourceInfo = {
  group: 'gateway.networking.k8s.io',
  version: 'v1',
  kind: 'Gateway',
  plural: 'gateways',
  namespaced: true,
  api_version: 'gateway.networking.k8s.io/v1',
  verbs: ['list', 'watch'],
  short_names: [],
  categories: [],
};
const MANIFEST: GatewayApiCrdsManifest = {
  version: 'v1.7.0',
  channel: 'standard',
  url: 'https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.7.0/standard-install.yaml',
  yaml: 'apiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\n',
  bytes: 64,
  crds: ['gateways.gateway.networking.k8s.io'],
  others: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ pushToast, statuses: { c1: { state: 'connected' } } as never });
  useCrdInstallStore.setState({ byCluster: {} });
  ipc.gatewayApiCrdsManifest.mockResolvedValue(MANIFEST);
  ipc.resourceApplyYaml.mockResolvedValue([]);
  ipc.apiResourcesRefresh.mockResolvedValue([GATEWAY]);
});

describe('installGatewayCrds', () => {
  it('downloads, applies with server-side apply and rediscovers', async () => {
    await installGatewayCrds('c1', 'standard', ' v1.7.0 ');
    expect(ipc.gatewayApiCrdsManifest).toHaveBeenCalledWith('standard', 'v1.7.0');
    expect(ipc.resourceApplyYaml).toHaveBeenCalledWith('c1', MANIFEST.yaml, 'apply', null);
    expect(setApiResources).toHaveBeenCalledWith('c1', [GATEWAY]);
    expect(state()).toBeUndefined();
    expect(pushToast).toHaveBeenCalledWith('success', expect.any(String));
  });

  it('refuses an invalid version without calling the backend', async () => {
    await installGatewayCrds('c1', 'standard', 'v1.0.0');
    expect(ipc.gatewayApiCrdsManifest).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ status: 'failed', step: 'download' });
  });

  it('fails (instead of reporting success) when the cluster disconnected before discovery', async () => {
    ipc.resourceApplyYaml.mockImplementation(async () => {
      useAppStore.setState({ statuses: { c1: { state: 'disconnected' } } as never });
      return [];
    });
    await installGatewayCrds('c1', 'standard', 'v1.7.0');
    expect(state()).toMatchObject({ status: 'failed', step: 'discover' });
    expect(pushToast).not.toHaveBeenCalled();
  });

  it('retries only discovery for the same manifest, everything for another one', async () => {
    useCrdInstallStore.setState({
      byCluster: {
        c1: {
          status: 'failed',
          step: 'discover',
          channel: 'standard',
          version: 'v1.7.0',
          manifest: MANIFEST,
          error: 'not served yet',
        },
      },
    });
    const current = state();
    expect(retriesDiscoverOnly(current, 'standard', 'v1.7.0 ')).toBe(true);
    expect(retriesDiscoverOnly(current, 'standard', 'v1.5.0')).toBe(false);
    expect(retriesDiscoverOnly(current, 'experimental', 'v1.7.0')).toBe(false);

    await installGatewayCrds('c1', 'standard', 'v1.7.0');
    expect(ipc.resourceApplyYaml).not.toHaveBeenCalled();
    expect(ipc.apiResourcesRefresh).toHaveBeenCalled();

    useCrdInstallStore.setState({ byCluster: { c1: { ...current!, status: 'failed' } as never } });
    await installGatewayCrds('c1', 'experimental', 'v1.7.0');
    expect(ipc.gatewayApiCrdsManifest).toHaveBeenCalledWith('experimental', 'v1.7.0');
    expect(ipc.resourceApplyYaml).toHaveBeenCalledTimes(1);
  });
});
