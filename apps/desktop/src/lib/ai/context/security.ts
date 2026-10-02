import {
  osText,
  reportImage,
  reportTarget,
  scannerText,
  updatedAt,
  vulnerabilities,
  workloadOf,
  type Severity,
  type Vulnerability,
} from '@/lib/kube/trivy';
import type { AiContextSection, KubeObject } from '@/types';

/**
 * Pure builders of the risk-analysis context of a CVE (spec §11 style):
 * one section for the finding itself and one for the cluster's exposure
 * to it. Ids and priorities follow the spec (0 = kept longest); labels
 * are identifiers only (`CVE-2023-44487`) and never translated; contents
 * are Kubernetes data in plain, compact text. The backend redacts and
 * budgets every section before anything is previewed or sent.
 */

const MAX_PACKAGES = 20;
const MAX_WORKLOADS = 15;

const ref = (kind: string, namespace: string | null | undefined, name: string) =>
  `${kind} ${namespace ? `${namespace}/` : ''}${name}`;

/** `n` unique values, then `+N more`. */
function list(values: string[], max: number): string[] {
  const unique = [...new Set(values.filter(Boolean))];
  const shown = unique.slice(0, max);
  return shown.length < unique.length
    ? [...shown, `… ${unique.length - shown.length} more`]
    : shown;
}

export interface CveFinding {
  id: string;
  severity: Severity;
  title: string;
  score: number | null;
  link: string;
  packages: string[];
  installed: string[];
  fixed: string[];
}

/** The CVE itself: id, severity, score, affected and fixed versions. */
export function cveSection(finding: CveFinding): AiContextSection {
  const lines = [
    `cve: ${finding.id}`,
    `severity: ${finding.severity}`,
    ...(finding.score !== null ? [`cvss score: ${finding.score}`] : []),
    ...(finding.title ? [`title: ${finding.title}`] : []),
    ...(finding.link ? [`advisory: ${finding.link}`] : []),
    'affected packages:',
    ...list(finding.packages, MAX_PACKAGES).map((p) => `  ${p}`),
    'installed versions:',
    ...list(finding.installed, MAX_PACKAGES).map((v) => `  ${v}`),
    ...(finding.fixed.length
      ? ['fixed in:', ...list(finding.fixed, MAX_PACKAGES).map((v) => `  ${v}`)]
      : ['fixed in: (no fix released yet)']),
  ];
  return {
    id: 'cve',
    kind: 'vulnerabilities',
    label: finding.id,
    priority: 0,
    format: 'text',
    content: lines.join('\n'),
  };
}

/** Where the CVE lives: images, workloads and containers, from its reports. */
export function cveExposureSection(reports: readonly KubeObject[]): AiContextSection | null {
  if (!reports.length) return null;
  const images = new Set<string>();
  const workloads = new Map<string, string>();
  const containers = new Set<string>();
  const oses = new Set<string>();
  let scanner = '';
  let updated = '';
  for (const report of reports) {
    const image = reportImage(report).text;
    if (image) images.add(image);
    const target = workloadOf(reportTarget(report));
    workloads.set(`${target.namespace ?? ''}/${target.kind}/${target.name}`, ref(target.kind, target.namespace, target.name));
    const container = reportTarget(report).container;
    if (container) containers.add(container);
    const os = osText(report);
    if (os) oses.add(os);
    scanner = scanner || scannerText(report);
    const stamp = updatedAt(report);
    if (stamp && (!updated || stamp > updated)) updated = stamp;
  }
  const lines = [
    'images:',
    ...list([...images], MAX_PACKAGES).map((i) => `  ${i}`),
    'workloads:',
    ...list([...workloads.values()], MAX_WORKLOADS).map((w) => `  ${w}`),
    ...(containers.size ? ['containers:', ...list([...containers], MAX_PACKAGES).map((c) => `  ${c}`)] : []),
    ...(oses.size ? ['image os:', ...list([...oses], 4).map((o) => `  ${o}`)] : []),
    ...(scanner ? [`scanner: ${scanner}`] : []),
    ...(updated ? [`report updated: ${updated}`] : []),
  ];
  return {
    id: 'cve-exposure',
    kind: 'vulnerabilities',
    label: [...workloads.values()][0] ?? 'exposure',
    priority: 1,
    format: 'text',
    content: lines.join('\n'),
  };
}

/** One vulnerability of one report, as the details panel shows it. */
export function vulnerabilitySection(
  report: KubeObject,
  vuln: Vulnerability,
): { cve: AiContextSection; exposure: AiContextSection | null } {
  const target = reportTarget(report);
  const image = reportImage(report);
  const lines = [
    `cve: ${vuln.id}`,
    `severity: ${vuln.severity}`,
    ...(vuln.score !== null ? [`cvss score: ${vuln.score}`] : []),
    ...(vuln.title ? [`title: ${vuln.title}`] : []),
    ...(vuln.link ? [`advisory: ${vuln.link}`] : []),
    `package: ${vuln.pkg}`,
    `installed: ${vuln.installed}`,
    ...(vuln.fixed ? [`fixed in: ${vuln.fixed}`] : ['fixed in: (no fix released yet)']),
    ...(vuln.target ? [`path in image: ${vuln.target}`] : []),
    ...(vuln.published ? [`published: ${vuln.published}`] : []),
  ];
  const cve: AiContextSection = {
    id: 'cve',
    kind: 'vulnerabilities',
    label: vuln.id,
    priority: 0,
    format: 'text',
    content: lines.join('\n'),
  };
  const exposureLines = [
    `image: ${image.text || report.metadata.name}`,
    ...(image.digest ? [`digest: ${image.digest}`] : []),
    `scanned object: ${ref(target.kind, target.namespace, target.name)}`,
    ...(target.container ? [`container: ${target.container}`] : []),
    ...(osText(report) ? [`image os: ${osText(report)}`] : []),
    ...(scannerText(report) ? [`scanner: ${scannerText(report)}`] : []),
    ...(updatedAt(report) ? [`report updated: ${updatedAt(report)}`] : []),
    `other vulnerabilities in this image: ${vulnerabilities(report).length}`,
  ];
  const exposure: AiContextSection = {
    id: 'cve-exposure',
    kind: 'vulnerabilities',
    label: image.text || report.metadata.name,
    priority: 1,
    format: 'text',
    content: exposureLines.join('\n'),
  };
  return { cve, exposure };
}
