import type { KubeObject } from '@/types';
import type { CrdInput } from './crds';
import { list, put, type ClusterDb } from './db';
import { BOOT, DAY, MIN, hashString, meta, obj } from './util';

/**
 * Policy report demo data (`wgpolicyk8s.io/v1alpha2`) as Kyverno writes
 * it: one PolicyReport per scanned workload (scope pointing at the object
 * that was evaluated) and one ClusterPolicyReport for cluster-scoped
 * objects, with results derived from the actual demo data so failures
 * match what runs there.
 */

export const POLICY_CLUSTERS = new Set(['c-prod-eu', 'c-staging']);

export function hasPolicyReports(db: ClusterDb): boolean {
  return POLICY_CLUSTERS.has(db.profile.id);
}

const GROUP = 'wgpolicyk8s.io';
const API = `${GROUP}/v1alpha2`;

// ---------------------------------------------------------------------------
// CRDs
// ---------------------------------------------------------------------------

export function policyReportCrds(db: ClusterDb): CrdInput[] {
  if (!hasPolicyReports(db)) return [];
  return [
    {
      group: GROUP,
      kind: 'PolicyReport',
      plural: 'policyreports',
      singular: 'policyreport',
      shortNames: ['polr', 'polrs'],
      scope: 'Namespaced',
      versions: ['v1alpha2'],
      categories: ['all'],
      columns: [
        {
          name: 'Kind',
          type: 'string',
          jsonPath: '.scope.kind',
          priority: 1,
        },
        {
          name: 'Fail',
          type: 'integer',
          jsonPath: '.summary.fail',
        },
        {
          name: 'Error',
          type: 'integer',
          jsonPath: '.summary.error',
        },
        {
          name: 'Warn',
          type: 'integer',
          jsonPath: '.summary.warn',
        },
        {
          name: 'Pass',
          type: 'integer',
          jsonPath: '.summary.pass',
        },
        {
          name: 'Age',
          type: 'date',
          jsonPath: '.metadata.creationTimestamp',
        },
      ],
      age: 45 * DAY,
    },
    {
      group: GROUP,
      kind: 'ClusterPolicyReport',
      plural: 'clusterpolicyreports',
      singular: 'clusterpolicyreport',
      shortNames: ['cpolr', 'cpolrs'],
      scope: 'Cluster',
      versions: ['v1alpha2'],
      categories: ['all'],
      age: 45 * DAY,
    },
  ];
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

type ResultValue = 'pass' | 'fail' | 'warn';
type Severity = 'critical' | 'high' | 'medium' | 'low';

interface DraftResult {
  policy: string;
  rule: string;
  result: ResultValue;
  severity?: Severity;
  message: string;
  category: string;
}

const AGO_MS = 42 * MIN;
const ts = { seconds: Math.floor((BOOT - AGO_MS) / 1000), nanos: 0 };

function hexId(seed: string, n = 10): string {
  return hashString(seed).toString(16).padStart(n, '0').slice(0, n);
}

interface Summary {
  pass: number;
  fail: number;
  warn: number;
  error: number;
  skip: number;
}

function summarize(results: DraftResult[]): Summary {
  const s: Summary = { pass: 0, fail: 0, warn: 0, error: 0, skip: 0 };
  for (const r of results) s[r.result]++;
  return s;
}

function putReport(
  db: ClusterDb,
  kind: 'PolicyReport' | 'ClusterPolicyReport',
  name: string,
  namespace: string | null,
  scope: { apiVersion: string; kind: string; name: string; namespace?: string },
  results: DraftResult[],
) {
  put(
    db,
    obj(
      API,
      kind,
      meta({
        name,
        ...(namespace ? { namespace } : {}),
        age: AGO_MS,
        labels: {
          'app.kubernetes.io/managed-by': 'kyverno',
          'app.kubernetes.io/instance': 'kyverno',
        },
      }),
      {
        scope: {
          apiVersion: scope.apiVersion,
          kind: scope.kind,
          name: scope.name,
          ...(scope.namespace ? { namespace: scope.namespace } : {}),
        },
        results: results.map((r) => ({
          policy: r.policy,
          rule: r.rule,
          result: r.result,
          ...(r.severity ? { severity: r.severity } : {}),
          message: r.message,
          category: r.category,
          timestamp: ts,
        })),
        summary: summarize(results),
      },
    ),
  );
}

// ---------------------------------------------------------------------------
// Workload policies (results derived from the demo workloads)
// ---------------------------------------------------------------------------

interface Container {
  name?: unknown;
  image?: unknown;
  securityContext?: Record<string, unknown>;
  resources?: Record<string, unknown>;
}

interface Template {
  metadata?: { labels?: Record<string, string> } | null;
  spec?: { containers?: Container[]; initContainers?: Container[] } | null;
}

const ALLOWED_REGISTRY_PREFIXES = [
  'ghcr.io/acme/',
  'docker.io/library/',
  'registry.k8s.io/',
  'quay.io/prometheus',
  'quay.io/kiwigrid',
  'public.ecr.aws/',
];

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function templateOf(kind: string, o: KubeObject): Template | null {
  const spec = (o.spec ?? {}) as Record<string, unknown>;
  if (kind === 'CronJob') {
    const job = (spec.jobTemplate ?? {}) as Record<string, unknown>;
    const pod = (job.spec ?? {}) as Record<string, unknown>;
    return (pod.template ?? null) as Template | null;
  }
  return (spec.template ?? null) as Template | null;
}

function containerList(t: Template | null): Container[] {
  return [...(t?.spec?.containers ?? []), ...(t?.spec?.initContainers ?? [])];
}

function registryAllowed(image: string): boolean {
  return ALLOWED_REGISTRY_PREFIXES.some((p) => image.startsWith(p));
}

function workloadResults(o: KubeObject): DraftResult[] {
  const t = templateOf(o.kind, o);
  const containers = containerList(t);
  const labels = t?.metadata?.labels ?? {};
  const results: DraftResult[] = [];
  const name = `${o.metadata.namespace ?? ''}/${o.metadata.name}`;

  // require-team-label
  results.push(
    labels.team
      ? {
          policy: 'require-team-label',
          rule: 'check-team-label',
          result: 'pass',
          message: 'pod template has a "team" label',
          category: 'Governance',
        }
      : {
          policy: 'require-team-label',
          rule: 'check-team-label',
          result: 'fail',
          severity: 'medium',
          message: `${o.kind} "${name}" has no "team" label`,
          category: 'Governance',
        },
  );

  // disallow-privileged-containers
  const privileged = containers.filter((c) => {
    const sc = c.securityContext ?? {};
    const caps = ((sc.capabilities as Record<string, unknown> | undefined)?.add ?? []) as unknown[];
    const risky = caps.some(
      (x) => typeof x === 'string' && ['NET_ADMIN', 'NET_RAW', 'SYS_ADMIN'].includes(x),
    );
    return sc.privileged === true || risky;
  });
  results.push(
    privileged.length
      ? {
          policy: 'disallow-privileged-containers',
          rule: 'privileged-containers',
          result: 'fail',
          severity: 'high',
          message: `privileged container(s): ${privileged.map((c) => text(c.name)).join(', ')}`,
          category: 'Pod Security',
        }
      : {
          policy: 'disallow-privileged-containers',
          rule: 'privileged-containers',
          result: 'pass',
          message: 'no privileged containers',
          category: 'Pod Security',
        },
  );

  // restrict-image-registries
  const unapproved = containers.filter((c) => !registryAllowed(text(c.image)));
  results.push(
    unapproved.length
      ? {
          policy: 'restrict-image-registries',
          rule: 'validate-registries',
          result: 'fail',
          severity: 'high',
          message: `image from an unapproved registry: ${text(unapproved[0]!.image)}`,
          category: 'Supply Chain',
        }
      : {
          policy: 'restrict-image-registries',
          rule: 'validate-registries',
          result: 'pass',
          message: 'every image comes from an approved registry',
          category: 'Supply Chain',
        },
  );

  // disallow-latest-tag
  const latest = containers.filter((c) => text(c.image).endsWith(':latest'));
  results.push(
    latest.length
      ? {
          policy: 'disallow-latest-tag',
          rule: 'require-image-tag',
          result: 'fail',
          severity: 'medium',
          message: `image uses a mutable tag: ${text(latest[0]!.image)}`,
          category: 'Supply Chain',
        }
      : {
          policy: 'disallow-latest-tag',
          rule: 'require-image-tag',
          result: 'pass',
          message: 'every image pins a tag',
          category: 'Supply Chain',
        },
  );

  // require-resource-requests
  const missing = containers.filter((c) => {
    const requests = ((c.resources ?? {}).requests ?? {}) as Record<string, unknown>;
    return !requests.cpu || !requests.memory;
  });
  results.push(
    missing.length
      ? {
          policy: 'require-resource-requests',
          rule: 'validate-resources',
          result: 'warn',
          severity: 'low',
          message: `container(s) without cpu/memory requests: ${missing
            .map((c) => text(c.name))
            .join(', ')}`,
          category: 'Reliability',
        }
      : {
          policy: 'require-resource-requests',
          rule: 'validate-resources',
          result: 'pass',
          message: 'every container requests cpu and memory',
          category: 'Reliability',
        },
  );

  return results;
}

// ---------------------------------------------------------------------------
// Cluster policies
// ---------------------------------------------------------------------------

function clusterResults(db: ClusterDb): Array<{
  scope: { apiVersion: string; kind: string; name: string; namespace?: string };
  results: DraftResult[];
}> {
  const out: Array<{ scope: { apiVersion: string; kind: string; name: string }; results: DraftResult[] }> =
    [];

  for (const role of list(db, 'clusterroles.rbac.authorization.k8s.io')) {
    const rules = ((role.rules ?? []) as Array<Record<string, unknown>>).filter((r) => {
      const verbs = (r.verbs ?? []) as unknown[];
      const resources = (r.resources ?? []) as unknown[];
      return verbs.includes('*') || resources.includes('*');
    });
    out.push({
      scope: { apiVersion: role.apiVersion, kind: 'ClusterRole', name: role.metadata.name },
      results: [
        rules.length
          ? {
              policy: 'restrict-wildcard-verbs',
              rule: 'wildcard-verbs',
              result: 'fail',
              severity: 'high',
              message: `ClusterRole "${role.metadata.name}" uses * verbs or resources`,
              category: 'RBAC',
            }
          : {
              policy: 'restrict-wildcard-verbs',
              rule: 'wildcard-verbs',
              result: 'pass',
              message: 'no wildcard verbs or resources',
              category: 'RBAC',
            },
      ],
    });
  }

  let namespaces = 0;
  for (const ns of list(db, 'namespaces')) {
    if (namespaces >= 40) break;
    namespaces++;
    const has = !!ns.metadata.labels?.team;
    out.push({
      scope: { apiVersion: 'v1', kind: 'Namespace', name: ns.metadata.name },
      results: [
        has
          ? {
              policy: 'require-namespace-ownership',
              rule: 'check-owner',
              result: 'pass',
              message: 'namespace has an owning team',
              category: 'Governance',
            }
          : {
              policy: 'require-namespace-ownership',
              rule: 'check-owner',
              result: 'fail',
              severity: 'low',
              message: `namespace "${ns.metadata.name}" has no "team" label`,
              category: 'Governance',
            },
      ],
    });
  }

  return out;
}

// ---------------------------------------------------------------------------

const WORKLOAD_KINDS = [
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'cronjobs.batch',
] as const;

export function buildPolicyReports(db: ClusterDb) {
  if (!hasPolicyReports(db)) return;
  for (const key of WORKLOAD_KINDS) {
    for (const o of list(db, key)) {
      if (o.metadata.namespace === 'kube-system') continue;
      if (!templateOf(o.kind, o)) continue;
      putReport(
        db,
        'PolicyReport',
        `pol-${hexId(`${db.id}|${key}|${o.metadata.namespace}|${o.metadata.name}`)}`,
        o.metadata.namespace ?? null,
        {
          apiVersion: o.apiVersion,
          kind: o.kind,
          name: o.metadata.name,
          namespace: o.metadata.namespace ?? undefined,
        },
        workloadResults(o),
      );
    }
  }
  // One ClusterPolicyReport per cluster-scoped object, like Kyverno writes
  // them (a report's `scope` names one object).
  let clusterReports = 0;
  for (const entry of clusterResults(db)) {
    if (clusterReports >= 60) break;
    clusterReports++;
    putReport(
      db,
      'ClusterPolicyReport',
      `cpol-${hexId(`${db.id}|${entry.scope.kind}|${entry.scope.name}`)}`,
      null,
      entry.scope,
      entry.results,
    );
  }
}
