/**
 * Line diff (Myers, O((N+M)·D)) for YAML previews, summaries and the
 * non-Monaco fallback of `DiffView`. Common prefix/suffix are trimmed first,
 * so the typical "a few fields changed" diff stays tiny; pathological inputs
 * past `MAX_EDIT_DISTANCE` degrade to one delete + one insert block instead
 * of burning memory.
 */

export type DiffOpType = 'equal' | 'insert' | 'delete';

export interface DiffOp {
  type: DiffOpType;
  lines: string[];
}

export interface DiffStats {
  added: number;
  removed: number;
  /** True when both sides are line-for-line identical. */
  identical: boolean;
}

const MAX_EDIT_DISTANCE = 4000;

export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function push(ops: DiffOp[], type: DiffOpType, line: string) {
  const last = ops[ops.length - 1];
  if (last && last.type === type) last.lines.push(line);
  else ops.push({ type, lines: [line] });
}

function myers(a: string[], b: string[]): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] = the `v` window [-d-1, d+1] as it was *before* step d.
  const trace: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }
  if (found < 0) return null;

  const reversed: Array<[DiffOpType, string]> = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const w = trace[d]!;
    const at = (k: number) => w[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      reversed.push(['equal', a[x - 1]!]);
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) reversed.push(['insert', b[y - 1]!]);
      else reversed.push(['delete', a[x - 1]!]);
    }
    x = prevX;
    y = prevY;
  }
  const ops: DiffOp[] = [];
  for (let i = reversed.length - 1; i >= 0; i--) push(ops, reversed[i]![0], reversed[i]![1]);
  return ops;
}

/** Line-level edit script turning `original` into `modified`. */
export function diffLines(original: string, modified: string): DiffOp[] {
  const a = splitLines(original);
  const b = splitLines(modified);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: DiffOp[] = [];
  if (start > 0) ops.push({ type: 'equal', lines: a.slice(0, start) });
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle = myers(midA, midB) ?? [
    ...(midA.length ? [{ type: 'delete' as const, lines: midA }] : []),
    ...(midB.length ? [{ type: 'insert' as const, lines: midB }] : []),
  ];
  for (const op of middle) for (const line of op.lines) push(ops, op.type, line);
  if (endA < a.length) {
    for (const line of a.slice(endA)) push(ops, 'equal', line);
  }
  return ops;
}

export function diffStats(ops: DiffOp[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'insert') added += op.lines.length;
    else if (op.type === 'delete') removed += op.lines.length;
  }
  return { added, removed, identical: added === 0 && removed === 0 };
}

/** Convenience: stats without keeping the edit script around. */
export function compareText(original: string, modified: string): DiffStats {
  if (original === modified) return { added: 0, removed: 0, identical: true };
  return diffStats(diffLines(original, modified));
}
