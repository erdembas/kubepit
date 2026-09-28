import { accessCheck } from '@/lib/kube/access';
import { parseApiVersion } from '@/lib/kube/catalog';
import type { AccessCheck, ApiResourceInfo, ClusterId } from '@/types';
import type { Badge, Cell, ReviewDoc, ReviewTarget, TargetRun } from './model';

/**
 * RBAC checks of a fleet review's apply cells (document × target). Pure:
 * `useApplyDenied` (`useFleetReview.ts`) asks the access cache and marks
 * the cells whose checks are denied; `planApply` leaves those out. Unknown
 * answers and kinds discovery does not know never block.
 */

/** The discovery entry of `apiVersion` + `kind` (matched by group, any version). */
export function resolveResource(
  apiVersion: string,
  kind: string,
  apiResources: readonly ApiResourceInfo[] | null,
): ApiResourceInfo | null {
  if (!apiResources) return null;
  const { group } = parseApiVersion(apiVersion);
  return apiResources.find((r) => r.group === group && r.kind === kind) ?? null;
}

/**
 * What applying `doc` on `target` needs: `patch` on the object (server-side
 * apply), plus `create` when it is new. Namespaced objects without a
 * namespace land in the target's namespace, else `default`, as the backend
 * does. Cells that apply nothing and unknown kinds need no checks.
 */
export function cellChecks(
  doc: ReviewDoc,
  target: ReviewTarget,
  badge: Badge,
  apiResources: readonly ApiResourceInfo[] | null,
): AccessCheck[] {
  if (badge !== 'create' && badge !== 'update') return [];
  const info = resolveResource(doc.apiVersion, doc.kind, apiResources);
  if (!info) return [];
  const namespace = info.namespaced ? doc.namespace || target.namespace || 'default' : null;
  const checks = [accessCheck('patch', info, { namespace, name: doc.name })];
  if (badge === 'create') checks.push(accessCheck('create', info, { namespace }));
  return checks;
}

/** Key of one apply cell in a denied set. */
export function deniedKey(targetKey: string, docIndex: number): string {
  return `${targetKey}#${docIndex}`;
}

/** One apply cell to check. */
export interface CellAccess {
  key: string;
  checks: AccessCheck[];
}

/**
 * Checks of every cell an apply could send, per cluster: writable targets
 * whose dry run finished, documents that create or update there.
 */
export function reviewCellChecks(
  docs: readonly ReviewDoc[],
  targets: readonly ReviewTarget[],
  runs: Record<string, TargetRun>,
  apiResources: (clusterId: ClusterId) => readonly ApiResourceInfo[] | null,
): Map<ClusterId, CellAccess[]> {
  const out = new Map<ClusterId, CellAccess[]>();
  for (const target of targets) {
    const run = runs[target.key];
    if (target.readOnly || run?.status !== 'done') continue;
    const resources = apiResources(target.clusterId);
    if (!resources) continue;
    const list = out.get(target.clusterId) ?? [];
    docs.forEach((doc, i) => {
      const badge = run.cells[i]?.badge;
      if (!badge) return;
      const checks = cellChecks(doc, target, badge, resources);
      if (checks.length) list.push({ key: deniedKey(target.key, i), checks });
    });
    if (list.length) out.set(target.clusterId, list);
  }
  return out;
}

/**
 * The denied check to show on a target's header when RBAC denies every
 * selected change there, else null.
 */
export function targetLock(
  docs: readonly ReviewDoc[],
  target: ReviewTarget,
  cells: readonly Cell[] | undefined,
  selected: ReadonlySet<string>,
  denied: ReadonlyMap<string, AccessCheck>,
): AccessCheck | null {
  if (!cells || target.readOnly) return null;
  let first: AccessCheck | null = null;
  for (let i = 0; i < docs.length; i++) {
    const badge = cells[i]?.badge;
    if (!selected.has(docs[i]!.id) || (badge !== 'create' && badge !== 'update')) continue;
    const check = denied.get(deniedKey(target.key, i));
    if (!check) return null;
    first ??= check;
  }
  return first;
}
