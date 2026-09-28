import YAML from 'yaml';
import {
  DEPRECATED_APIS,
  DEPRECATIONS_UPDATED,
  compareMinor,
  deprecatedApi,
  minorOf,
  nextMinor,
  parseMinor,
  type DeprecatedApi,
} from '@/lib/kube/deprecations';
import type {
  KubeObject,
  PrometheusStatus,
  UpgradeFinding,
  UpgradeReport,
  UpgradeScanOptions,
  UpgradeSource,
} from '@/types';
import { sleep } from './bus';
import { getDb, list, type ClusterDb } from './fixtures/db';
import { demoManagedFields } from './fixtures/upgrade';
import { handlers, register, type MockArgs } from './registry';

/**
 * Demo upgrade readiness scan (`upgrade_readiness_scan`), mirroring the
 * backend (`crates/kubepit-core/src/upgrade/`) over the demo objects: the
 * last-applied annotation, `managedFields` (kept aside by
 * `fixtures/upgrade.ts`), Helm release manifests, deprecated CRD versions
 * and — where the demo has Prometheus — the API server metric.
 */

const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';
const NOT_SCANNED = new Set([
  'Endpoints',
  'Event',
  'LocalSubjectAccessReview',
  'SelfSubjectAccessReview',
  'SelfSubjectRulesReview',
  'SubjectAccessReview',
  'TokenReview',
]);
const SCANNED_KINDS = new Set(
  DEPRECATED_APIS.map((e) => e.kind).filter((kind) => !NOT_SCANNED.has(kind)),
);

interface Versions {
  current: string;
  target: string;
}

function impact(entry: DeprecatedApi, v: Versions) {
  if (entry.removed_in && compareMinor(entry.removed_in, v.target) <= 0)
    return {
      severity: 'blocker' as const,
      already: compareMinor(entry.removed_in, v.current) <= 0,
    };
  if (compareMinor(entry.deprecated_in, v.target) <= 0)
    return { severity: 'warning' as const, already: false };
  return null;
}

function finding(entry: DeprecatedApi, v: Versions, source: UpgradeSource, id: string) {
  const how = impact(entry, v);
  if (!how) return null;
  const f: UpgradeFinding = {
    id,
    severity: how.severity,
    source,
    api_version: entry.api_version,
    kind: entry.kind,
    deprecated_in: entry.deprecated_in,
    removed_in: entry.removed_in,
    replacement: entry.replacement,
    replacement_kind: entry.replacement_kind ?? null,
    notes: [...entry.notes],
    already_removed: how.already,
    object: null,
    helm: null,
    managers: [],
    detail: null,
  };
  return f;
}

function objectFindings(db: ClusterDb, o: KubeObject, v: Versions): UpgradeFinding[] {
  const byVersion = new Map<string, { lastApplied: boolean; managers: Set<string> }>();
  const slot = (apiVersion: string) => {
    let s = byVersion.get(apiVersion);
    if (!s) byVersion.set(apiVersion, (s = { lastApplied: false, managers: new Set() }));
    return s;
  };
  const raw = o.metadata.annotations?.[LAST_APPLIED];
  if (raw) {
    try {
      const applied = (JSON.parse(raw) as { apiVersion?: string }).apiVersion;
      if (applied && deprecatedApi(applied, o.kind)) slot(applied).lastApplied = true;
    } catch {
      /* not JSON: ignored like the backend does */
    }
  }
  for (const m of demoManagedFields(db, o.metadata.uid))
    if (deprecatedApi(m.apiVersion, o.kind)) slot(m.apiVersion).managers.add(m.manager);
  const out: UpgradeFinding[] = [];
  for (const [apiVersion, s] of byVersion) {
    const entry = deprecatedApi(apiVersion, o.kind)!;
    const ns = o.metadata.namespace ?? null;
    const f = finding(
      entry,
      v,
      s.lastApplied ? 'last-applied' : 'managed-fields',
      `object|${apiVersion}|${o.kind}|${ns ?? ''}|${o.metadata.name}`,
    );
    if (!f) continue;
    f.object = { api_version: o.apiVersion, kind: o.kind, namespace: ns, name: o.metadata.name };
    f.managers = [...s.managers].sort();
    out.push(f);
  }
  return out;
}

export interface ManifestDoc {
  source: string | null;
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string | null;
  value: KubeObject;
}

/** Objects of a rendered manifest with helm's `# Source:` comment (like `split_manifest`). */
export function manifestDocs(manifest: string): ManifestDoc[] {
  const out: ManifestDoc[] = [];
  for (const chunk of manifest.split(/^---(?:[ \t].*)?$/m)) {
    if (!chunk.trim()) continue;
    let value: KubeObject | null = null;
    try {
      value = YAML.parse(chunk) as KubeObject | null;
    } catch {
      continue;
    }
    if (!value || typeof value !== 'object' || typeof value.kind !== 'string') continue;
    if (!value.metadata?.name) continue;
    out.push({
      source: /^#\s*Source:\s*(.+)$/m.exec(chunk)?.[1]?.trim() ?? null,
      apiVersion: String(value.apiVersion ?? ''),
      kind: value.kind,
      name: value.metadata.name,
      namespace: value.metadata.namespace ?? null,
      value,
    });
  }
  return out;
}

function helmFindings(
  db: ClusterDb,
  v: Versions,
): { findings: UpgradeFinding[]; releases: number } {
  const findings: UpgradeFinding[] = [];
  let releases = 0;
  for (const rec of db.helm.values()) {
    const latest = rec.history[rec.history.length - 1];
    if (!latest) continue;
    releases++;
    for (const doc of manifestDocs(rec.manifest)) {
      const entry = deprecatedApi(doc.apiVersion, doc.kind);
      if (!entry) continue;
      const namespace = doc.namespace ?? latest.namespace;
      const id = `helm|${latest.namespace}|${latest.name}|${doc.kind}|${namespace}|${doc.name}`;
      const f = finding(entry, v, 'helm-release', id);
      if (!f) continue;
      f.object = { api_version: doc.apiVersion, kind: doc.kind, namespace, name: doc.name };
      f.helm = {
        namespace: latest.namespace,
        name: latest.name,
        revision: latest.revision,
        chart: latest.chart,
        chart_version: latest.chart_version,
      };
      f.detail = doc.source;
      findings.push(f);
    }
  }
  return { findings, releases };
}

function crdFindings(crd: KubeObject): UpgradeFinding[] {
  const spec = crd.spec as {
    group: string;
    names: { kind: string };
    versions: Array<{
      name: string;
      served: boolean;
      deprecated?: boolean;
      deprecationWarning?: string;
    }>;
  };
  const alternative = spec.versions.find((x) => x.served && !x.deprecated);
  return spec.versions
    .filter((x) => x.served && x.deprecated)
    .map((x) => {
      const apiVersion = `${spec.group}/${x.name}`;
      return {
        id: `crd|${crd.metadata.name}|${apiVersion}`,
        severity: 'warning' as const,
        source: 'crd' as const,
        api_version: apiVersion,
        kind: spec.names.kind,
        deprecated_in: null,
        removed_in: null,
        replacement: alternative ? `${spec.group}/${alternative.name}` : null,
        replacement_kind: null,
        notes: [alternative ? 'crd_deprecated_version' : 'crd_only_deprecated'],
        already_removed: false,
        object: {
          api_version: 'apiextensions.k8s.io/v1',
          kind: 'CustomResourceDefinition',
          namespace: null,
          name: crd.metadata.name,
        },
        helm: null,
        managers: [],
        detail: x.deprecationWarning ?? null,
      };
    });
}

const SOURCE_RANK: Record<UpgradeSource, number> = {
  'helm-release': 0,
  'last-applied': 1,
  'managed-fields': 2,
  metrics: 3,
  'api-service': 4,
  crd: 5,
};

register({
  upgrade_readiness_scan: async ({ clusterId, options }: MockArgs): Promise<UpgradeReport> => {
    const opts = (options ?? {}) as UpgradeScanOptions;
    const db = getDb(clusterId);
    const git = db.profile.version;
    const current = minorOf(git)!;
    const requested = opts.target_version?.trim() || null;
    if (requested && !parseMinor(requested))
      throw new Error(`invalid target version "${requested}": use a version such as 1.32`);
    const target = requested ? minorOf(requested)! : nextMinor(git)!;
    if (compareMinor(target, current) < 0)
      throw new Error(`the target version ${target} is older than the cluster (${current})`);
    const v = { current, target };
    await sleep(900);

    const findings: UpgradeFinding[] = [];
    let objects = 0;
    const kinds = new Set<string>();
    for (const table of db.kinds.values())
      for (const o of table.values()) {
        if (!SCANNED_KINDS.has(o.kind)) continue;
        objects++;
        kinds.add(o.kind);
        findings.push(...objectFindings(db, o, v));
      }
    const helm = helmFindings(db, v);
    findings.push(...helm.findings);
    const crds = list(db, 'customresourcedefinitions.apiextensions.k8s.io');
    for (const crd of crds) findings.push(...crdFindings(crd));

    let metrics: UpgradeReport['metrics'] = 'skipped';
    let metricsError: string | null = null;
    if (opts.metrics) {
      const status = (await Promise.resolve(
        handlers.prometheus_status?.({ clusterId, refresh: false }),
      ).catch(() => undefined)) as PrometheusStatus | undefined;
      if (status?.state === 'available') {
        metrics = 'used';
        // An old prometheus-adapter on prod-eu still lists FlowSchemas through v1beta3.
        const entry = deprecatedApi('flowcontrol.apiserver.k8s.io/v1beta3', 'FlowSchema');
        const f =
          db.profile.id === 'c-prod-eu' && entry
            ? finding(
                entry,
                v,
                'metrics',
                'metrics|flowcontrol.apiserver.k8s.io/v1beta3|flowschemas',
              )
            : null;
        if (f) findings.push({ ...f, detail: 'flowschemas' });
      } else if (status?.state !== 'off') {
        metrics = 'unavailable';
        metricsError = 'no Prometheus was found on this cluster';
      }
    }
    findings.sort(
      (a, b) =>
        (a.severity === b.severity ? 0 : a.severity === 'blocker' ? -1 : 1) ||
        SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
        a.kind.localeCompare(b.kind) ||
        (a.object?.namespace ?? '').localeCompare(b.object?.namespace ?? '') ||
        (a.object?.name ?? '').localeCompare(b.object?.name ?? ''),
    );
    return {
      cluster_id: clusterId,
      server_git_version: git,
      server_version: current,
      target_version: target,
      next_version: nextMinor(git)!,
      table_updated: DEPRECATIONS_UPDATED,
      scanned_at: Date.now(),
      objects_scanned: objects,
      kinds_scanned: kinds.size,
      helm_releases_scanned: helm.releases,
      crds_scanned: crds.length,
      metrics,
      metrics_error: metricsError,
      skipped: [],
      truncated: false,
      findings,
    };
  },
});
