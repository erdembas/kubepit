import type { UpgradeFinding, UpgradeSeverity, UpgradeSource } from '@/types';

/** Pure model of the upgrade readiness view: filters, counts and groups. */

export const UPGRADE_SOURCES: readonly UpgradeSource[] = [
  'helm-release',
  'last-applied',
  'managed-fields',
  'metrics',
  'api-service',
  'crd',
];

export type Filter<T extends string> = T | 'all';

export interface UpgradeFilters {
  severity: Filter<UpgradeSeverity>;
  source: Filter<UpgradeSource>;
  query: string;
}

/** Text a finding matches the filter box against (identifiers only). */
function haystack(f: UpgradeFinding): string {
  return [
    f.api_version,
    f.kind,
    f.object?.namespace,
    f.object?.name,
    f.helm ? `${f.helm.namespace}/${f.helm.name} ${f.helm.chart}` : null,
    f.managers.join(' '),
    f.detail,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function filterFindings(
  findings: readonly UpgradeFinding[],
  { severity, source, query }: UpgradeFilters,
): UpgradeFinding[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return findings.filter(
    (f) =>
      (severity === 'all' || f.severity === severity) &&
      (source === 'all' || f.source === source) &&
      (!words.length || words.every((w) => haystack(f).includes(w))),
  );
}

export interface UpgradeCounts {
  blocker: number;
  warning: number;
  bySource: Record<UpgradeSource, number>;
  /** Distinct Helm releases with at least one finding. */
  helmReleases: number;
  /** Distinct Helm releases with a blocker (they cannot be upgraded). */
  blockedReleases: number;
}

export function countFindings(findings: readonly UpgradeFinding[]): UpgradeCounts {
  const bySource = Object.fromEntries(UPGRADE_SOURCES.map((s) => [s, 0])) as Record<
    UpgradeSource,
    number
  >;
  const releases = new Set<string>();
  const blocked = new Set<string>();
  let blocker = 0;
  let warning = 0;
  for (const f of findings) {
    if (f.severity === 'blocker') blocker++;
    else warning++;
    bySource[f.source]++;
    if (f.helm) {
      const key = `${f.helm.namespace}/${f.helm.name}`;
      releases.add(key);
      if (f.severity === 'blocker') blocked.add(key);
    }
  }
  return { blocker, warning, bySource, helmReleases: releases.size, blockedReleases: blocked.size };
}

/** Findings of one deprecated apiVersion + kind. */
export interface UpgradeGroup {
  key: string;
  apiVersion: string;
  kind: string;
  /** Worst severity of the group. */
  severity: UpgradeSeverity;
  deprecatedIn: string | null;
  removedIn: string | null;
  replacement: string | null;
  replacementKind: string | null;
  alreadyRemoved: boolean;
  notes: string[];
  findings: UpgradeFinding[];
}

/** Grouped by apiVersion + kind: blockers first, then by kind and apiVersion. */
export function groupFindings(findings: readonly UpgradeFinding[]): UpgradeGroup[] {
  const groups = new Map<string, UpgradeGroup>();
  for (const f of findings) {
    const key = `${f.api_version}|${f.kind}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        apiVersion: f.api_version,
        kind: f.kind,
        severity: f.severity,
        deprecatedIn: f.deprecated_in,
        removedIn: f.removed_in,
        replacement: f.replacement,
        replacementKind: f.replacement_kind,
        alreadyRemoved: f.already_removed,
        notes: [...f.notes],
        findings: [],
      };
      groups.set(key, g);
    }
    if (f.severity === 'blocker') g.severity = 'blocker';
    g.alreadyRemoved ||= f.already_removed;
    for (const n of f.notes) if (!g.notes.includes(n)) g.notes.push(n);
    g.findings.push(f);
  }
  const rank = (s: UpgradeSeverity) => (s === 'blocker' ? 0 : 1);
  return [...groups.values()].sort(
    (a, b) =>
      rank(a.severity) - rank(b.severity) ||
      a.kind.localeCompare(b.kind) ||
      a.apiVersion.localeCompare(b.apiVersion),
  );
}
