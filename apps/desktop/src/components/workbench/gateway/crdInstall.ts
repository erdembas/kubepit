import * as i18n from '@/i18n/core';
import { create } from 'zustand';
import { ipc } from '@/lib/ipc';
import { gatewayCrdsServed, validVersion } from '@/lib/kube/gateway';
import { useAppStore } from '@/store/useAppStore';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import type {
  ApiResourceInfo,
  ClusterId,
  GatewayApiChannel,
  GatewayApiCrdsManifest,
} from '@/types';
import { refreshPolledPrefix } from '../data/polled';
import { errorText } from '../util';

/**
 * One-click install (or upgrade) of the Gateway API CRDs: the backend
 * downloads and checks the release manifest, the CRDs are applied with
 * server-side apply through `resource_apply_yaml` (audited, refused on
 * read-only clusters), then discovery is refreshed until Gateways are
 * served. State lives per cluster outside the components, so leaving the
 * view keeps the progress and forbids a second run; a failed discovery
 * only rediscovers.
 */

export type CrdInstallStep = 'download' | 'apply' | 'discover';

export type CrdInstallState =
  | {
      status: 'running';
      step: CrdInstallStep;
      channel: GatewayApiChannel;
      version: string;
      manifest: GatewayApiCrdsManifest | null;
    }
  | {
      status: 'failed';
      step: CrdInstallStep;
      channel: GatewayApiChannel;
      version: string;
      manifest: GatewayApiCrdsManifest | null;
      error: string;
    };

export const useCrdInstallStore = create<{ byCluster: Record<ClusterId, CrdInstallState> }>(() => ({
  byCluster: {},
}));

export function useCrdInstall(clusterId: ClusterId) {
  return useCrdInstallStore((s) => s.byCluster[clusterId]);
}

function setState(clusterId: ClusterId, state: CrdInstallState | null) {
  useCrdInstallStore.setState((s) => {
    const byCluster = { ...s.byCluster };
    if (state) byCluster[clusterId] = state;
    else delete byCluster[clusterId];
    return { byCluster };
  });
}

/**
 * Whether running the install for `channel` / `version` now only repeats
 * discovery (the same manifest was applied, loading its kinds failed);
 * anything else downloads and applies again, which changes the cluster.
 */
export function retriesDiscoverOnly(
  state: CrdInstallState | undefined,
  channel: GatewayApiChannel,
  version: string,
): boolean {
  return (
    state?.status === 'failed' &&
    state.step === 'discover' &&
    state.channel === channel &&
    state.version === version.trim()
  );
}

/** Polled key of the installed bundle version (the Gateway CRD's annotations). */
export const installedBundleKey = (clusterId: ClusterId) => `${clusterId}|gateway-api-bundle`;

const DISCOVER_ATTEMPTS = 5;
const DISCOVER_RETRY_MS = 2000;

const connected = (clusterId: ClusterId) =>
  useAppStore.getState().statuses[clusterId]?.state === 'connected';

async function publishDiscovery(clusterId: ClusterId, resources: ApiResourceInfo[]) {
  useWorkbenchStore.getState().setApiResources(clusterId, resources);
  // The per-connection discovery hook re-reads the (now fresh) backend cache.
  await refreshPolledPrefix(`${clusterId}|api-resources|`);
  await refreshPolledPrefix(installedBundleKey(clusterId));
}

async function discover(clusterId: ClusterId) {
  for (let attempt = 1; ; attempt++) {
    // Discovery would reconnect a cluster the user disconnected meanwhile;
    // "Try again" after reconnecting only rediscovers.
    if (!connected(clusterId))
      throw new Error(
        i18n.t('The cluster was disconnected before the new resources could be loaded.'),
      );
    const resources = await ipc.apiResourcesRefresh(clusterId);
    if (gatewayCrdsServed(resources)) return publishDiscovery(clusterId, resources);
    if (attempt >= DISCOVER_ATTEMPTS)
      throw new Error(
        i18n.t('The CRDs were applied, but the cluster does not serve Gateways yet.'),
      );
    await new Promise((resolve) => setTimeout(resolve, DISCOVER_RETRY_MS));
  }
}

/**
 * Run the install; calling it again after a failure retries. A failed
 * discovery only rediscovers; a failed download or apply starts over
 * (server-side apply is idempotent, so a half-applied manifest is fine).
 */
export async function installGatewayCrds(
  clusterId: ClusterId,
  channel: GatewayApiChannel,
  version: string,
) {
  const current = useCrdInstallStore.getState().byCluster[clusterId];
  if (current?.status === 'running') return;
  const v = version.trim();
  if (!validVersion(v)) {
    setState(clusterId, {
      status: 'failed',
      step: 'download',
      channel,
      version: v,
      manifest: null,
      error: i18n.t('Enter a release version such as v1.7.0 (v1.1.0 or later).'),
    });
    return;
  }
  const retryDiscover = retriesDiscoverOnly(current, channel, v);
  let step: CrdInstallStep = retryDiscover ? 'discover' : 'download';
  let manifest: GatewayApiCrdsManifest | null = retryDiscover ? (current?.manifest ?? null) : null;
  const run = () => setState(clusterId, { status: 'running', step, channel, version: v, manifest });
  run();
  try {
    if (step === 'download') {
      manifest = await ipc.gatewayApiCrdsManifest(channel, v);
      step = 'apply';
      run();
      await ipc.resourceApplyYaml(clusterId, manifest.yaml, 'apply', null);
      step = 'discover';
      run();
    }
    await discover(clusterId);
    setState(clusterId, null);
    useAppStore
      .getState()
      .pushToast(
        'success',
        i18n.t('Gateway API {version} ({channel}) CRDs installed.', { version: v, channel }),
      );
  } catch (e) {
    setState(clusterId, {
      status: 'failed',
      step,
      channel,
      version: v,
      manifest,
      error: errorText(e),
    });
  }
}
