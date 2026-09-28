import { create } from 'zustand';
import { navigateTo } from '@/store/useWorkbenchStore';
import type { ClusterId, Gvk, KubeObject } from '@/types';

/**
 * Requests to open a specific details tab from outside the panel (resource
 * actions, the Rollout section). The panel switches tabs when a request
 * names the object it shows; the tab consumes `focus` and clears it.
 */

export type DetailsTabId = 'history' | 'map' | 'changes' | 'reachability';

export interface DetailsTabRequest {
  clusterId: ClusterId;
  uid: string;
  tab: DetailsTabId;
  /** `rollback`: preselect the previous revision and compare it with the current one. */
  focus?: 'rollback';
}

interface State {
  request: DetailsTabRequest | null;
  open: (request: DetailsTabRequest) => void;
  clear: () => void;
}

export const useDetailsTabRequest = create<State>((set) => ({
  request: null,
  open: (request) => set({ request }),
  clear: () => set({ request: null }),
}));

export function requestFor(
  request: DetailsTabRequest | null,
  clusterId: ClusterId,
  uid: string | undefined,
): DetailsTabRequest | null {
  return request && uid && request.clusterId === clusterId && request.uid === uid ? request : null;
}

/** Select `obj` (opening its details) and switch to the History tab. */
export function openRolloutHistory(
  clusterId: ClusterId,
  gvk: Gvk,
  obj: KubeObject,
  focus?: DetailsTabRequest['focus'],
) {
  navigateTo(clusterId, gvk, obj.metadata.namespace ?? null, obj.metadata.name);
  useDetailsTabRequest.getState().open({ clusterId, uid: obj.metadata.uid, tab: 'history', focus });
}

/** Select an object (opening its details) on its Changes tab (change timeline). */
export function openObjectChanges(
  clusterId: ClusterId,
  gvk: Gvk,
  namespace: string | null,
  name: string,
  uid: string,
) {
  navigateTo(clusterId, gvk, namespace, name);
  useDetailsTabRequest.getState().open({ clusterId, uid, tab: 'changes' });
}

/** Cache key of an object's rollout history (shared by the History tab and the Rollout section). */
export function rolloutHistoryKey(clusterId: ClusterId, uid: string) {
  return `${clusterId}|rollout-history|${uid}`;
}
