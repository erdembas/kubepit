import type { ApiResourceInfo, OpenApiIndex } from '@/types';

/** Kinds the API explorer offers: every served kind (builtins and CRDs), one entry per group. */

export interface KindEntry {
  /** `apps/Deployment`. */
  key: string;
  group: string;
  kind: string;
  /** Preferred version from discovery (`apps/v1`). */
  apiVersion: string;
  plural: string;
  namespaced: boolean;
  shortNames: string[];
}

export function kindEntries(resources: readonly ApiResourceInfo[] | null | undefined): KindEntry[] {
  const seen = new Map<string, KindEntry>();
  for (const r of resources ?? []) {
    const key = `${r.group}/${r.kind}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      key,
      group: r.group,
      kind: r.kind,
      apiVersion: r.api_version,
      plural: r.plural,
      namespaced: r.namespaced,
      shortNames: r.short_names,
    });
  }
  return [...seen.values()].sort(
    (a, b) =>
      Number(!!a.group) - Number(!!b.group) ||
      a.group.localeCompare(b.group) ||
      a.kind.localeCompare(b.kind),
  );
}

/** Kinds matching every word of `query` (kind, plural, short names, group). */
export function filterKinds(kinds: readonly KindEntry[], query: string): KindEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...kinds];
  return kinds.filter((k) => {
    const hay = `${k.kind} ${k.plural} ${k.shortNames.join(' ')} ${k.group}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Every served version of a group, from the OpenAPI index (newest-looking first). */
export function versionsOf(index: OpenApiIndex | null, group: string, fallback: string): string[] {
  const versions = (index?.group_versions ?? [])
    .filter((gv) => gv.group === group)
    .map((gv) => gv.api_version);
  if (!versions.includes(fallback)) versions.push(fallback);
  return versions.sort((a, b) => compareVersions(b, a));
}

/** Kubernetes version priority: GA > beta > alpha, then by number (`v2` > `v1beta2`). */
export function compareVersions(a: string, b: string): number {
  const rank = (apiVersion: string) => {
    const version = apiVersion.slice(apiVersion.lastIndexOf('/') + 1);
    const m = /^v(\d+)(?:(alpha|beta)(\d+))?$/.exec(version);
    if (!m) return [-1, 0, 0];
    const stage = m[2] === 'alpha' ? 0 : m[2] === 'beta' ? 1 : 2;
    return [stage, Number(m[1]), Number(m[3] ?? 0)];
  };
  const [sa = 0, ma = 0, na = 0] = rank(a);
  const [sb = 0, mb = 0, nb = 0] = rank(b);
  return sa - sb || ma - mb || na - nb;
}
