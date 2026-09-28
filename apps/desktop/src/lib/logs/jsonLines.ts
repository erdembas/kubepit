/**
 * Pretty JSON as a flat list of lines (the layout of
 * `JSON.stringify(value, null, 2)`), each leaf carrying its flattened
 * field path (`http.status`) so the detail view can turn a click on a
 * value into a `path=value` filter. Pure.
 */

export type JsonTokenKind = 'string' | 'number' | 'boolean' | 'null' | 'punct';

export interface JsonLine {
  depth: number;
  /** Object key of this line (null inside arrays and for closers). */
  key: string | null;
  /** Rendered value text (`"a"`, `12`, `{`, `]` …) without the trailing comma. */
  text: string;
  kind: JsonTokenKind;
  /** Flattened path of a leaf inside objects only (arrays have no filter path). */
  path: string | null;
  /** Filter value of a leaf (strings unquoted). */
  value: string | null;
  comma: boolean;
}

/** Longest value text shown before it is cut (the full value stays filterable). */
const MAX_TEXT = 2_000;

function leaf(value: unknown): { text: string; kind: JsonTokenKind; value: string } {
  if (value === null) return { text: 'null', kind: 'null', value: 'null' };
  if (typeof value === 'string') {
    const quoted = JSON.stringify(value);
    return {
      text: quoted.length > MAX_TEXT ? `${quoted.slice(0, MAX_TEXT)}…"` : quoted,
      kind: 'string',
      value,
    };
  }
  if (typeof value === 'number')
    return { text: String(value), kind: 'number', value: String(value) };
  if (typeof value === 'boolean')
    return { text: String(value), kind: 'boolean', value: String(value) };
  return { text: JSON.stringify(value) ?? 'null', kind: 'punct', value: '' };
}

export function jsonLines(value: unknown, maxLines = 2_000): JsonLine[] {
  const out: JsonLine[] = [];
  const walk = (
    v: unknown,
    depth: number,
    key: string | null,
    path: string | null,
    comma: boolean,
  ) => {
    if (out.length >= maxLines) return;
    if (v && typeof v === 'object') {
      const isArray = Array.isArray(v);
      const entries: [string | null, unknown][] = isArray
        ? (v as unknown[]).map((item) => [null, item])
        : Object.entries(v as Record<string, unknown>);
      if (entries.length === 0) {
        out.push({
          depth,
          key,
          text: isArray ? '[]' : '{}',
          kind: 'punct',
          path: null,
          value: null,
          comma,
        });
        return;
      }
      out.push({
        depth,
        key,
        text: isArray ? '[' : '{',
        kind: 'punct',
        path: null,
        value: null,
        comma: false,
      });
      entries.forEach(([k, child], i) => {
        // The root's path is '' (children are top-level keys); array items have none.
        const childPath = isArray || path === null ? null : path ? `${path}.${k}` : k;
        walk(child, depth + 1, k, childPath, i < entries.length - 1);
      });
      out.push({
        depth,
        key: null,
        text: isArray ? ']' : '}',
        kind: 'punct',
        path: null,
        value: null,
        comma,
      });
      return;
    }
    const l = leaf(v);
    out.push({
      depth,
      key,
      text: l.text,
      kind: l.kind,
      path,
      value: path === null ? null : l.value,
      comma,
    });
  };
  walk(value, 0, null, '', false);
  return out;
}
