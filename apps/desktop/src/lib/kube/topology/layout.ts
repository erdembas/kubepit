/**
 * Deterministic layered layout for the relationship map.
 *
 * 1. Columns come from the node tier (Ingress/Route → Service → Workload →
 *    ReplicaSet/Job → Pods → Config/Storage/Identity → … → Node); empty
 *    tiers collapse.
 * 2. Barycenter sweeps (alternating left→right / right→left) reorder each
 *    column by the mean rank of its neighbours to reduce crossings.
 * 3. Coordinates: each column is placed at the mean height of its
 *    neighbours, keeping the order and the minimum spacing (isotonic
 *    regression, pool-adjacent-violators), for a few alternating passes.
 * 4. Edges are smooth cubic curves from side to side.
 *
 * Linear-ish in nodes + edges per pass, so a few hundred nodes lay out in
 * well under a frame.
 */

export const NODE_W = 208;
export const NODE_H = 46;
export const COL_GAP = 96;
export const ROW_GAP = 14;
export const PAD = 40;

export interface LayoutNodeInput {
  id: string;
  tier: number;
}

export interface LayoutEdgeInput {
  id: string;
  from: string;
  to: string;
}

export interface PlacedNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  col: number;
}

export interface PlacedEdge {
  id: string;
  from: string;
  to: string;
  d: string;
}

export interface TopologyLayout {
  nodes: ReadonlyMap<string, PlacedNode>;
  edges: PlacedEdge[];
  /** Node ids per column, top to bottom. */
  columns: string[][];
  width: number;
  height: number;
}

const ORDER_PASSES = 8;
const COORD_PASSES = 6;
const STEP = NODE_H + ROW_GAP;

/** Least-squares placement of ordered items with a minimum spacing (PAV). */
export function placeOrdered(desired: readonly number[], spacing: number): number[] {
  const n = desired.length;
  // Shift so the constraint becomes "non-decreasing".
  const target = desired.map((d, i) => d - i * spacing);
  const sums: number[] = [];
  const counts: number[] = [];
  for (const value of target) {
    sums.push(value);
    counts.push(1);
    while (sums.length > 1) {
      const last = sums.length - 1;
      if (sums[last - 1]! / counts[last - 1]! <= sums[last]! / counts[last]!) break;
      sums[last - 1]! += sums[last]!;
      counts[last - 1]! += counts[last]!;
      sums.pop();
      counts.pop();
    }
  }
  const out: number[] = [];
  for (let b = 0; b < sums.length; b++) {
    const mean = sums[b]! / counts[b]!;
    for (let k = 0; k < counts[b]!; k++) out.push(mean + out.length * spacing);
  }
  return out.slice(0, n);
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Smooth side-to-side curve between two placed nodes. */
export function edgePath(a: PlacedNode, b: PlacedNode): string {
  const ay = a.y + a.h / 2;
  const by = b.y + b.h / 2;
  if (a.col === b.col) {
    // Same column: loop out on the right.
    const x = a.x + a.w;
    const bulge = 36 + Math.min(80, Math.abs(by - ay) / 4);
    return `M${x},${ay} C${x + bulge},${ay} ${x + bulge},${by} ${x},${by}`;
  }
  const forward = b.col > a.col;
  const x1 = forward ? a.x + a.w : a.x;
  const x2 = forward ? b.x : b.x + b.w;
  const dx = Math.max(32, Math.abs(x2 - x1) * 0.5) * (forward ? 1 : -1);
  return `M${x1},${ay} C${x1 + dx},${ay} ${x2 - dx},${by} ${x2},${by}`;
}

export function layoutTopology(
  nodes: readonly LayoutNodeInput[],
  edges: readonly LayoutEdgeInput[],
): TopologyLayout {
  const tiers = [...new Set(nodes.map((n) => n.tier))].sort((a, b) => a - b);
  const colOf = new Map<string, number>();
  const columns: string[][] = tiers.map(() => []);
  for (const n of nodes) {
    const col = tiers.indexOf(n.tier);
    colOf.set(n.id, col);
    columns[col]!.push(n.id);
  }

  const neighbours = new Map<string, string[]>();
  for (const n of nodes) neighbours.set(n.id, []);
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.from === e.to || !colOf.has(e.from) || !colOf.has(e.to)) continue;
    const key = e.from < e.to ? `${e.from}\n${e.to}` : `${e.to}\n${e.from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    neighbours.get(e.from)!.push(e.to);
    neighbours.get(e.to)!.push(e.from);
  }

  // Connected nodes first; isolated ones settle at the bottom of their column.
  const connected = (id: string) => neighbours.get(id)!.length > 0;
  for (let c = 0; c < columns.length; c++) {
    const col = columns[c]!;
    columns[c] = [...col.filter(connected), ...col.filter((id) => !connected(id))];
  }

  const rank = new Map<string, number>();
  const setRanks = (c: number) => {
    const col = columns[c]!;
    col.forEach((id, i) => rank.set(id, (i + 0.5) / col.length));
  };
  columns.forEach((_, c) => setRanks(c));

  for (let pass = 0; pass < ORDER_PASSES; pass++) {
    const forward = pass % 2 === 0;
    for (let step = 0; step < columns.length; step++) {
      const c = forward ? step : columns.length - 1 - step;
      const col = columns[c]!;
      const keyed = col.map((id, index) => {
        const all = neighbours.get(id)!;
        const fixed = all.filter((n) => (forward ? colOf.get(n)! < c : colOf.get(n)! > c));
        const pool = fixed.length ? fixed : all;
        const bary = mean(pool.map((n) => rank.get(n)!));
        return { id, index, key: bary ?? rank.get(id)!, isolated: !all.length };
      });
      keyed.sort(
        (a, b) => Number(a.isolated) - Number(b.isolated) || a.key - b.key || a.index - b.index,
      );
      columns[c] = keyed.map((k) => k.id);
      setRanks(c);
    }
  }

  // Coordinates.
  const y = new Map<string, number>();
  const tallest = Math.max(0, ...columns.map((col) => col.length));
  columns.forEach((col) => {
    const offset = ((tallest - col.length) * STEP) / 2;
    col.forEach((id, i) => y.set(id, offset + i * STEP));
  });
  for (let pass = 0; pass < COORD_PASSES; pass++) {
    const forward = pass % 2 === 0;
    for (let step = 0; step < columns.length; step++) {
      const c = forward ? step : columns.length - 1 - step;
      const col = columns[c]!;
      if (!col.length) continue;
      const desired = col.map((id) => {
        const others = neighbours.get(id)!.filter((n) => colOf.get(n) !== c);
        return mean(others.map((n) => y.get(n)!)) ?? y.get(id)!;
      });
      // Isolated nodes follow the column instead of pinning it.
      for (let i = 0; i < col.length; i++)
        if (!connected(col[i]!)) desired[i] = i > 0 ? desired[i - 1]! + STEP : desired[i]!;
      placeOrdered(desired, STEP).forEach((value, i) => y.set(col[i]!, value));
    }
  }

  let minY = Infinity;
  let maxY = -Infinity;
  for (const value of y.values()) {
    minY = Math.min(minY, value);
    maxY = Math.max(maxY, value);
  }
  if (!Number.isFinite(minY)) {
    minY = 0;
    maxY = -NODE_H;
  }

  const placed = new Map<string, PlacedNode>();
  for (const n of nodes) {
    const col = colOf.get(n.id)!;
    placed.set(n.id, {
      id: n.id,
      x: PAD + col * (NODE_W + COL_GAP),
      y: Math.round(PAD + y.get(n.id)! - minY),
      w: NODE_W,
      h: NODE_H,
      col,
    });
  }

  const outEdges: PlacedEdge[] = [];
  for (const e of edges) {
    const a = placed.get(e.from);
    const b = placed.get(e.to);
    if (!a || !b || a === b) continue;
    outEdges.push({ id: e.id, from: e.from, to: e.to, d: edgePath(a, b) });
  }

  return {
    nodes: placed,
    edges: outEdges,
    columns,
    width: PAD * 2 + Math.max(0, columns.length * (NODE_W + COL_GAP) - COL_GAP),
    height: Math.ceil(PAD * 2 + Math.max(0, maxY - minY + NODE_H)),
  };
}

export type Direction = 'up' | 'down' | 'left' | 'right';

/**
 * Keyboard navigation: the next node in the same column (up/down) or the
 * vertically nearest node in the next non-empty column (left/right).
 */
export function nodeInDirection(
  layout: TopologyLayout,
  fromId: string | null,
  dir: Direction,
): string | null {
  const from = fromId ? layout.nodes.get(fromId) : undefined;
  if (!from) return layout.columns.find((c) => c.length)?.[0] ?? null;
  if (dir === 'up' || dir === 'down') {
    const col = layout.columns[from.col]!;
    const i = col.indexOf(from.id) + (dir === 'up' ? -1 : 1);
    return col[i] ?? null;
  }
  const stepCol = dir === 'left' ? -1 : 1;
  for (let c = from.col + stepCol; c >= 0 && c < layout.columns.length; c += stepCol) {
    const col = layout.columns[c]!;
    if (!col.length) continue;
    let best: string | null = null;
    let bestDist = Infinity;
    for (const id of col) {
      const d = Math.abs(layout.nodes.get(id)!.y - from.y);
      if (d < bestDist) {
        best = id;
        bestDist = d;
      }
    }
    return best;
  }
  return null;
}
