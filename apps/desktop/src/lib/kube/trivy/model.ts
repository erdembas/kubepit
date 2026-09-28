import type { KubeObject } from '@/types';
import { asArray, asNumber, asObject, asString, isObject, type JsonObject } from '../accessors';
import type { ObjectRef } from '../columns/types';

/**
 * Trivy Operator reports reduced to plain rows. Pure: no i18n, no IPC.
 * Report data (CVE ids, package names, check ids, titles) is shown verbatim.
 * Exposed secrets are read as metadata only: the `match` field (the line
 * that contains the secret) is never read.
 */

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
export const SEVERITIES: readonly Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
}

export const emptyCounts = (): SeverityCounts => ({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  unknown: 0,
});

export function toSeverity(value: unknown): Severity {
  const s = asString(value).toUpperCase();
  return (SEVERITIES as readonly string[]).includes(s) ? (s as Severity) : 'UNKNOWN';
}

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

export function countKey(s: Severity): keyof SeverityCounts {
  return s.toLowerCase() as keyof SeverityCounts;
}

export function addCounts(a: SeverityCounts, b: SeverityCounts): SeverityCounts {
  return {
    critical: a.critical + b.critical,
    high: a.high + b.high,
    medium: a.medium + b.medium,
    low: a.low + b.low,
    unknown: a.unknown + b.unknown,
  };
}

export function totalOf(c: SeverityCounts): number {
  return c.critical + c.high + c.medium + c.low + c.unknown;
}

/** Sorts worst first: more criticals, then highs, mediums, lows. */
export function compareCounts(a: SeverityCounts, b: SeverityCounts): number {
  return (
    b.critical - a.critical ||
    b.high - a.high ||
    b.medium - a.medium ||
    b.low - a.low ||
    b.unknown - a.unknown
  );
}

export const reportBody = (report: KubeObject): JsonObject => asObject(report.report);

/** `report.summary` counts (`criticalCount`, …). */
export function summaryCounts(report: KubeObject): SeverityCounts {
  const s = asObject(reportBody(report).summary);
  return {
    critical: asNumber(s.criticalCount),
    high: asNumber(s.highCount),
    medium: asNumber(s.mediumCount),
    low: asNumber(s.lowCount),
    unknown: asNumber(s.unknownCount),
  };
}

export function updatedAt(report: KubeObject): string {
  return (
    asString(reportBody(report).updateTimestamp) ||
    asString(asObject(report.status).updateTimestamp) ||
    report.metadata.creationTimestamp ||
    ''
  );
}

export function scannerText(report: KubeObject): string {
  const s = asObject(reportBody(report).scanner);
  return [asString(s.name), asString(s.version)].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Scanned object
// ---------------------------------------------------------------------------

export const LABEL_KIND = 'trivy-operator.resource.kind';
export const LABEL_NAME = 'trivy-operator.resource.name';
export const LABEL_NAMESPACE = 'trivy-operator.resource.namespace';
export const LABEL_CONTAINER = 'trivy-operator.container.name';

export interface ReportTarget {
  kind: string;
  name: string;
  namespace: string | null;
  /** Container of a per-container report (vulnerabilities, secrets, SBOM). */
  container: string;
}

/** The object a report describes, from the operator's labels (long names live in an annotation). */
export function reportTarget(report: KubeObject): ReportTarget {
  const labels = report.metadata.labels ?? {};
  const annotations = report.metadata.annotations ?? {};
  const owner =
    report.metadata.ownerReferences?.find((r) => r.controller) ??
    report.metadata.ownerReferences?.[0];
  return {
    kind: labels[LABEL_KIND] || owner?.kind || '',
    name: labels[LABEL_NAME] || annotations[LABEL_NAME] || owner?.name || '',
    namespace: labels[LABEL_NAMESPACE] || report.metadata.namespace || null,
    container: labels[LABEL_CONTAINER] ?? '',
  };
}

/** `<deployment>-<pod-template-hash>` (the hash is 5–10 lowercase alphanumerics). */
export const RS_HASH = /^(.+)-[a-z0-9]{5,10}$/;

/**
 * The workload a person thinks of: Trivy scans a Deployment's current
 * ReplicaSet, which is shown as its Deployment.
 */
export function workloadOf(target: ReportTarget): {
  kind: string;
  name: string;
  namespace: string | null;
} {
  if (target.kind === 'ReplicaSet') {
    const m = RS_HASH.exec(target.name);
    if (m) return { kind: 'Deployment', name: m[1]!, namespace: target.namespace };
  }
  return { kind: target.kind, name: target.name, namespace: target.namespace };
}

export function targetRef(t: { kind: string; name: string; namespace: string | null }): ObjectRef {
  return { kind: t.kind, name: t.name, namespace: t.namespace };
}

// ---------------------------------------------------------------------------
// Images and vulnerabilities
// ---------------------------------------------------------------------------

export interface ImageRef {
  registry: string;
  repository: string;
  tag: string;
  digest: string;
  /** `registry/repository:tag` (Docker Hub's registry omitted). */
  text: string;
  /** Deduplication key: the digest when known, else the text. */
  key: string;
}

export function reportImage(report: KubeObject): ImageRef {
  const body = reportBody(report);
  const artifact = asObject(body.artifact);
  const registry = asString(asObject(body.registry).server);
  const repository = asString(artifact.repository);
  const tag = asString(artifact.tag);
  const digest = asString(artifact.digest);
  const host = registry && registry !== 'index.docker.io' ? `${registry}/` : '';
  const text = repository ? `${host}${repository}${tag ? `:${tag}` : ''}` : '';
  return { registry, repository, tag, digest, text, key: digest || text };
}

export function osText(report: KubeObject): string {
  const os = asObject(reportBody(report).os);
  return [asString(os.family), asString(os.name)].filter(Boolean).join(' ');
}

export interface Vulnerability {
  id: string;
  pkg: string;
  installed: string;
  fixed: string;
  severity: Severity;
  title: string;
  /** Advisory link (`primaryLink`, else the first link). */
  link: string;
  score: number | null;
  target: string;
  published: string;
}

export function vulnerabilities(report: KubeObject): Vulnerability[] {
  return asArray(reportBody(report).vulnerabilities)
    .filter(isObject)
    .map((v) => ({
      id: asString(v.vulnerabilityID),
      pkg: asString(v.resource),
      installed: asString(v.installedVersion),
      fixed: asString(v.fixedVersion),
      severity: toSeverity(v.severity),
      title: asString(v.title),
      link: asString(v.primaryLink) || asString(asArray(v.links)[0]),
      score: typeof v.score === 'number' ? v.score : null,
      target: asString(v.target),
      published: asString(v.publishedDate),
    }));
}

/** Only https advisory links are opened. */
export function safeLink(url: string): string | null {
  return /^https:\/\//i.test(url) ? url : null;
}

/** Counts of a vulnerability list (optionally only fixable ones). */
export function countVulns(list: readonly Vulnerability[], fixableOnly = false): SeverityCounts {
  const c = emptyCounts();
  for (const v of list) if (!fixableOnly || v.fixed) c[countKey(v.severity)]++;
  return c;
}

/** Counts of one report: from the list, falling back to the summary when the list is empty. */
export function reportCounts(report: KubeObject, fixableOnly = false): SeverityCounts {
  const list = vulnerabilities(report);
  if (list.length || fixableOnly) return countVulns(list, fixableOnly);
  return summaryCounts(report);
}

// ---------------------------------------------------------------------------
// Checks (config audit, RBAC and infra assessments)
// ---------------------------------------------------------------------------

export interface CheckResult {
  id: string;
  title: string;
  description: string;
  severity: Severity;
  category: string;
  success: boolean;
  messages: string[];
  remediation: string;
}

export function reportChecks(report: KubeObject): CheckResult[] {
  return asArray(reportBody(report).checks)
    .filter(isObject)
    .map((c) => ({
      id: asString(c.checkID),
      title: asString(c.title),
      description: asString(c.description),
      severity: toSeverity(c.severity),
      category: asString(c.category),
      success: c.success === true,
      messages: asArray(c.messages)
        .map((m) => asString(m))
        .filter(Boolean),
      remediation: asString(c.remediation),
    }));
}

export function failedChecks(report: KubeObject): CheckResult[] {
  return reportChecks(report).filter((c) => !c.success);
}

/** Counts of failed checks (config audits have no unknown bucket). */
export function checkCounts(report: KubeObject): SeverityCounts {
  const checks = reportChecks(report);
  if (!checks.length) return summaryCounts(report);
  const c = emptyCounts();
  for (const check of checks) if (!check.success) c[countKey(check.severity)]++;
  return c;
}

// ---------------------------------------------------------------------------
// Exposed secrets (metadata only)
// ---------------------------------------------------------------------------

export interface ExposedSecret {
  /** File inside the image. */
  target: string;
  ruleId: string;
  title: string;
  category: string;
  severity: Severity;
}

/** Never reads `match`: the secret value must not reach the UI. */
export function exposedSecrets(report: KubeObject): ExposedSecret[] {
  return asArray(reportBody(report).secrets)
    .filter(isObject)
    .map((s) => ({
      target: asString(s.target),
      ruleId: asString(s.ruleID),
      title: asString(s.title),
      category: asString(s.category),
      severity: toSeverity(s.severity),
    }));
}

export function secretCounts(report: KubeObject): SeverityCounts {
  const list = exposedSecrets(report);
  if (!list.length) return summaryCounts(report);
  const c = emptyCounts();
  for (const s of list) c[countKey(s.severity)]++;
  return c;
}

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

export interface ComplianceControl {
  id: string;
  name: string;
  severity: Severity;
  /** Failed resources (`totalFail`); `null` when the report has no result for it yet. */
  failed: number | null;
}

export interface ComplianceSummary {
  id: string;
  title: string;
  version: string;
  description: string;
  pass: number;
  fail: number;
  controls: ComplianceControl[];
  updated: string;
  /** Cron schedule of the report. */
  schedule: string;
}

export function complianceSummary(report: KubeObject): ComplianceSummary {
  const spec = asObject(report.spec);
  const compliance = asObject(spec.compliance);
  const status = asObject(report.status);
  const summary = asObject(status.summary);
  const results = new Map<string, number>();
  for (const c of asArray(asObject(status.summaryReport).controlCheck).filter(isObject))
    results.set(asString(c.id), asNumber(c.totalFail));
  for (const c of asArray(asObject(status.detailReport).results).filter(isObject)) {
    const id = asString(c.id);
    if (results.has(id)) continue;
    const failed = asArray(c.checks)
      .filter(isObject)
      .filter((x) => x.success === false).length;
    results.set(id, failed);
  }
  const controls = asArray(compliance.controls)
    .filter(isObject)
    .map((c) => {
      const id = asString(c.id);
      return {
        id,
        name: asString(c.name),
        severity: toSeverity(c.severity),
        failed: results.has(id) ? results.get(id)! : null,
      };
    });
  return {
    id: asString(compliance.id) || report.metadata.name,
    title: asString(compliance.title) || report.metadata.name,
    version: asString(compliance.version),
    description: asString(compliance.description),
    pass: asNumber(summary.passCount),
    fail: asNumber(summary.failCount),
    controls,
    updated: asString(status.updateTimestamp),
    schedule: asString(spec.cron),
  };
}

// ---------------------------------------------------------------------------
// SBOM
// ---------------------------------------------------------------------------

export interface SbomComponent {
  name: string;
  version: string;
  type: string;
  purl: string;
  licenses: string[];
}

export interface SbomSummary {
  format: string;
  components: number;
  dependencies: number;
  list: SbomComponent[];
}

export function sbomSummary(report: KubeObject): SbomSummary {
  const body = reportBody(report);
  const summary = asObject(body.summary);
  const bom = asObject(body.components);
  const list = asArray(bom.components)
    .filter(isObject)
    .map((c) => ({
      name: asString(c.name),
      version: asString(c.version),
      type: asString(c.type),
      purl: asString(c.purl),
      licenses: asArray(c.licenses)
        .filter(isObject)
        .map(
          (l) =>
            asString(asObject(l.license).id) ||
            asString(asObject(l.license).name) ||
            asString(l.expression),
        )
        .filter(Boolean),
    }));
  return {
    format: [asString(bom.bomFormat), asString(bom.specVersion)].filter(Boolean).join(' '),
    components: asNumber(summary.componentsCount) || list.length,
    dependencies: asNumber(summary.dependenciesCount),
    list,
  };
}
