/**
 * The demo mirror of `change_journal::diff::dropped_paths`: what a Helm
 * upgrade removes from a live object. Paths use the Changes view's syntax
 * (`metadata.annotations["example.com/x"]`, `containers[api].env[DEBUG]`);
 * list items carrying a unique `name` (or `mountPath`) are matched by it.
 */

type Json = Record<string, unknown>;
type Segment = { key: string } | { field: string; item: string } | { index: number };

const ITEM_KEYS = ['name', 'mountPath'];
const isMap = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function scalarKey(v: unknown): string | null {
  if (typeof v === 'string') return v || null;
  return typeof v === 'number' ? String(v) : null;
}

/** The field both lists' items can be matched by (unique on each side), if any. */
function itemKey(a: unknown[], b: unknown[]): string | null {
  if (!a.length && !b.length) return null;
  const unique = (items: unknown[], field: string) => {
    const seen = new Set<string>();
    return items.every((item) => {
      const key = isMap(item) ? scalarKey(item[field]) : null;
      if (key === null || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  return ITEM_KEYS.find((field) => unique(a, field) && unique(b, field)) ?? null;
}

/** An empty map or list (`resources: {}`): the API server keeps it anyway. */
const isEmpty = (v: unknown) =>
  Array.isArray(v) ? v.length === 0 : isMap(v) && Object.keys(v).length === 0;

/** Nodes `before` has and `after` lacks (never empty ones), in `changed_paths` order. */
function removals(before: unknown, after: unknown, path: Segment[], out: Segment[][]) {
  if (after === undefined) {
    if (!isEmpty(before)) out.push(path);
    return;
  }
  if (same(before, after)) return;
  if (isMap(before) && isMap(after)) {
    for (const key of Object.keys(before).sort())
      removals(before[key], after[key], [...path, { key }], out);
  } else if (Array.isArray(before) && Array.isArray(after)) {
    const field = itemKey(before, after);
    if (field) {
      const keyOf = (v: unknown) => (isMap(v) ? scalarKey(v[field]) : null);
      for (const b of after) {
        const a = before.find((a) => keyOf(a) === keyOf(b));
        if (a !== undefined) removals(a, b, [...path, { field, item: keyOf(b)! }], out);
      }
      for (const a of before)
        if (!after.some((b) => keyOf(b) === keyOf(a)))
          out.push([...path, { field, item: keyOf(a)! }]);
    } else {
      before.forEach((a, index) => removals(a, after[index], [...path, { index }], out));
    }
  }
}

function lookup(value: unknown, path: Segment[]): unknown {
  let node = value;
  for (const segment of path) {
    if ('key' in segment) node = isMap(node) ? node[segment.key] : undefined;
    else if ('field' in segment)
      node = Array.isArray(node)
        ? node.find((item) => isMap(item) && scalarKey(item[segment.field]) === segment.item)
        : undefined;
    else node = Array.isArray(node) ? node[segment.index] : undefined;
    if (node === undefined) return undefined;
  }
  return node;
}

function formatPath(path: Segment[]): string {
  return path
    .map((segment, i) => {
      if ('key' in segment)
        return /^[A-Za-z0-9_-]+$/.test(segment.key)
          ? `${i > 0 ? '.' : ''}${segment.key}`
          : `[${JSON.stringify(segment.key)}]`;
      return 'field' in segment ? `[${segment.item}]` : `[${segment.index}]`;
    })
    .join('');
}

/** Paths in the old render, absent from the new one and still live (helm removes them). */
export function droppedPaths(before: unknown, after: unknown, live: unknown): string[] {
  const out: Segment[][] = [];
  removals(before, after, [], out);
  return out.filter((path) => (lookup(live, path) ?? null) !== null).map(formatPath);
}
