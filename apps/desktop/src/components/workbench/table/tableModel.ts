import type { ColumnContext, ColumnDef, KindColumns } from '@/lib/kube/columns';
import type { SortPref } from '@/store/useWorkbenchStore';
import type { KubeObject } from '@/types';

/** Pure filter + sort for resource tables (runs on every watch flush). */

export function filterItems(
  items: readonly KubeObject[],
  text: string,
  kind: KindColumns,
): KubeObject[] {
  const tokens = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return items as KubeObject[];
  return items.filter((o) => {
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
