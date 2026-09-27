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
