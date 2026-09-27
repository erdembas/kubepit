/**
 * Semver ordering for Helm chart versions, mirroring `compare_versions` in
 * `crates/kubepit-core/src/helm_charts.rs`: a leading `v` and build metadata
 * are ignored, missing core parts count as 0, a pre-release sorts before its
 * release, and unparseable versions sort before every parseable one.
 */

interface Parsed {
  core: number[];
  pre: string | null;
}

function parse(raw: string): Parsed | null {
  const v =
    raw
      .trim()
      .replace(/^[vV]+/, '')
      .split('+')[0] ?? '';
  const dash = v.indexOf('-');
  const core = dash < 0 ? v : v.slice(0, dash);
  const pre = dash < 0 ? null : v.slice(dash + 1);
  const parts = core.split('.');
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  return { core: parts.map(Number), pre };
}

function comparePre(a: string, b: string): number {
  const x = a.split('.');
  const y = b.split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    const order = pn && qn ? Number(p) - Number(q) : pn ? -1 : qn ? 1 : p < q ? -1 : p > q ? 1 : 0;
    if (order) return Math.sign(order);
  }
  return 0;
}

/** Negative when `a` is older than `b`, positive when newer, 0 when equal. */
export function compareVersions(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return x ? 1 : y ? -1 : a < b ? -1 : a > b ? 1 : 0;
  for (let i = 0; i < Math.max(x.core.length, y.core.length, 3); i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === null || y.pre === null) return x.pre === y.pre ? 0 : x.pre === null ? 1 : -1;
  return comparePre(x.pre, y.pre);
}

export function isPrerelease(version: string): boolean {
  return parse(version)?.pre != null;
}

/** Newest first. */
export function sortVersionsDesc<T extends { version: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => compareVersions(b.version, a.version));
}
