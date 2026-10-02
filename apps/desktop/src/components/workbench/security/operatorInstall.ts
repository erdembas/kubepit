import * as i18n from '@/i18n/core';
import { create } from 'zustand';
import { ipc } from '@/lib/ipc';
import {
  TRIVY_CHART,
  TRIVY_NAMESPACE,
  TRIVY_RELEASE,
  TRIVY_REPO_URL,
  detectTrivy,
  trivyInstallRequest,
  trivyRepoPlan,
} from '@/lib/kube/trivy';
import {
  KYVERNO_CHART,
  KYVERNO_NAMESPACE,
  KYVERNO_RELEASE,
  KYVERNO_REPO_URL,
  detectPolicyReports,
  kyvernoInstallRequest,
  kyvernoRepoPlan,
} from '@/lib/kube/policyreports';
import { useAppStore } from '@/store/useAppStore';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo, ClusterId, HelmInstallRequest, HelmRepo } from '@/types';
import { refreshPolledPrefix } from '../data/polled';
import { errorText } from '../util';

/**
 * One-click operator install (Security view): add or update the operator's
 * Helm repository, `helm install` the chart (audited, read-only guarded in
 * the backend), then rediscover the API so the new CRDs switch the view to
 * the reports. One flow serves every operator — Trivy Operator and Kyverno
 * today — from a spec object. State lives per cluster outside the
 * component, so leaving the view neither loses the progress nor allows a
 * second install.
 */

/** Polled "is an operator Deployment running" check of the Security view. */
export const trivyOperatorKey = (clusterId: ClusterId) => `${clusterId}|trivy-operator`;

export type OperatorInstallStep = 'repo' | 'install' | 'discover';

export type OperatorInstallState =
  | { status: 'running'; step: OperatorInstallStep; startedAt: number }
  | { status: 'failed'; step: OperatorInstallStep; error: string };

export interface OperatorSpec {
  id: string;
  repoUrl: string;
  /** Preferred repository name (shown in the steps when it has to be added). */
  repoLabel: string;
  chartName: string;
  namespace: string;
  releaseName: string;
  /** The configured repository serving the chart, else a free name to add it under. */
  repoPlan: (repos: readonly HelmRepo[]) => { name: string; add: boolean };
  request: (repoName: string) => HelmInstallRequest;
  /** True when discovery serves the operator's report kinds. */
  detect: (resources: readonly ApiResourceInfo[]) => boolean;
  notServedYet(): string;
  installedToast(): string;
}

export const useOperatorInstallStore = create<{
  byCluster: Record<ClusterId, Record<string, OperatorInstallState>>;
}>(() => ({ byCluster: {} }));

/** Discovery attempts after the install (CRDs are normally served at once). */
const DISCOVER_ATTEMPTS = 5;
const DISCOVER_RETRY_MS = 2000;

function setState(clusterId: ClusterId, id: string, state: OperatorInstallState | null) {
  useOperatorInstallStore.setState((s) => {
    const ops = { ...(s.byCluster[clusterId] ?? {}) };
    if (state) ops[id] = state;
    else delete ops[id];
    return { byCluster: { ...s.byCluster, [clusterId]: ops } };
  });
}

export function useOperatorInstall(clusterId: ClusterId, spec: OperatorSpec) {
  return useOperatorInstallStore((s) => s.byCluster[clusterId]?.[spec.id]);
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

async function discover(clusterId: ClusterId, spec: OperatorSpec) {
  for (let attempt = 1; ; attempt++) {
    // Discovery would reconnect a cluster the user disconnected meanwhile;
    // the next connect discovers the new kinds anyway.
    if (!connected(clusterId)) return;
    const resources = await ipc.apiResourcesRefresh(clusterId);
    if (spec.detect(resources)) return publishDiscovery(clusterId, resources);
    if (attempt >= DISCOVER_ATTEMPTS) throw new Error(spec.notServedYet());
    await new Promise((resolve) => setTimeout(resolve, DISCOVER_RETRY_MS));
  }
}

async function installChart(clusterId: ClusterId, spec: OperatorSpec) {
  const plan = spec.repoPlan(await ipc.helmRepoList());
  if (plan.add) {
    await ipc.helmRepoAdd(plan.name, spec.repoUrl, {
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
  setState(clusterId, spec.id, { status: 'running', step: 'install', startedAt: Date.now() });
  await ipc.helmInstall(clusterId, spec.request(plan.name));
  void refreshPolledPrefix(`${clusterId}|helm-`);
}

/**
 * Run the install; calling it again after a failure retries. A failed
 * discovery only rediscovers (the chart is installed); anything earlier
 * starts over, which works because helm rolls a failed install back (its
 * CRDs stay, and the next install skips them).
 */
export async function installOperator(clusterId: ClusterId, spec: OperatorSpec) {
  const current = useOperatorInstallStore.getState().byCluster[clusterId]?.[spec.id];
  if (current?.status === 'running') return;
  let step: OperatorInstallStep = current?.step === 'discover' ? 'discover' : 'repo';
  setState(clusterId, spec.id, { status: 'running', step, startedAt: Date.now() });
  try {
    if (step !== 'discover') {
      await installChart(clusterId, spec);
      step = 'discover';
      setState(clusterId, spec.id, { status: 'running', step, startedAt: Date.now() });
    }
    await discover(clusterId, spec);
    setState(clusterId, spec.id, null);
    useAppStore.getState().pushToast('success', spec.installedToast());
  } catch (e) {
    setState(clusterId, spec.id, {
      status: 'failed',
      step: useOperatorInstallStore.getState().byCluster[clusterId]?.[spec.id]?.step ?? step,
      error: errorText(e),
    });
  }
}

export const TRIVY_OPERATOR: OperatorSpec = {
  id: 'trivy',
  repoUrl: TRIVY_REPO_URL,
  repoLabel: 'aqua',
  chartName: TRIVY_CHART,
  namespace: TRIVY_NAMESPACE,
  releaseName: TRIVY_RELEASE,
  repoPlan: trivyRepoPlan,
  request: trivyInstallRequest,
  detect: detectTrivy,
  notServedYet: () =>
    i18n.t(
      'Trivy Operator is installed, but the cluster does not serve its report resources yet.',
    ),
  installedToast: () =>
    i18n.t('Trivy Operator installed. Reports appear as the first scans finish.'),
};

export const KYVERNO_OPERATOR: OperatorSpec = {
  id: 'kyverno',
  repoUrl: KYVERNO_REPO_URL,
  repoLabel: 'kyverno',
  chartName: KYVERNO_CHART,
  namespace: KYVERNO_NAMESPACE,
  releaseName: KYVERNO_RELEASE,
  repoPlan: kyvernoRepoPlan,
  request: kyvernoInstallRequest,
  detect: detectPolicyReports,
  notServedYet: () =>
    i18n.t('Kyverno is installed, but the cluster does not serve the policy report kinds yet.'),
  installedToast: () =>
    i18n.t('Kyverno installed. Policy reports appear once it has evaluated your policies.'),
};
