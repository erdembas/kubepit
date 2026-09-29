import type { AccessCheck, HelmInstallRequest, HelmRepo } from '@/types';
import { TRIVY_CHART, TRIVY_NAMESPACE, TRIVY_RELEASE, TRIVY_REPO_URL } from './kinds';

/**
 * One-click install of Trivy Operator from the Security view: the same
 * `helm repo add` + `helm install` as the upstream guide, through the
 * user's helm configuration (so the repository shows up in the helm CLI and
 * the Helm Charts view too).
 */

/** Names tried, in order, when the repository has to be added. */
const REPO_NAMES = ['aqua', 'aquasecurity'];

const sameUrl = (a: string, b: string) =>
  a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase();

export interface TrivyRepoPlan {
  /** Repository name the chart is installed from. */
  name: string;
  /** `true` → `helm repo add`; `false` → it is configured, `helm repo update` it. */
  add: boolean;
}

/** The configured repository serving the chart, else a free name to add it under. */
export function trivyRepoPlan(repos: readonly HelmRepo[]): TrivyRepoPlan {
  const existing = repos.find((r) => sameUrl(r.url, TRIVY_REPO_URL));
  if (existing) return { name: existing.name, add: false };
  const taken = new Set(repos.map((r) => r.name));
  let name = REPO_NAMES.find((n) => !taken.has(n));
  for (let i = 2; !name; i++) if (!taken.has(`aqua-${i}`)) name = `aqua-${i}`;
  return { name, add: true };
}

export function trivyInstallRequest(repoName: string): HelmInstallRequest {
  return {
    release_name: TRIVY_RELEASE,
    namespace: TRIVY_NAMESPACE,
    chart_ref: `${repoName}/${TRIVY_CHART}`,
    version: null,
    values_yaml: '',
    create_namespace: true,
    // Waiting means the CRDs are served once helm returns. A failed install
    // is rolled back so "Try again" can reinstall; helm keeps the chart's
    // CRDs (crds/) and the namespace, though.
    wait: true,
    atomic: true,
    timeout_secs: 600,
    description: 'Installed from the Kubepit Security view',
    dry_run: false,
  };
}

/** Cluster-wide objects the chart creates: its CRDs and the operator's RBAC. */
export const TRIVY_INSTALL_ACCESS: readonly AccessCheck[] = [
  { verb: 'create', group: 'apiextensions.k8s.io', resource: 'customresourcedefinitions' },
  { verb: 'create', group: 'rbac.authorization.k8s.io', resource: 'clusterroles' },
  { verb: 'create', group: 'rbac.authorization.k8s.io', resource: 'clusterrolebindings' },
];
