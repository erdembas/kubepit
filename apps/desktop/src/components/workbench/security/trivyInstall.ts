import * as i18n from '@/i18n/core';
import { create } from 'zustand';
import { ipc } from '@/lib/ipc';
import { TRIVY_REPO_URL, detectTrivy, trivyInstallRequest, trivyRepoPlan } from '@/lib/kube/trivy';
import { useAppStore } from '@/store/useAppStore';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo, ClusterId } from '@/types';
import { refreshPolledPrefix } from '../data/polled';
import { errorText } from '../util';

/**
 * One-click Trivy Operator install (Security view): add or update the aqua
 * Helm repository, `helm install` the chart (audited, read-only guarded in
 * the backend), then rediscover the API so the new CRDs switch the view to
 * the reports. State lives per cluster outside the component, so leaving
 * the view neither loses the progress nor allows a second install.
 */

/** Polled "is an operator Deployment running" check of the Security view. */
export const trivyOperatorKey = (clusterId: ClusterId) => `${clusterId}|trivy-operator`;

export type TrivyInstallStep = 'repo' | 'install' | 'discover';

export type TrivyInstallState =
  | { status: 'running'; step: TrivyInstallStep; startedAt: number }
  | { status: 'failed'; step: TrivyInstallStep; error: string };

export const useTrivyInstallStore = create<{ byCluster: Record<ClusterId, TrivyInstallState> }>(
  () => ({ byCluster: {} }),
);

/** Discovery attempts after the install (CRDs are normally served at once). */
const DISCOVER_ATTEMPTS = 5;
const DISCOVER_RETRY_MS = 2000;

function setState(clusterId: ClusterId, state: TrivyInstallState | null) {
  useTrivyInstallStore.setState((s) => {
    const byCluster = { ...s.byCluster };
    if (state) byCluster[clusterId] = state;
    else delete byCluster[clusterId];
    return { byCluster };
  });
}

async function publishDiscovery(clusterId: ClusterId, resources: ApiResourceInfo[]) {
  useWorkbenchStore.getState().setApiResources(clusterId, resources);
  // The per-connection discovery hook re-reads the (now fresh) backend cache;
  // waiting for it keeps the install card from flashing back meanwhile.
  await refreshPolledPrefix(`${clusterId}|api-resources|`);
  await refreshPolledPrefix(trivyOperatorKey(clusterId));
}

const connected = (clusterId: ClusterId) =>
  useAppStore.getState().statuses[clusterId]?.state === 'connected';

async function discover(clusterId: ClusterId) {
  for (let attempt = 1; ; attempt++) {
    // Discovery would reconnect a cluster the user disconnected meanwhile;
    // the next connect discovers the new kinds anyway.
    if (!connected(clusterId)) return;
    const resources = await ipc.apiResourcesRefresh(clusterId);
    if (detectTrivy(resources)) return publishDiscovery(clusterId, resources);
    if (attempt >= DISCOVER_ATTEMPTS)
      throw new Error(
        i18n.t(
          'Trivy Operator is installed, but the cluster does not serve its report resources yet.',
        ),
      );
    await new Promise((resolve) => setTimeout(resolve, DISCOVER_RETRY_MS));
  }
}

async function installChart(clusterId: ClusterId) {
  const plan = trivyRepoPlan(await ipc.helmRepoList());
  if (plan.add) {
    await ipc.helmRepoAdd(plan.name, TRIVY_REPO_URL, {
      username: null,
      password: null,
      insecure_skip_tls_verify: false,
      pass_credentials: false,
      force_update: false,
    });
  } else {
    // A stale index still installs; when it cannot, helm install says why.
    await ipc.helmRepoUpdate([plan.name]).catch(() => undefined);
  }
  void refreshPolledPrefix('helm-charts|');
  setState(clusterId, { status: 'running', step: 'install', startedAt: Date.now() });
  await ipc.helmInstall(clusterId, trivyInstallRequest(plan.name));
  void refreshPolledPrefix(`${clusterId}|helm-`);
}

/**
 * Run the install; calling it again after a failure retries. A failed
 * discovery only rediscovers (the chart is installed); anything earlier
 * starts over, which works because helm rolls a failed install back (its
 * CRDs stay, and the next install skips them).
 */
export async function installTrivy(clusterId: ClusterId) {
  const current = useTrivyInstallStore.getState().byCluster[clusterId];
  if (current?.status === 'running') return;
  let step: TrivyInstallStep = current?.step === 'discover' ? 'discover' : 'repo';
  setState(clusterId, { status: 'running', step, startedAt: Date.now() });
  try {
    if (step !== 'discover') {
      await installChart(clusterId);
      step = 'discover';
      setState(clusterId, { status: 'running', step, startedAt: Date.now() });
    }
    await discover(clusterId);
    setState(clusterId, null);
    useAppStore
      .getState()
      .pushToast(
        'success',
        i18n.t('Trivy Operator installed. Reports appear as the first scans finish.'),
      );
  } catch (e) {
    setState(clusterId, {
      status: 'failed',
      step: useTrivyInstallStore.getState().byCluster[clusterId]?.step ?? step,
      error: errorText(e),
    });
  }
}
