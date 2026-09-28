import { parse } from 'yaml';
import { normalizedYaml } from '@/lib/kube/normalize';
import type {
  ClusterDef,
  ClusterId,
  DryRunResult,
  KubeObject,
  ManifestApplyResult,
  ManifestDocument,
} from '@/types';
import { deniedKey } from './access';

/**
 * Pure model of a fleet review: N documents dry-run against M targets
 * (cluster + default namespace), shown as a matrix, then applied where the
 * user selected. Shared by the Manifests tab and "Sync to…" in compare.
 */

/** One object of the reviewed set (a rendered manifest or a synced object). */
export interface ReviewDoc {
  id: string;
  /** Source file (manifests) or origin label (sync). */
  source: string;
  line: number;
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string | null;
  yaml: string;
}

export function reviewDoc(doc: ManifestDocument): ReviewDoc {
  return {
    id: doc.id,
    source: doc.source,
    line: doc.line,
    apiVersion: doc.api_version,
    kind: doc.kind,
    name: doc.name,
    namespace: doc.namespace,
    yaml: doc.yaml,
  };
}

/** Where the set is diffed / applied. `namespace` fills objects without one. */
export interface ReviewTarget {
  key: string;
  clusterId: ClusterId;
  namespace: string | null;
  readOnly: boolean;
  production: boolean;
}

export function reviewTarget(cluster: ClusterDef, namespace: string | null): ReviewTarget {
  return {
    key: `${cluster.id}|${namespace ?? ''}`,
    clusterId: cluster.id,
    namespace,
    readOnly: cluster.read_only,
    production: cluster.environment === 'production',
  };
}

export type Badge = 'create' | 'update' | 'unchanged' | 'error';
export const BADGES: Badge[] = ['create', 'update', 'unchanged', 'error'];

/**
 * The dry run could not check a document because another document of the
 * same set creates what it needs first: its namespace, or its CRD. The
 * apply order handles both, so such a document counts as `create`.
 */
export type Pending = 'namespace' | 'crd';

export interface Cell {
  badge: Badge;
  result: DryRunResult;
  pending: Pending | null;
}

export type TargetRun =
  { status: 'running' } | { status: 'done'; cells: Cell[] } | { status: 'error'; message: string };

export type ApplyCell =
  | { status: 'running' }
  | { status: 'ok'; object: KubeObject | null }
  | { status: 'error'; message: string };

export type ApplyRun =
  | { status: 'running'; cells: Record<number, ApplyCell> }
  | { status: 'done'; cells: Record<number, ApplyCell> }
  | { status: 'error'; message: string; cells: Record<number, ApplyCell> };

const NAMESPACE_MISSING = /namespaces? "([^"]+)" not found/i;
const KIND_NOT_SERVED =
  /is not served by this cluster|no matches for kind|could not find the requested resource/i;

function groupOf(apiVersion: string): string {
  const slash = apiVersion.indexOf('/');
  return slash < 0 ? '' : apiVersion.slice(0, slash);
}

/** `group/Kind` of every CRD in the set. */
export function crdKinds(docs: ReviewDoc[]): Map<string, number> {
  const kinds = new Map<string, number>();
  docs.forEach((doc, index) => {
    if (doc.kind !== 'CustomResourceDefinition') return;
    try {
      const crd = parse(doc.yaml) as { spec?: { group?: string; names?: { kind?: string } } };
      if (crd.spec?.group && crd.spec.names?.kind)
        kinds.set(`${crd.spec.group}/${crd.spec.names.kind}`, index);
    } catch {
      // A broken CRD has its own error.
    }
  });
  return kinds;
}

const changes = (r: DryRunResult | undefined) =>
  !!r && !r.error && (r.operation === 'create' || r.operation === 'update');

/** Cells of one target: dry-run badges with same-set dependencies resolved. */
export function buildCells(docs: ReviewDoc[], results: DryRunResult[]): Cell[] {
  const namespaceDocs = new Map<string, number>();
  docs.forEach((d, i) => d.kind === 'Namespace' && namespaceDocs.set(d.name, i));
  const crds = crdKinds(docs);
  return docs.map((doc, i) => {
    const result: DryRunResult = results[i] ?? {
      api_version: doc.apiVersion,
      kind: doc.kind,
      name: doc.name,
      namespace: doc.namespace,
      operation: 'create',
      live: null,
      result: null,
      error: 'no result',
    };
    if (!result.error) return { badge: result.operation, result, pending: null };
    const ns = NAMESPACE_MISSING.exec(result.error)?.[1];
    if (ns && doc.kind !== 'Namespace') {
      const creator = namespaceDocs.get(ns);
      if (creator !== undefined && changes(results[creator]))
        return { badge: 'create', result, pending: 'namespace' };
    }
    if (KIND_NOT_SERVED.test(result.error)) {
      const creator = crds.get(`${groupOf(doc.apiVersion)}/${doc.kind}`);
      if (creator !== undefined && changes(results[creator]))
        return { badge: 'create', result, pending: 'crd' };
    }
    return { badge: 'error', result, pending: null };
  });
}

export type BadgeCounts = Record<Badge, number>;

const zero = (): BadgeCounts => ({ create: 0, update: 0, unchanged: 0, error: 0 });

export function countCells(cells: Cell[]): BadgeCounts {
  const counts = zero();
  for (const cell of cells) counts[cell.badge]++;
  return counts;
}

/** Cells per target key, for targets whose dry run finished. */
export function doneCells(runs: Record<string, TargetRun>): Record<string, Cell[]> {
  const out: Record<string, Cell[]> = {};
  for (const [key, run] of Object.entries(runs)) if (run.status === 'done') out[key] = run.cells;
  return out;
}

/** Documents per badge (a document counts once per badge it has on any target). */
export function countDocs(docCount: number, cells: Record<string, Cell[]>): BadgeCounts {
  const counts = zero();
  for (let i = 0; i < docCount; i++) {
    for (const badge of BADGES)
      if (Object.values(cells).some((c) => c[i]?.badge === badge)) counts[badge]++;
  }
  return counts;
}

export type Filter = 'all' | Badge;

export function matchesFilter(
  index: number,
  filter: Filter,
  cells: Record<string, Cell[]>,
): boolean {
  if (filter === 'all') return true;
  return Object.values(cells).some((c) => c[index]?.badge === filter);
}

/** Documents that would change somewhere and fail nowhere. */
export function defaultSelection(docs: ReviewDoc[], cells: Record<string, Cell[]>): Set<string> {
  const selected = new Set<string>();
  docs.forEach((doc, i) => {
    const row = Object.values(cells).map((c) => c[i]);
    const changed = row.some((c) => c?.badge === 'create' || c?.badge === 'update');
    const failed = row.some((c) => c?.badge === 'error');
    if (changed && !failed) selected.add(doc.id);
  });
  return selected;
}

export interface TargetPlan {
  target: ReviewTarget;
  /** Document indexes to apply (selected and changing on this target). */
  indexes: number[];
}

export interface ApplyPlan {
  targets: TargetPlan[];
  /** Document × target applies. */
  changes: number;
  /** Selected documents rejected on an included target. */
  errors: number;
  /** Included targets whose dry run has not finished (or failed). */
  unchecked: number;
  /** Selected changes left out because RBAC denies them (`access.ts`). */
  denied: number;
}

export const EMPTY_PLAN: ApplyPlan = {
  targets: [],
  changes: 0,
  errors: 0,
  unchecked: 0,
  denied: 0,
};

const NONE: ReadonlySet<string> = new Set();

/**
 * What "Apply" would do: every selected document that changes on an
 * included, writable target, unless RBAC denies that cell (`denied`, keyed
 * by `deniedKey`). Read-only targets never take part.
 */
export function planApply(
  docs: ReviewDoc[],
  targets: ReviewTarget[],
  runs: Record<string, TargetRun>,
  selected: Set<string>,
  included: Set<string>,
  denied: ReadonlySet<string> = NONE,
): ApplyPlan {
  const plan: ApplyPlan = { ...EMPTY_PLAN, targets: [] };
  for (const target of targets) {
    if (target.readOnly || !included.has(target.key)) continue;
    const run = runs[target.key];
    if (run?.status !== 'done') {
      plan.unchecked++;
      continue;
    }
    const indexes: number[] = [];
    docs.forEach((doc, i) => {
      if (!selected.has(doc.id)) return;
      const badge = run.cells[i]?.badge;
      if (badge === 'error') plan.errors++;
      if (badge !== 'create' && badge !== 'update') return;
      if (denied.has(deniedKey(target.key, i))) plan.denied++;
      else indexes.push(i);
    });
    if (indexes.length) plan.targets.push({ target, indexes });
    plan.changes += indexes.length;
  }
  return plan;
}

/** Per-document apply outcomes of one target, keyed by document index. */
export function applyCells(
  indexes: number[],
  results: ManifestApplyResult[],
): Record<number, ApplyCell> {
  const cells: Record<number, ApplyCell> = {};
  indexes.forEach((docIndex, i) => {
    const r = results[i];
    cells[docIndex] = !r
      ? { status: 'error', message: 'no result' }
      : r.error
        ? { status: 'error', message: r.error }
        : { status: 'ok', object: r.object };
  });
  return cells;
}

/** Both sides of a cell's diff: live vs what the server would store. */
export function cellSides(doc: ReviewDoc, cell: Cell): { original: string; modified: string } {
  let after: unknown = cell.result.result;
  if (!after) {
    // Pending documents were not admitted; show the manifest itself.
    try {
      after = parse(doc.yaml);
    } catch {
      after = null;
    }
  }
  return {
    original: normalizedYaml(cell.result.live, { mode: 'edit' }),
    modified: normalizedYaml(after as KubeObject | null, { mode: 'edit' }),
  };
}

/** Identity of a document set: a review is stale once the rendered set differs. */
export function docsKey(docs: ReviewDoc[]): string {
  let hash = 0;
  for (const doc of docs) {
    const text = `${doc.id}\u0000${doc.yaml}\u0001`;
    for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  }
  return `${docs.length}:${(hash >>> 0).toString(16)}`;
}

/** Documents grouped by source, in order of first appearance. */
export function groupBySource(
  indexes: number[],
  docs: ReviewDoc[],
): { source: string; indexes: number[] }[] {
  const groups = new Map<string, number[]>();
  for (const i of indexes) {
    const source = docs[i]!.source;
    const list = groups.get(source);
    if (list) list.push(i);
    else groups.set(source, [i]);
  }
  return [...groups].map(([source, list]) => ({ source, indexes: list }));
}
