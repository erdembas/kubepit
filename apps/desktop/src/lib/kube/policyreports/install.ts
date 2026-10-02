import type { AccessCheck, HelmInstallRequest, HelmRepo } from '@/types';

/**
 * One-click install of Kyverno from the Security view's Policy reports
 * tab: the same `helm repo add` + `helm install` as the upstream guide,
 * through the user's helm configuration (so the repository shows up in
 * the helm CLI and the Helm Charts view too). Kyverno writes the
 * `wgpolicyk8s.io` reports this tab reads; any other engine writing them
 * works without it.
 */

export const KYVERNO_REPO_URL = 'https://kyverno.github.io/kyverno';
export const KYVERNO_CHART = 'kyverno';
export const KYVERNO_RELEASE = 'kyverno';
export const KYVERNO_NAMESPACE = 'kyverno';
export const KYVERNO_INSTALL_URL = 'https://kyverno.io/docs/installation/';

export const KYVERNO_HELM_INSTALL = `helm repo add kyverno ${KYVERNO_REPO_URL}
helm repo update
helm install ${KYVERNO_RELEASE} kyverno/${KYVERNO_CHART} \\
  --namespace ${KYVERNO_NAMESPACE} --create-namespace`;

/** Names tried, in order, when the repository has to be added. */
const REPO_NAMES = ['kyverno'];

const sameUrl = (a: string, b: string) =>
  a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase();

/** The configured repository serving the chart, else a free name to add it under. */
export function kyvernoRepoPlan(repos: readonly HelmRepo[]): { name: string; add: boolean } {
  const existing = repos.find((r) => sameUrl(r.url, KYVERNO_REPO_URL));
  if (existing) return { name: existing.name, add: false };
  const taken = new Set(repos.map((r) => r.name));
  let name = REPO_NAMES.find((n) => !taken.has(n));
  for (let i = 2; !name; i++) if (!taken.has(`kyverno-${i}`)) name = `kyverno-${i}`;
  return { name, add: true };
}

export function kyvernoInstallRequest(repoName: string): HelmInstallRequest {
  return {
    release_name: KYVERNO_RELEASE,
    namespace: KYVERNO_NAMESPACE,
    chart_ref: `${repoName}/${KYVERNO_CHART}`,
    version: null,
    values_yaml: '',
    create_namespace: true,
    // Waiting means the CRDs (including the policy report kinds this view
    // reads) are served once helm returns. A failed install is rolled back
    // so "Try again" can reinstall; helm keeps the chart's CRDs (crds/)
    // and the namespace, though.
    wait: true,
    atomic: true,
    timeout_secs: 600,
    description: 'Installed from the Kubepit Security view',
    dry_run: false,
  };
}

/** Cluster-wide objects the chart creates: its CRDs, RBAC and webhooks. */
export const KYVERNO_INSTALL_ACCESS: readonly AccessCheck[] = [
  { verb: 'create', group: 'apiextensions.k8s.io', resource: 'customresourcedefinitions' },
  { verb: 'create', group: 'rbac.authorization.k8s.io', resource: 'clusterroles' },
  { verb: 'create', group: 'rbac.authorization.k8s.io', resource: 'clusterrolebindings' },
  { verb: 'create', group: 'admissionregistration.k8s.io', resource: 'validatingwebhookconfigurations' },
];
