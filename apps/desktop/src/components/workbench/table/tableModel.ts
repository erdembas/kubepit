import type { ColumnContext, ColumnDef, KindColumns } from '@/lib/kube/columns';
import type { SortPref } from '@/store/useWorkbenchStore';
import type { KubeObject } from '@/types';

/** Pure filter + sort for resource tables (runs on every watch flush). */

/** Whitespace-separated tokens; a double-quoted run (`"a b"`) stays in one token. */
const TOKEN = /(?:[^\s"]+|"[^"]*"?)+/g;
/** `<column id>:<values>` (the values may be empty while typing). */
const FACET_TOKEN = /^([a-z][\w-]*):(.*)$/i;

const tokenize = (text: string): string[] => text.match(TOKEN) ?? [];

/** The facet column a token key names (`status` in `status:Running`), if any. */
function facetColumn(kind: KindColumns, key: string): ColumnDef | undefined {
  const id = key.toLowerCase();
  return kind.columns.find((c) => c.facet && c.id.toLowerCase() === id);
}

/** `a,"b c",d` → `['a', 'b c', 'd']`. */
export function splitFacetValues(raw: string): string[] {
  const out: string[] = [];
  for (const m of raw.matchAll(/"([^"]*)"?|([^,]+)/g)) {
    const value = (m[1] ?? m[2] ?? '').trim();
    if (value) out.push(value);
  }
  return out;
}

/** Quotes a value that would otherwise split the token. */
export function quoteFacetValue(value: string): string {
  return /[\s,"]/.test(value) ? `"${value.replace(/"/g, '')}"` : value;
}

const facetList = (value: string | readonly string[]): readonly string[] =>
  typeof value === 'string' ? [value] : value;

interface FacetFilter {
  column: ColumnDef;
  /** Lower-cased; any one of them matches. */
  values: Set<string>;
}

/**
 * Splits filter text into facet filters (tokens naming a facet column; repeats
 * of one column are merged) and plain lower-cased terms.
 */
export function parseFilter(
  text: string,
  kind: KindColumns,
): { facets: FacetFilter[]; terms: string[] } {
  const facets = new Map<string, FacetFilter>();
  const terms: string[] = [];
  for (const token of tokenize(text)) {
    const m = FACET_TOKEN.exec(token);
    const column = m ? facetColumn(kind, m[1]!) : undefined;
    if (m && column) {
      const entry = facets.get(column.id) ?? { column, values: new Set<string>() };
      for (const value of splitFacetValues(m[2]!)) entry.values.add(value.toLowerCase());
      facets.set(column.id, entry);
      continue;
    }
    const term = token.replace(/"/g, '').toLowerCase();
    if (term) terms.push(term);
  }
  // `status:` with nothing picked yet filters nothing.
  return { facets: [...facets.values()].filter((f) => f.values.size), terms };
}

/** The values `text` picks for `columnId`, as written (first spelling wins). */
export function facetSelection(text: string, kind: KindColumns, columnId: string): string[] {
  const seen = new Map<string, string>();
  for (const token of tokenize(text)) {
    const m = FACET_TOKEN.exec(token);
    if (!m || facetColumn(kind, m[1]!)?.id !== columnId) continue;
    for (const value of splitFacetValues(m[2]!))
      if (!seen.has(value.toLowerCase())) seen.set(value.toLowerCase(), value);
  }
  return [...seen.values()];
}

/** `text` with `columnId`'s facet token replaced by one picking `values` (none removes it). */
export function withFacet(
  text: string,
  kind: KindColumns,
  columnId: string,
  values: readonly string[],
): string {
  const kept = tokenize(text).filter((token) => {
    const m = FACET_TOKEN.exec(token);
    return !(m && facetColumn(kind, m[1]!)?.id === columnId);
  });
  if (values.length) kept.push(`${columnId}:${values.map(quoteFacetValue).join(',')}`);
  return kept.join(' ');
}

/** Distinct values of a facet column and how many items carry each, most common first. */
export function facetCounts(
  items: readonly KubeObject[],
  column: ColumnDef,
): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  if (!column.facet) return [];
  for (const o of items) {
    for (const value of new Set(facetList(column.facet(o))))
      if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || collator.compare(a.value, b.value));
}

export function filterItems(
  items: readonly KubeObject[],
  text: string,
  kind: KindColumns,
): KubeObject[] {
  const { facets, terms: tokens } = parseFilter(text, kind);
  if (!tokens.length && !facets.length) return items as KubeObject[];
  return items.filter((o) => {
    for (const f of facets) {
      if (!facetList(f.column.facet!(o)).some((v) => f.values.has(v.toLowerCase()))) return false;
    }
    const labels = o.metadata.labels ?? {};
    let haystack: string | null = null;
    return tokens.every((token) => {
      const eq = token.indexOf('=');
      if (eq > 0) {
        const k = token.slice(0, eq);
        const v = token.slice(eq + 1);
        return Object.entries(labels).some(
          ([lk, lv]) => lk.toLowerCase() === k && (v === '' || lv.toLowerCase() === v),
        );
      }
      haystack ??= [
        o.metadata.name,
        o.metadata.namespace ?? '',
        ...Object.entries(labels).map(([k, v]) => `${k}=${v}`),
        kind.searchText?.(o) ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(token);
    });
  });
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function resolveSort(kind: KindColumns, pref: SortPref | undefined): SortPref {
  if (pref && kind.columns.some((c) => c.id === pref.column)) return pref;
  return kind.defaultSort ?? { column: 'name', desc: false };
}

export function sortItems(
  items: KubeObject[],
  columns: ColumnDef[],
  sort: SortPref,
  ctx: ColumnContext,
): KubeObject[] {
  const col = columns.find((c) => c.id === sort.column);
  const key = col?.sort ?? ((o: KubeObject) => o.metadata.name);
  const keyed = items.map((o) => ({ o, k: key(o, ctx) }));
  const dir = sort.desc ? -1 : 1;
  keyed.sort((a, b) => {
    let r = 0;
    if (typeof a.k === 'number' && typeof b.k === 'number') r = a.k - b.k;
    else r = collator.compare(String(a.k), String(b.k));
    if (r === 0) {
      r = collator.compare(a.o.metadata.namespace ?? '', b.o.metadata.namespace ?? '');
      if (r === 0) r = collator.compare(a.o.metadata.name, b.o.metadata.name);
      return r;
    }
    return r * dir;
  });
  return keyed.map((x) => x.o);
}

/** `minmax(180px, 3fr)` → 180, `96px` → 96: used for the table's min width. */
export function trackMin(width: string): number {
  const m = /(\d+)px/.exec(width);
  return m ? Number(m[1]) : 80;
}

/** Narrowest and widest a dragged column may get. */
export const COLUMN_WIDTH = { min: 40, max: 1200 };

/**
 * Columns in the user's order: movable columns follow `order` (ids missing
 * from it, e.g. new printer columns, keep their default place after the
 * ordered ones), fixed columns stay where the kind defines them.
 */
export function orderColumns<C extends { id: string; fixed?: boolean }>(
  columns: readonly C[],
  order: readonly string[] | undefined,
): C[] {
  if (!order?.length) return columns as C[];
  const rank = new Map(order.map((id, i) => [id, i]));
  const movable = columns
    .filter((c) => !c.fixed)
    .map((c, i) => ({ c, key: rank.get(c.id) ?? order.length + i }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.c);
  let next = 0;
  return columns.map((c) => (c.fixed ? c : movable[next++]!));
}

/** Move `id` to `to`'s position among the movable columns; returns the new id order. */
export function moveColumn<C extends { id: string; fixed?: boolean }>(
  columns: readonly C[],
  id: string,
  to: string,
): string[] {
  const ids = columns.filter((c) => !c.fixed).map((c) => c.id);
  const from = ids.indexOf(id);
  const target = ids.indexOf(to);
  if (from < 0 || target < 0 || from === target) return ids;
  ids.splice(from, 1);
  ids.splice(target, 0, id);
  return ids;
}

/** Replace the grid track of every column the user resized. */
export function applyWidths<C extends { id: string; width: string }>(
  columns: readonly C[],
  widths: Readonly<Record<string, number>> | undefined,
): C[] {
  if (!widths || !Object.keys(widths).length) return columns as C[];
  return columns.map((c) => {
    const px = widths[c.id];
    return px ? { ...c, width: `${clampWidth(px)}px` } : c;
  });
}

export function clampWidth(px: number): number {
  return Math.round(Math.min(COLUMN_WIDTH.max, Math.max(COLUMN_WIDTH.min, px)));
}
