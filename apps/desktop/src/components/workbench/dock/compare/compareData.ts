import { ipc } from '@/lib/ipc';
import { compareText } from '@/lib/diff';
import { gvkFromApiResource } from '@/lib/kube/catalog';
import { diffPaths, type FieldChange } from '@/lib/kube/drift';
import { normalizeObject, toDiffYaml } from '@/lib/kube/normalize';
import type { CompareSide } from '@/store/useDockStore';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ClusterId, Gvk, KubeObject } from '@/types';

/**
 * Data side of cross-cluster compare: resolve the kind each cluster
 * actually serves, read the object with `resource_get`, normalise it in
 * `compare` mode (cluster-assigned values stripped, keys sorted) and
 * classify failures so the drift table can say *why* a side is empty.
 */

export type SideState = 'ok' | 'missing' | 'not-served' | 'forbidden' | 'error';

export interface FetchedSide {
  state: SideState;
  /** Normalised object (ok only). */
  normalized: Record<string, unknown> | null;
  yaml: string;
  message: string | null;
}

/** The served variant of `gvk` on `clusterId` (version from discovery), or null. */
export async function servedGvk(clusterId: ClusterId, gvk: Gvk): Promise<Gvk | null> {
  const cached = useWorkbenchStore.getState().apiResources[clusterId];
  const resources = cached ?? (await ipc.apiResources(clusterId));
  const hit = resources.find((r) => r.group === gvk.group && r.plural === gvk.plural);
  return hit ? gvkFromApiResource(hit) : null;
}

function classify(message: string): SideState {
  if (/\bnot found\b|\b404\b/i.test(message)) return 'missing';
  if (/forbidden|\b403\b|cannot get/i.test(message)) return 'forbidden';
  return 'error';
}

export async function fetchSide(
  side: CompareSide,
  gvk: Gvk,
  includeStatus: boolean,
): Promise<FetchedSide> {
  const empty = { normalized: null, yaml: '', message: null };
  try {
    const served = await servedGvk(side.clusterId, gvk);
    if (!served) return { ...empty, state: 'not-served' };
    const obj: KubeObject = await ipc.resourceGet(
      side.clusterId,
      served,
      served.namespaced ? side.namespace : null,
      side.name,
    );
    const normalized = normalizeObject(obj, { mode: 'compare', keepStatus: includeStatus });
    return { state: 'ok', normalized, yaml: toDiffYaml(normalized), message: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...empty, state: classify(message), message };
  }
}

export interface DriftRow {
  clusterId: ClusterId;
  side: FetchedSide;
  /** vs the baseline; null when either side has no object. */
  added: number;
  removed: number;
  identical: boolean | null;
  changes: FieldChange[];
}

export function compareToBaseline(
  clusterId: ClusterId,
  side: FetchedSide,
  baseline: FetchedSide | undefined,
): DriftRow {
  if (side.state !== 'ok' || baseline?.state !== 'ok')
    return { clusterId, side, added: 0, removed: 0, identical: null, changes: [] };
  const stats = compareText(baseline.yaml, side.yaml);
  return {
    clusterId,
    side,
    added: stats.added,
    removed: stats.removed,
    identical: stats.identical,
    changes: stats.identical ? [] : diffPaths(baseline.normalized, side.normalized, 20),
  };
}
