/**
 * Name matching for fleet search — the TypeScript twin of `NameMatcher` in
 * `crates/kubepit-core/src/fleet_search.rs`, used by the demo backend and to
 * highlight matches in results. Rules:
 *
 * - `""` matches every name;
 * - `/…/` is a case-insensitive regular expression;
 * - otherwise whitespace-separated terms must all match: a term with `*` or
 *   `?` is a whole-name glob, anything else a case-insensitive substring.
 */

export type NameMatcher = (name: string) => boolean;

function isRegex(text: string) {
  return text.length >= 2 && text.startsWith('/') && text.endsWith('/');
}

function globToRegExp(glob: string): RegExp {
  const body = glob
    .split('')
    .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`, 'i');
}

/** Throws `SyntaxError` for an invalid `/regex/`. */
export function compileNameMatcher(text: string): NameMatcher {
  const trimmed = text.trim();
  if (!trimmed) return () => true;
  if (isRegex(trimmed)) {
    const re = new RegExp(trimmed.slice(1, -1), 'i');
    return (name) => re.test(name);
  }
  const terms = trimmed
    .toLowerCase()
    .split(/\s+/)
    .map((term) => (/[*?]/.test(term) ? globToRegExp(term) : term));
  return (name) => {
    const lower = name.toLowerCase();
    return terms.every((term) =>
      typeof term === 'string' ? lower.includes(term) : term.test(name),
    );
  };
}

/** Character ranges `[start, end)` of `name` to highlight for `text`, merged and sorted. */
export function matchRanges(text: string, name: string): Array<[number, number]> {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const ranges: Array<[number, number]> = [];
  if (isRegex(trimmed)) {
    try {
      const m = new RegExp(trimmed.slice(1, -1), 'i').exec(name);
      if (m && m[0].length) ranges.push([m.index, m.index + m[0].length]);
    } catch {
      /* invalid regex: nothing to highlight */
    }
    return ranges;
  }
  const lower = name.toLowerCase();
  for (const term of trimmed.toLowerCase().split(/\s+/)) {
    if (/[*?]/.test(term)) continue;
    const at = lower.indexOf(term);
    if (at >= 0) ranges.push([at, at + term.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}
