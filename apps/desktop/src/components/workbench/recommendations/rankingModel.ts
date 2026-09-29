import type { RankRow } from '@/lib/kube/recommendations/model';

/** Pure helpers of the Recommendations usage ranking (search and pages). */

export const RANK_PAGE_SIZE = 8;

/** A ranking row with its place in the whole ranking (1-based). */
export interface RankedRow extends RankRow {
  rank: number;
}

/**
 * The rows matching every word of `query` in their namespace, workload
 * (kind and name) or container, keeping their rank in the whole ranking.
 */
export function searchRanking(rows: readonly RankRow[], query: string): RankedRow[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const out: RankedRow[] = [];
  rows.forEach((row, i) => {
    const text =
      `${row.rec.kind} ${row.rec.namespace}/${row.rec.name} ${row.container}`.toLowerCase();
    if (terms.every((t) => text.includes(t))) out.push({ ...row, rank: i + 1 });
  });
  return out;
}

export interface Page<T> {
  rows: T[];
  /** The page shown (clamped, 0-based). */
  page: number;
  pages: number;
  /** 1-based positions of the first and last row shown (0 when empty). */
  from: number;
  to: number;
}

/** One page of `rows`; a page past the end shows the last one. */
export function pageOf<T>(rows: readonly T[], page: number, size = RANK_PAGE_SIZE): Page<T> {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const shown = Math.min(Math.max(0, Math.floor(page) || 0), pages - 1);
  const start = shown * size;
  const slice = rows.slice(start, start + size);
  return {
    rows: slice,
    page: shown,
    pages,
    from: slice.length ? start + 1 : 0,
    to: start + slice.length,
  };
}
