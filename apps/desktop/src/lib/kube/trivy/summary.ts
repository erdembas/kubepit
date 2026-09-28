import type { KubeObject } from '@/types';
import {
  addCounts,
  compareCounts,
  complianceSummary,
  countKey,
  countVulns,
  emptyCounts,
  exposedSecrets,
  failedChecks,
  reportImage,
  reportTarget,
  severityRank,
  summaryCounts,
  updatedAt,
  vulnerabilities,
  workloadOf,
  RS_HASH,
  type ComplianceSummary,
  type ExposedSecret,
  type ImageRef,
  type ReportTarget,
  type Severity,
  type SeverityCounts,
  type Vulnerability,
} from './model';

/**
 * Aggregations behind the Security view: severity totals, images
 * (deduplicated by digest), workloads ranked by risk, CVE search, failed
 * checks grouped by check id, exposed secrets and compliance. Pure and
 * deterministic.
 */

export interface WorkloadKey {
  kind: string;
  name: string;
  namespace: string | null;
}

const workloadKey = (w: WorkloadKey) => `${w.namespace ?? ''}/${w.kind}/${w.name}`;

function newest(a: KubeObject, b: KubeObject): KubeObject {
  return updatedAt(b) > updatedAt(a) ? b : a;
}

/** The vulnerabilities of a report, falling back to summary counts when the list is empty. */
function reportVulns(
  report: KubeObject,
  fixableOnly: boolean,
): { list: Vulnerability[]; counts: SeverityCounts } {
  const list = vulnerabilities(report);
  const filtered = fixableOnly ? list.filter((v) => v.fixed) : list;
  const counts = list.length || fixableOnly ? countVulns(filtered) : summaryCounts(report);
  return { list: filtered, counts };
}

export interface ImageRow {
  key: string;
  image: ImageRef;
  counts: SeverityCounts;
  /** Workloads running the image (deduplicated). */
  workloads: WorkloadKey[];
  /** The most recently updated report of the image. */
  report: KubeObject;
}

export interface WorkloadRow {
  key: string;
  workload: WorkloadKey;
  counts: SeverityCounts;
  images: string[];
  containers: string[];
  reports: KubeObject[];
}

export interface VulnOverview {
  totals: SeverityCounts;
  /** Unique vulnerabilities (id + package) across unique images. */
  unique: SeverityCounts;
  images: ImageRow[];
  workloads: WorkloadRow[];
  reports: number;
}

/**
 * Totals count each image once (the newest report per digest), so ten
 * replicas of one vulnerable image do not look ten times worse.
 */
export function vulnOverview(reports: readonly KubeObject[], fixableOnly: boolean): VulnOverview {
  const byImage = new Map<string, { report: KubeObject; workloads: Map<string, WorkloadKey> }>();
  const byWorkload = new Map<
    string,
    {
      workload: WorkloadKey;
      seen: Set<string>;
      counts: SeverityCounts;
      images: Set<string>;
      containers: Set<string>;
      reports: KubeObject[];
    }
  >();
  for (const report of reports) {
    const target = reportTarget(report);
    const workload = workloadOf(target);
    const image = reportImage(report);
    const imageKey = image.key || report.metadata.uid;
    const entry = byImage.get(imageKey);
    const wk = workloadKey(workload);
    if (entry) {
      entry.report = newest(entry.report, report);
      entry.workloads.set(wk, workload);
    } else byImage.set(imageKey, { report, workloads: new Map([[wk, workload]]) });

    let w = byWorkload.get(wk);
    if (!w) {
      w = {
        workload,
        seen: new Set(),
        counts: emptyCounts(),
        images: new Set(),
        containers: new Set(),
        reports: [],
      };
      byWorkload.set(wk, w);
    }
    w.reports.push(report);
    if (image.text) w.images.add(image.text);
    if (target.container) w.containers.add(target.container);
    const { list, counts } = reportVulns(report, fixableOnly);
    if (list.length) {
      for (const v of list) {
        const id = `${v.id}|${v.pkg}|${v.installed}`;
        if (w.seen.has(id)) continue;
        w.seen.add(id);
        w.counts[countKey(v.severity)]++;
      }
    } else w.counts = addCounts(w.counts, counts);
  }

  let totals = emptyCounts();
  const unique = emptyCounts();
  const seenVulns = new Set<string>();
  const images: ImageRow[] = [];
  for (const [key, { report, workloads }] of byImage) {
    const { list, counts } = reportVulns(report, fixableOnly);
    totals = addCounts(totals, counts);
    for (const v of list) {
      const id = `${v.id}|${v.pkg}`;
      if (seenVulns.has(id)) continue;
      seenVulns.add(id);
      unique[countKey(v.severity)]++;
    }
    images.push({
      key,
      image: reportImage(report),
      counts,
      workloads: [...workloads.values()],
      report,
    });
  }
  images.sort(
    (a, b) => compareCounts(a.counts, b.counts) || a.image.text.localeCompare(b.image.text),
  );
  const workloads: WorkloadRow[] = [...byWorkload.entries()].map(([key, w]) => ({
    key,
    workload: w.workload,
    counts: w.counts,
    images: [...w.images].sort(),
    containers: [...w.containers].sort(),
    reports: w.reports,
  }));
  workloads.sort(
    (a, b) => compareCounts(a.counts, b.counts) || a.workload.name.localeCompare(b.workload.name),
  );
  return { totals, unique, images, workloads, reports: reports.length };
}

// ---------------------------------------------------------------------------
// CVE search
// ---------------------------------------------------------------------------

export interface CveRow {
  id: string;
  severity: Severity;
  title: string;
  link: string;
  score: number | null;
  packages: string[];
  installed: string[];
  fixed: string[];
  images: string[];
  workloads: WorkloadKey[];
  reports: KubeObject[];
}

export function matchesVuln(v: Vulnerability, q: string): boolean {
  return (
    v.id.toLowerCase().includes(q) ||
    v.pkg.toLowerCase().includes(q) ||
    v.title.toLowerCase().includes(q)
  );
}

/** Vulnerabilities whose id, package or title contains `query`, grouped by id. */
export function searchVulns(
  reports: readonly KubeObject[],
  query: string,
  fixableOnly: boolean,
  limit = 200,
): { rows: CveRow[]; total: number } {
  const q = query.trim().toLowerCase();
  if (!q) return { rows: [], total: 0 };
  const byId = new Map<
    string,
    {
      row: CveRow;
      packages: Set<string>;
      installed: Set<string>;
      fixed: Set<string>;
      images: Set<string>;
      workloads: Map<string, WorkloadKey>;
      reports: Set<KubeObject>;
    }
  >();
  for (const report of reports) {
    const image = reportImage(report).text;
    const workload = workloadOf(reportTarget(report));
    for (const v of vulnerabilities(report)) {
      if (fixableOnly && !v.fixed) continue;
      if (!matchesVuln(v, q)) continue;
      let e = byId.get(v.id);
      if (!e) {
        e = {
          row: {
            id: v.id,
            severity: v.severity,
            title: v.title,
            link: v.link,
            score: v.score,
            packages: [],
            installed: [],
            fixed: [],
            images: [],
            workloads: [],
            reports: [],
          },
          packages: new Set(),
          installed: new Set(),
          fixed: new Set(),
          images: new Set(),
          workloads: new Map(),
          reports: new Set(),
        };
        byId.set(v.id, e);
      }
      if (severityRank(v.severity) < severityRank(e.row.severity)) e.row.severity = v.severity;
      if (!e.row.title && v.title) e.row.title = v.title;
      if (!e.row.link && v.link) e.row.link = v.link;
      if (v.pkg) e.packages.add(v.pkg);
      if (v.installed) e.installed.add(v.installed);
      if (v.fixed) e.fixed.add(v.fixed);
      if (image) e.images.add(image);
      e.workloads.set(workloadKey(workload), workload);
      e.reports.add(report);
    }
  }
  const rows = [...byId.values()].map((e) => ({
    ...e.row,
    packages: [...e.packages].sort(),
    installed: [...e.installed].sort(),
    fixed: [...e.fixed].sort(),
    images: [...e.images].sort(),
    workloads: [...e.workloads.values()],
    reports: [...e.reports],
  }));
  rows.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      b.workloads.length - a.workloads.length ||
      a.id.localeCompare(b.id),
  );
  return { rows: rows.slice(0, limit), total: rows.length };
}

// ---------------------------------------------------------------------------
// Failed checks by check id
// ---------------------------------------------------------------------------

export interface CheckGroup {
  id: string;
  title: string;
  severity: Severity;
  category: string;
  description: string;
  remediation: string;
  /** Scanned objects failing the check (deduplicated). */
  objects: Array<{ target: ReportTarget; report: KubeObject; messages: string[] }>;
}

export function checkGroups(reports: readonly KubeObject[]): CheckGroup[] {
  const groups = new Map<string, CheckGroup & { seen: Set<string> }>();
  for (const report of reports) {
    const target = reportTarget(report);
    const tk = `${target.namespace ?? ''}/${target.kind}/${target.name}`;
    for (const c of failedChecks(report)) {
      let g = groups.get(c.id);
      if (!g) {
        g = {
          id: c.id,
          title: c.title,
          severity: c.severity,
          category: c.category,
          description: c.description,
          remediation: c.remediation,
          objects: [],
          seen: new Set(),
        };
        groups.set(c.id, g);
      }
      if (g.seen.has(tk)) continue;
      g.seen.add(tk);
      g.objects.push({ target, report, messages: c.messages });
    }
  }
  return [...groups.values()]
    .map(({ seen: _seen, ...g }) => g)
    .sort(
      (a, b) =>
        severityRank(a.severity) - severityRank(b.severity) ||
        b.objects.length - a.objects.length ||
        a.id.localeCompare(b.id),
    );
}

// ---------------------------------------------------------------------------
// Exposed secrets and compliance
// ---------------------------------------------------------------------------

export interface SecretRow extends ExposedSecret {
  key: string;
  workload: WorkloadKey;
  container: string;
  image: string;
  report: KubeObject;
}

export function secretRows(reports: readonly KubeObject[]): SecretRow[] {
  const out: SecretRow[] = [];
  for (const report of reports) {
    const target = reportTarget(report);
    const image = reportImage(report).text;
    exposedSecrets(report).forEach((s, i) =>
      out.push({
        ...s,
        key: `${report.metadata.uid}|${i}`,
        workload: workloadOf(target),
        container: target.container,
        image,
        report,
      }),
    );
  }
  return out.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      a.workload.name.localeCompare(b.workload.name),
  );
}

export function complianceRows(
  reports: readonly KubeObject[],
): Array<ComplianceSummary & { report: KubeObject }> {
  return reports
    .map((report) => ({ ...complianceSummary(report), report }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

// ---------------------------------------------------------------------------
// Reports of one object (details panel)
// ---------------------------------------------------------------------------

type NameMatch = string | ((name: string) => boolean);

/** What Trivy names in its labels for the pods of `obj` (kind + name candidates). */
export function scanTargetsOf(obj: KubeObject): Array<{ kind: string; name: NameMatch }> {
  const name = obj.metadata.name;
  switch (obj.kind) {
    case 'Deployment':
      // The current (and older) ReplicaSets carry the reports.
      return [
        { kind: 'Deployment', name },
        { kind: 'ReplicaSet', name: (n) => RS_HASH.exec(n)?.[1] === name },
      ];
    case 'Pod': {
      const owner = obj.metadata.ownerReferences?.find((r) => r.controller);
      if (!owner) return [{ kind: 'Pod', name }];
      if (owner.kind === 'Job') {
        const cron = /^(.+)-\d+$/.exec(owner.name);
        return [
          { kind: 'Job', name: owner.name },
          ...(cron ? [{ kind: 'CronJob', name: cron[1]! }] : []),
        ];
      }
      return [{ kind: owner.kind, name: owner.name }];
    }
    default:
      return [{ kind: obj.kind, name }];
  }
}

/** Reports whose scanned object is `obj` (or the controller behind its pods). */
export function reportsFor(obj: KubeObject, reports: readonly KubeObject[]): KubeObject[] {
  const targets = scanTargetsOf(obj);
  const ns = obj.metadata.namespace ?? null;
  return reports.filter((r) => {
    const t = reportTarget(r);
    if (ns !== null && t.namespace !== ns) return false;
    return targets.some(
      (x) => x.kind === t.kind && (typeof x.name === 'string' ? x.name === t.name : x.name(t.name)),
    );
  });
}

/** True for a ReplicaSet name produced by a Deployment. */
export function isDeploymentReplicaSet(name: string): boolean {
  return RS_HASH.test(name);
}
