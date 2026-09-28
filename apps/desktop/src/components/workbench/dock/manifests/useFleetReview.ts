import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ipc } from '@/lib/ipc';
import { useAccessMany } from '@/store/useAccessStore';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { AccessCheck, ClusterId } from '@/types';
import { gateState } from '../../access/gates';
import { errorText } from '../../util';
import { reviewCellChecks } from './access';
import {
  applyCells,
  buildCells,
  type ApplyCell,
  type ApplyPlan,
  type ApplyRun,
  type ReviewDoc,
  type ReviewTarget,
  type TargetRun,
} from './model';

/**
 * Runs a fleet review: one `manifests_dry_run` per target (concurrently),
 * then one `manifests_apply` per target for the planned documents. The
 * documents the dry run saw are kept, so an apply always sends exactly
 * what was reviewed.
 */
export interface FleetReview {
  docs: ReviewDoc[];
  targets: ReviewTarget[];
  runs: Record<string, TargetRun>;
  applies: Record<string, ApplyRun>;
  startedAt: number;
}

export function useFleetReview() {
  const [review, setReview] = useState<FleetReview | null>(null);
  const seq = useRef(0);
  const current = useRef<FleetReview | null>(null);
  current.current = review;

  const update = useCallback((id: number, patch: (r: FleetReview) => FleetReview) => {
    setReview((r) => (r && id === seq.current ? patch(r) : r));
  }, []);

  const runTarget = useCallback(
    (id: number, docs: ReviewDoc[], target: ReviewTarget) => {
      ipc
        .manifestsDryRun(
          target.clusterId,
          docs.map((d) => d.yaml),
          target.namespace,
        )
        .then((results) =>
          update(id, (r) => ({
            ...r,
            runs: {
              ...r.runs,
              [target.key]: { status: 'done', cells: buildCells(docs, results) },
            },
          })),
        )
        .catch((e: unknown) =>
          update(id, (r) => ({
            ...r,
            runs: { ...r.runs, [target.key]: { status: 'error', message: errorText(e) } },
          })),
        );
    },
    [update],
  );

  /** Dry-run `docs` on every target; replaces any previous review. */
  const run = useCallback(
    (docs: ReviewDoc[], targets: ReviewTarget[]) => {
      const id = ++seq.current;
      setReview({
        docs,
        targets,
        runs: Object.fromEntries(targets.map((t) => [t.key, { status: 'running' }])),
        applies: {},
        startedAt: Date.now(),
      });
      for (const target of targets) runTarget(id, docs, target);
    },
    [runTarget],
  );

  /** Apply the plan (built from this review) on every planned target at once. */
  const apply = useCallback(
    async (plan: ApplyPlan): Promise<{ ok: number; failed: number }> => {
      const snapshot = current.current;
      if (!snapshot) return { ok: 0, failed: 0 };
      const id = seq.current;
      const running = (indexes: number[]) =>
        Object.fromEntries(indexes.map((i) => [i, { status: 'running' } as ApplyCell]));
      update(id, (r) => ({
        ...r,
        applies: Object.fromEntries(
          plan.targets.map((p) => [
            p.target.key,
            { status: 'running', cells: running(p.indexes) } as ApplyRun,
          ]),
        ),
      }));
      let ok = 0;
      let failed = 0;
      await Promise.all(
        plan.targets.map(async ({ target, indexes }) => {
          try {
            const results = await ipc.manifestsApply(
              target.clusterId,
              indexes.map((i) => snapshot.docs[i]!.yaml),
              target.namespace,
            );
            const cells = applyCells(indexes, results);
            for (const cell of Object.values(cells)) cell.status === 'ok' ? ok++ : failed++;
            update(id, (r) => ({
              ...r,
              applies: { ...r.applies, [target.key]: { status: 'done', cells } },
            }));
          } catch (e) {
            failed += indexes.length;
            const message = errorText(e);
            const cells = Object.fromEntries(
              indexes.map((i) => [i, { status: 'error', message } as ApplyCell]),
            );
            update(id, (r) => ({
              ...r,
              applies: { ...r.applies, [target.key]: { status: 'error', message, cells } },
            }));
          }
        }),
      );
      return { ok, failed };
    },
    [update],
  );

  const clear = useCallback(() => {
    seq.current++;
    setReview(null);
  }, []);

  const denied = useApplyDenied(review);
  return { review, run, apply, clear, denied };
}

/** Clusters whose discovery is being fetched for a review (shared by every review). */
const discovering = new Set<ClusterId>();

/**
 * Apply cells RBAC denies, keyed by `deniedKey`, with the denied check (for
 * the lock's tooltip). Answers come from the access cache of each target
 * cluster; unknown answers and kinds discovery does not know are never
 * denied.
 */
export function useApplyDenied(review: FleetReview | null): ReadonlyMap<string, AccessCheck> {
  const apiResources = useWorkbenchStore((s) => s.apiResources);
  // Discovery resolves plurals; fetch it for targets whose dry run finished.
  const missing = useMemo(() => {
    if (!review) return [];
    const ids = review.targets
      .filter((t) => !t.readOnly && review.runs[t.key]?.status === 'done')
      .map((t) => t.clusterId)
      .filter((id) => !apiResources[id]);
    return [...new Set(ids)];
  }, [review, apiResources]);
  useEffect(() => {
    for (const clusterId of missing) {
      if (discovering.has(clusterId)) continue;
      discovering.add(clusterId);
      ipc
        .apiResources(clusterId)
        .then((resources) => useWorkbenchStore.getState().setApiResources(clusterId, resources))
        // Without discovery nothing is checked, so nothing is denied.
        .catch(() => undefined)
        .finally(() => discovering.delete(clusterId));
    }
  }, [missing]);

  const cells = useMemo(
    () =>
      review
        ? reviewCellChecks(
            review.docs,
            review.targets,
            review.runs,
            (id) => apiResources[id] ?? null,
          )
        : new Map<ClusterId, never[]>(),
    [review, apiResources],
  );
  const requests = useMemo(
    () =>
      [...cells].map(([clusterId, list]) => ({
        clusterId,
        checks: list.flatMap((cell) => cell.checks),
      })),
    [cells],
  );
  const answers = useAccessMany(requests);
  return useMemo(() => {
    const denied = new Map<string, AccessCheck>();
    [...cells.values()].forEach((list, r) => {
      let at = 0;
      for (const cell of list) {
        const blocking = cell.checks.find(
          (check, i) => gateState(answers[r]?.[at + i], check) === 'denied',
        );
        if (blocking) denied.set(cell.key, blocking);
        at += cell.checks.length;
      }
    });
    return denied;
  }, [cells, answers]);
}
