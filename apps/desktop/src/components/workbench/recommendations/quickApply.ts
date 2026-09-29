import * as i18n from '@/i18n/core';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { create } from 'zustand';
import { ipc } from '@/lib/ipc';
import { asArray, asObject, get, isObject } from '@/lib/kube/accessors';
import { parseApiVersion } from '@/lib/kube/catalog';
import { gitopsOwnerRefs } from '@/lib/kube/gitops/managed';
import { podSpecPath } from '@/lib/kube/images';
import { cpuMillicores, memoryBytes } from '@/lib/kube/quantity';
import { applyMode, workloadKey } from '@/lib/kube/recommendations/model';
import { changesOf, workloadGvk } from '@/lib/kube/rightsizing/model';
import { useAppStore } from '@/store/useAppStore';
import { useRecommendationsStore } from '@/store/useRecommendationsStore';
import type {
  ClusterId,
  ContainerResourceChange,
  KubeObject,
  ResourceValues,
  WorkloadRecommendation,
  WorkloadRef,
} from '@/types';
import type { GateableAction } from '../access/gates';
import { requiredAccess } from '../actions/access';
import { runMutation } from '../actions/guard';
import { refreshRightsizing } from '../cost/useCost';
import { errorText } from '../util';

/**
 * One-click apply (spec §8) and what the batch apply shares with it: the
 * rows being applied right now, the checks that send a row to the review
 * instead, and the silent server-side dry run. Every write goes through
 * the audited `rightsizing_apply` (`ipc.rightsizingApply`), and only after
 * a dry run of the same changes succeeded.
 */

export type QuickApplyResult = 'applied' | 'review';

// -- Rows being applied -------------------------------------------------------------

const slot = (clusterId: ClusterId, key: string) => `${clusterId}\n${key}`;

/** Rows being applied (dry run or patch), by `clusterId\nworkloadKey`. */
export const useApplyingStore = create<{ keys: Readonly<Record<string, true>> }>(() => ({
  keys: {},
}));

const running = new Map<string, Promise<QuickApplyResult>>();

export function isApplying(clusterId: ClusterId, key: string): boolean {
  return running.has(slot(clusterId, key));
}

/**
 * Runs `task` as the only apply of a row: while it runs, applying the row
 * again returns the running task instead of starting another one.
 */
export function exclusiveApply(
  clusterId: ClusterId,
  key: string,
  task: () => Promise<QuickApplyResult>,
): Promise<QuickApplyResult> {
  const id = slot(clusterId, key);
  const current = running.get(id);
  if (current) return current;
  const done = (async () => {
    try {
      return await task();
    } finally {
      running.delete(id);
      useApplyingStore.setState((s) => {
        const { [id]: _done, ...keys } = s.keys;
        return { keys };
      });
    }
  })();
  running.set(id, done);
  useApplyingStore.setState((s) => ({ keys: { ...s.keys, [id]: true } }));
  return done;
}

/** The `workloadKey`s of a cluster being applied right now. */
export function useApplyingKeys(clusterId: ClusterId): ReadonlySet<string> {
  const keys = useApplyingStore((s) => s.keys);
  return useMemo(() => {
    const prefix = slot(clusterId, '');
    return new Set(
      Object.keys(keys)
        .filter((id) => id.startsWith(prefix))
        .map((id) => id.slice(prefix.length)),
    );
  }, [keys, clusterId]);
}

export function useApplying(clusterId: ClusterId, key: string): boolean {
  return useApplyingStore((s) => !!s.keys[slot(clusterId, key)]);
}

/** Applied in this session (until a later scan reflects it). */
export function appliedInSession(clusterId: ClusterId, key: string): boolean {
  return useRecommendationsStore.getState().byCluster[clusterId]?.applied[key] != null;
}

// -- Refusals -------------------------------------------------------------------------

/** Why a row cannot be applied without the review right now. */
export type ApplyRefusal =
  'unknown-cluster' | 'read-only' | 'production' | 'not-one-click' | 'disconnected' | 'past-run';

/** The Recommendations view shows a past run of the cluster (read-only). */
export function viewShowsPastRun(clusterId: ClusterId): boolean {
  return useRecommendationsStore.getState().byCluster[clusterId]?.runId != null;
}

/**
 * Checked before the dry run and again before the patch: the cluster is
 * known, writable, not production and connected, the caller shows the
 * latest scan (`past`: by default, whether the Recommendations view shows
 * a past run) and the row is `one-click` (`applyMode`, which mirrors
 * `summary.rs`).
 */
export function applyRefusal(
  clusterId: ClusterId,
  rec: WorkloadRecommendation,
  past: boolean = viewShowsPastRun(clusterId),
): ApplyRefusal | null {
  const app = useAppStore.getState();
  const cluster = app.clusters.find((c) => c.id === clusterId);
  if (!cluster) return 'unknown-cluster';
  if (cluster.read_only) return 'read-only';
  if (cluster.environment === 'production') return 'production';
  if (applyMode(rec, cluster) !== 'one-click') return 'not-one-click';
  if (app.statuses[clusterId]?.state !== 'connected') return 'disconnected';
  if (past) return 'past-run';
  return null;
}

export function refusalText(refusal: ApplyRefusal): string {
  switch (refusal) {
    case 'unknown-cluster':
      return i18n.t('The cluster is no longer configured.');
    case 'read-only':
      return i18n.t('Read-only cluster: changes are blocked');
    case 'production':
      return i18n.t(
        'Production cluster: apply each workload on its own, with the typed confirmation.',
      );
    case 'not-one-click':
      return i18n.t('Needs a review: apply it on its own.');
    case 'disconnected':
      return i18n.t('Connect to the cluster to apply.');
    case 'past-run':
      return i18n.t('A past scan is read-only: pick the latest scan to apply.');
  }
}

// -- Dry run --------------------------------------------------------------------------

export function targetOf(rec: WorkloadRecommendation): WorkloadRef {
  return { kind: rec.kind, namespace: rec.namespace, name: rec.name };
}

const MiB = 1024 ** 2;

function liveValues(container: Record<string, unknown>): ResourceValues {
  const resources = asObject(container.resources);
  const requests = asObject(resources.requests);
  const limits = asObject(resources.limits);
  const cpu = (v: unknown) => (v == null ? null : cpuMillicores(v));
  const memory = (v: unknown) => (v == null ? null : memoryBytes(v));
  return {
    cpu_request: cpu(requests.cpu),
    cpu_limit: cpu(limits.cpu),
    memory_request: memory(requests.memory),
    memory_limit: memory(limits.memory),
  };
}

const near = (a: number | null, b: number | null, tolerance: number) =>
  a == null || b == null ? a === b : Math.abs(a - b) <= tolerance;

/**
 * The live workload no longer has the resources the recommendation was
 * computed against (edited since the scan): a container that changes is
 * gone, or one of its requests or limits differs (beyond rounding).
 */
export function liveDrifted(
  rec: WorkloadRecommendation,
  changes: readonly ContainerResourceChange[],
  live: KubeObject,
): boolean {
  const path = podSpecPath(parseApiVersion(live.apiVersion ?? '').group, live.kind);
  if (!path) return true;
  const containers = asArray(get(live, `${path}.containers`)).filter(isObject);
  return changes.some((change) => {
    const rc = rec.containers.find((c) => c.name === change.container);
    const lc = containers.find((c) => c.name === change.container);
    if (!rc || !lc) return true;
    const now = liveValues(lc);
    return !(
      near(now.cpu_request, rc.current.cpu_request, 1) &&
      near(now.cpu_limit, rc.current.cpu_limit, 1) &&
      near(now.memory_request, rc.current.memory_request, MiB) &&
      near(now.memory_limit, rc.current.memory_limit, MiB)
    );
  });
}

export type DryRunCheck = { ok: true } | { ok: false; message: string };

/**
 * The silent server-side dry run of `changes`. It passes only when the API
 * server accepts the patch, the live workload still has the values the
 * scan saw, and no GitOps tool owns it (its notice needs the review).
 */
export async function dryRunCheck(
  clusterId: ClusterId,
  rec: WorkloadRecommendation,
  changes: readonly ContainerResourceChange[],
): Promise<DryRunCheck> {
  try {
    const result = await ipc.rightsizingApply(clusterId, targetOf(rec), [...changes], true);
    if (result.error) return { ok: false, message: result.error };
    if (!result.live)
      return { ok: false, message: i18n.t('The dry run did not return the live workload.') };
    if (liveDrifted(rec, changes, result.live))
      return { ok: false, message: i18n.t('The workload changed since the scan.') };
    if (gitopsOwnerRefs(result.live).length)
      return { ok: false, message: i18n.t('Managed by GitOps: review the change first.') };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: errorText(e) };
  }
}

// -- One-click ------------------------------------------------------------------------

async function runQuickApply(
  clusterId: ClusterId,
  rec: WorkloadRecommendation,
  key: string,
  past: () => boolean,
): Promise<QuickApplyResult> {
  if (applyRefusal(clusterId, rec, past())) return 'review';
  // The dialog's default: optional memory limit changes included.
  const changes = changesOf(rec);
  if (!changes.length) return 'review';
  const check = await dryRunCheck(clusterId, rec, changes);
  if (!check.ok) return 'review';
  // The cluster may have turned read-only or disconnected (or the caller
  // moved to a past run) during the dry run.
  if (applyRefusal(clusterId, rec, past())) return 'review';
  const ok = await runMutation(
    () => ipc.rightsizingApply(clusterId, targetOf(rec), changes, false),
    i18n.t('Right-sized {name}', { name: rec.name }),
  );
  if (!ok) return 'review';
  useRecommendationsStore.getState().markApplied(clusterId, key);
  refreshRightsizing(clusterId);
  return 'applied';
}

/**
 * One-click apply of a `one-click` row: a server-side dry run, then the
 * audited patch with the toast "Right-sized {name}", and the row is marked
 * applied until the next scan. Anything else (a refusal, a failed or
 * suspicious dry run, a failed patch) returns `'review'`: the caller opens
 * `RightsizingDialog`. A row already applying returns the running apply;
 * a row applied in this session is not applied again. `past` tells, when
 * asked before the dry run and before the patch, whether the caller shows
 * a past run (default: whether the Recommendations view does).
 */
export function quickApply(
  clusterId: ClusterId,
  rec: WorkloadRecommendation,
  { past = () => viewShowsPastRun(clusterId) }: { past?: () => boolean } = {},
): Promise<QuickApplyResult> {
  const key = workloadKey(rec);
  if (!isApplying(clusterId, key) && appliedInSession(clusterId, key))
    return Promise.resolve('applied');
  return exclusiveApply(clusterId, key, () => runQuickApply(clusterId, rec, key, past));
}

/**
 * "Apply" of a one-click row in a view: `quickApply`, then `review(rec)`
 * when it needs the review, unless the view left or moved to another
 * cluster meanwhile. A past run or a disconnected cluster applies nothing.
 * The refusals read the caller's `past` as it renders, so a view that
 * always shows the latest scan (the workload details) is not affected by
 * the run picked in the Recommendations view.
 */
export function useQuickApply(
  clusterId: ClusterId,
  { past, connected }: { past: boolean; connected: boolean },
  review: (rec: WorkloadRecommendation) => void,
): (rec: WorkloadRecommendation) => void {
  const live = useRef({ clusterId, mounted: true, review, past });
  live.current.clusterId = clusterId;
  live.current.review = review;
  live.current.past = past;
  useEffect(() => {
    const state = live.current;
    state.mounted = true;
    return () => {
      state.mounted = false;
    };
  }, []);
  return useCallback(
    (rec: WorkloadRecommendation) => {
      if (past || !connected) return;
      void quickApply(clusterId, rec, { past: () => live.current.past }).then((result) => {
        const state = live.current;
        if (result === 'review' && state.mounted && state.clusterId === clusterId)
          state.review(rec);
      });
    },
    [clusterId, past, connected],
  );
}

// -- Permission ---------------------------------------------------------------------

/**
 * Up to this many rows, permissions are checked per workload (precise for
 * name-restricted roles); beyond, per kind and namespace (like `bulkAccess`).
 */
export const NAMED_GATE_LIMIT = 50;

/**
 * The RBAC gate of applying `rec` (`patch` on the workload). `named: false`
 * asks per kind and namespace, so a long list needs one check per
 * namespace; a nameless check only name-restricted rules cover stays
 * unknown and never blocks.
 */
export function rightsizeAction(
  rec: WorkloadRecommendation,
  { named = true }: { named?: boolean } = {},
): GateableAction {
  const gvk = workloadGvk(rec.kind);
  const obj: KubeObject = {
    apiVersion: `${gvk.group}/${gvk.version}`,
    kind: rec.kind,
    metadata: { name: named ? rec.name : '', namespace: rec.namespace, uid: named ? rec.uid : '' },
  };
  return {
    id: rightsizeActionId(rec, named),
    mutating: true,
    access: requiredAccess('rightsize', obj, gvk),
  };
}

export function rightsizeActionId(rec: WorkloadRecommendation, named = true): string {
  return named ? workloadKey(rec) : `${rec.kind}/${rec.namespace}`;
}
