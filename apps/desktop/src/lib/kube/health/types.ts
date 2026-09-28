import type { HealthIgnore, KubeObject, RightsizingReport } from '@/types';

export type { HealthIgnore };

/**
 * Cluster health checks (Popeye-style). Rules are pure functions over the
 * resource lists the workbench already watches; every problem becomes a
 * `Finding` attached to one object.
 */

export type Severity = 'critical' | 'warning' | 'info';
export type Category = 'reliability' | 'security' | 'efficiency' | 'hygiene';

export const SEVERITIES: readonly Severity[] = ['critical', 'warning', 'info'];
export const CATEGORIES: readonly Category[] = ['reliability', 'security', 'efficiency', 'hygiene'];

/** Resource lists a scan reads (watch keys of the health view). */
export type HealthKind =
  | 'pods'
  | 'deployments'
  | 'statefulSets'
  | 'daemonSets'
  | 'jobs'
  | 'cronJobs'
  | 'services'
  | 'ingresses'
  | 'configMaps'
  | 'secrets'
  | 'serviceAccounts'
  | 'pvcs'
  | 'pdbs'
  | 'hpas'
  | 'nodes'
  | 'certificates'
  // Security: Pod Security labels and RBAC objects.
  | 'namespaces'
  | 'roles'
  | 'clusterRoles'
  | 'roleBindings'
  | 'clusterRoleBindings'
  // Controllers that read Secrets through the API (secret-unused references).
  | 'issuers'
  | 'clusterIssuers'
  | 'gateways'
  | 'validatingWebhooks'
  | 'mutatingWebhooks'
  | 'gitRepositories'
  | 'helmRepositories'
  | 'ociRepositories'
  | 'kustomizations'
  | 'helmReleases'
  | 'fluxProviders';

export type HealthLists = Record<HealthKind, readonly KubeObject[]>;

export interface HealthInput extends HealthLists {
  /** Lists that loaded completely; rules that need a missing list are skipped. */
  loaded: ReadonlySet<HealthKind>;
  now: number;
  /** Cost insight: the last right-sizing report, when one was loaded. */
  rightsizing?: RightsizingReport | null;
}

export interface FindingRef {
  apiVersion: string;
  kind: string;
  namespace: string | null;
  name: string;
  uid: string;
}

export interface Finding {
  /** Stable per rule, object and detail (container, key…). */
  id: string;
  ruleId: string;
  severity: Severity;
  category: Category;
  ref: FindingRef;
  /** Translated when the scan ran. */
  message: string;
  /** Overrides the rule's fix hint when set. */
  hint?: string;
}

export interface RuleGroup {
  ruleId: string;
  severity: Severity;
  category: Category;
  findings: Finding[];
  /** Findings before the per-rule cap. */
  total: number;
}

export interface HealthSummary {
  /** 0–100, Popeye-style: mean of per-kind scores. */
  score: number;
  grade: string;
  counts: Record<Severity, number>;
  categories: Record<Category, number>;
  groups: RuleGroup[];
  byUid: ReadonlyMap<string, Finding[]>;
  ignored: number;
}

/** Raw result of one scan (before ignores). */
export interface HealthScan {
  findings: Finding[];
  /** Objects scanned per kind (kind → uids), the denominator of the score. */
  scanned: Map<string, number>;
  /** Findings dropped by the per-rule cap. */
  overflow: Map<string, number>;
  skippedKinds: HealthKind[];
  computedAt: number;
}
