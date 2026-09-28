import type { HealthInput, HealthKind, HealthLists } from './types';

/**
 * Test helper: a scan input with every list empty and loaded. Never imported
 * by app code. Typed as a full `Record<HealthKind, …>`, so a new kind fails
 * to compile until it is added here.
 */
const EMPTY_LISTS: Record<HealthKind, readonly never[]> = {
  pods: [],
  deployments: [],
  statefulSets: [],
  daemonSets: [],
  jobs: [],
  cronJobs: [],
  services: [],
  ingresses: [],
  configMaps: [],
  secrets: [],
  serviceAccounts: [],
  pvcs: [],
  pdbs: [],
  hpas: [],
  nodes: [],
  certificates: [],
  namespaces: [],
  roles: [],
  clusterRoles: [],
  roleBindings: [],
  clusterRoleBindings: [],
  issuers: [],
  clusterIssuers: [],
  gateways: [],
  validatingWebhooks: [],
  mutatingWebhooks: [],
  gitRepositories: [],
  helmRepositories: [],
  ociRepositories: [],
  kustomizations: [],
  helmReleases: [],
  fluxProviders: [],
};

export function emptyHealthInput(overrides: Partial<HealthInput> = {}): HealthInput {
  const lists: HealthLists = { ...EMPTY_LISTS };
  return {
    ...lists,
    loaded: new Set(Object.keys(EMPTY_LISTS) as HealthKind[]),
    now: 0,
    ...overrides,
  };
}
