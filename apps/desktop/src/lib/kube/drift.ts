/**
 * Field-level drift between two normalised objects (see `normalize.ts`):
 * which leaf paths differ, in reading order, so a drift table can say
 * "spec.replicas 3 → 2" instead of only "+1 −1". Arrays of named items
 * (containers, env, ports, volumes) are matched by `name` rather than by
 * position, so reordering is not reported as change.
 */

export interface FieldChange {
  /** `spec.template.spec.containers[app].image` */
  path: string;
  kind: 'changed' | 'added' | 'removed';
  before?: unknown;
  after?: unknown;
}

type Json = unknown;

function isObject(v: Json): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function named(list: Json[]): Map<string, Json> | null {
  const out = new Map<string, Json>();
  for (const item of list) {
    if (!isObject(item) || typeof item.name !== 'string' || out.has(item.name)) return null;
    out.set(item.name, item);
  }
  return out;
}

function same(a: Json, b: Json): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Leaf changes turning `a` into `b`, at most `limit`. */
export function diffPaths(a: Json, b: Json, limit = 50): FieldChange[] {
  const out: FieldChange[] = [];
  const walk = (x: Json, y: Json, path: string) => {
    if (out.length >= limit || same(x, y)) return;
    if (x === undefined) {
      out.push({ path, kind: 'added', after: y });
      return;
    }
    if (y === undefined) {
      out.push({ path, kind: 'removed', before: x });
      return;
    }
    if (isObject(x) && isObject(y)) {
      const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])];
      for (const key of keys) walk(x[key], y[key], path ? `${path}.${key}` : key);
      return;
    }
    if (Array.isArray(x) && Array.isArray(y)) {
      const nx = named(x);
      const ny = named(y);
      if (nx && ny) {
        const keys = [...new Set([...nx.keys(), ...ny.keys()])];
        for (const key of keys) walk(nx.get(key), ny.get(key), `${path}[${key}]`);
        return;
      }
      const n = Math.max(x.length, y.length);
      for (let i = 0; i < n; i++) walk(x[i], y[i], `${path}[${i}]`);
      return;
    }
    out.push({ path, kind: 'changed', before: x, after: y });
  };
  walk(a, b, '');
  return out;
}

/** Compact value for one-line summaries (`"2.14.3"`, `3`, `{…}`). */
export function shortValue(value: unknown, max = 32): string {
  if (value === undefined) return '∅';
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null)
    return String(value);
  return Array.isArray(value) ? '[…]' : '{…}';
}

/** The last `keep` segments of a change path (`…env[MODE].value`), for narrow columns. */
export function shortPath(path: string, keep = 2): string {
  const segments: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of path) {
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === '.' && depth === 0) {
      segments.push(current);
      current = '';
    } else current += ch;
  }
  segments.push(current);
  return segments.length > keep + 1 ? `…${segments.slice(-keep).join('.')}` : path;
}
