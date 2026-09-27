import { useCallback, useRef, useState } from 'react';
import { ipc } from '@/lib/ipc';
import { errorText } from '../../util';
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

  return { review, run, apply, clear };
}
