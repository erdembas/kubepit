import * as i18n from '@/i18n/core';
import { ipc } from '@/lib/ipc';
import { accessCheck } from '@/lib/kube/access';
import { useAppStore } from '@/store/useAppStore';
import { reviewNow } from '@/store/useAccessStore';
import type { Gvk, KubeObject } from '@/types';
import { reviewedMetadata, restartPatch } from './model';

export function requireWritableConnection(clusterId: string) {
  const state = useAppStore.getState();
  const cluster = state.clusters.find((item) => item.id === clusterId);
  if (!cluster || state.statuses[clusterId]?.state !== 'connected')
    throw new Error(i18n.t('Connect to the cluster before applying this change.'));
  if (cluster.read_only) throw new Error(i18n.t('This cluster is read-only.'));
}

async function checkPatchAccess(clusterId: string, gvk: Gvk, obj: KubeObject) {
  const answers = await reviewNow(clusterId, [
    accessCheck('patch', gvk, {
      namespace: obj.metadata.namespace,
      name: obj.metadata.name,
    }),
  ]).catch(() => []);
  // Match the shared access policy: a definite denial blocks; unknown is enforced by the API.
  if (answers[0]?.denied || (answers[0] && !answers[0].allowed && !answers[0].error))
    throw new Error(
      i18n.t('Permission to patch {kind} {name} was denied.', {
        kind: obj.kind,
        name: obj.metadata.name,
      }),
    );
}

export interface MutationDependencies {
  guard: (clusterId: string) => void;
  access: (clusterId: string, gvk: Gvk, obj: KubeObject) => Promise<void>;
  get: typeof ipc.resourceGet;
  patch: typeof ipc.resourcePatch;
}
const defaultDependencies: MutationDependencies = {
  guard: requireWritableConnection,
  access: checkPatchAccess,
  get: (...args) => ipc.resourceGet(...args),
  patch: (...args) => ipc.resourcePatch(...args),
};

/** Fresh read plus an atomic resourceVersion/UID precondition; no stale overwrite. */
export async function applyReviewedConfig(
  clusterId: string,
  gvk: Gvk,
  reviewed: KubeObject,
  patch: Record<string, unknown>,
  deps = defaultDependencies,
): Promise<KubeObject> {
  deps.guard(clusterId);
  const expected = reviewedMetadata(reviewed);
  if (!expected)
    throw new Error(
      i18n.t('The resource has no version or identity. Refresh before trying again.'),
    );
  await deps.access(clusterId, gvk, reviewed);
  const live = await deps.get(
    clusterId,
    gvk,
    reviewed.metadata.namespace ?? null,
    reviewed.metadata.name,
  );
  if (
    live.metadata.uid !== expected.uid ||
    live.metadata.resourceVersion !== expected.resourceVersion
  )
    throw new Error(
      i18n.t(
        'The configuration changed after review. Close this review, refresh, and review your changes again.',
      ),
    );
  deps.guard(clusterId);
  return deps.patch(
    clusterId,
    gvk,
    reviewed.metadata.namespace ?? null,
    reviewed.metadata.name,
    { ...patch, metadata: expected },
    'merge',
  );
}

/** Status-only updates are fine; replacing or changing a reviewed workload is not. */
export async function restartReviewedConsumer(
  clusterId: string,
  gvk: Gvk,
  reviewed: KubeObject,
  timestamp = new Date().toISOString(),
  deps = defaultDependencies,
): Promise<KubeObject> {
  deps.guard(clusterId);
  await deps.access(clusterId, gvk, reviewed);
  const live = await deps.get(
    clusterId,
    gvk,
    reviewed.metadata.namespace ?? null,
    reviewed.metadata.name,
  );
  if (
    !reviewed.metadata.uid ||
    live.metadata.uid !== reviewed.metadata.uid ||
    JSON.stringify(live.spec) !== JSON.stringify(reviewed.spec) ||
    JSON.stringify(live.metadata.labels) !== JSON.stringify(reviewed.metadata.labels) ||
    JSON.stringify(live.metadata.annotations) !== JSON.stringify(reviewed.metadata.annotations)
  )
    throw new Error(
      i18n.t('The workload changed after review. Refresh its impact before restarting it.'),
    );
  const patch = restartPatch(live, timestamp);
  if (!patch)
    throw new Error(i18n.t('This workload cannot be restarted from the configuration review.'));
  deps.guard(clusterId);
  return deps.patch(
    clusterId,
    gvk,
    live.metadata.namespace ?? null,
    live.metadata.name,
    patch,
    'merge',
  );
}
