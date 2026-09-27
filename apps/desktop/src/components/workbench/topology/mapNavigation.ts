import { create } from 'zustand';
import { kindKey, resolveKindName } from '@/lib/kube/catalog';
import { nodeId, type TopoNode } from '@/lib/kube/topology';
import { navigateTo, useWorkbenchStore, VIEW } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo, ClusterId, Gvk, KubeObject } from '@/types';
import { useDetailsTabRequest } from '../details/detailsTabs';

/** Requests to center the Resource Map view on a node (from a details panel). */
interface MapFocusState {
  request: { clusterId: ClusterId; id: string; rev: number } | null;
  focus: (clusterId: ClusterId, id: string) => void;
}

export const useMapFocus = create<MapFocusState>((set) => ({
  request: null,
  focus: (clusterId, id) => set({ request: { clusterId, id, rev: Date.now() } }),
}));

/**
 * Open a map node the way links open objects: focus its kind's tab and
 * select it; observed objects continue on their own Map tab.
 */
export function openNodeDetails(
  clusterId: ClusterId,
  node: TopoNode,
  apiResources: readonly ApiResourceInfo[] | null,
) {
  const gvk = node.gvk ?? resolveKindName(node.kind, apiResources);
  if (!gvk) return;
  navigateTo(clusterId, gvk, node.namespace, node.name);
  if (node.uid) useDetailsTabRequest.getState().open({ clusterId, uid: node.uid, tab: 'map' });
}

/** Open the namespace Resource Map with this object selected and centered. */
export function openInResourceMap(clusterId: ClusterId, gvk: Gvk, obj: KubeObject) {
  const key = kindKey(gvk);
  const namespace = gvk.namespaced ? (obj.metadata.namespace ?? null) : null;
  const store = useWorkbenchStore.getState();
  store.setActiveKind(clusterId, VIEW.resourceMap);
  store.select(clusterId, VIEW.resourceMap, { key, namespace, name: obj.metadata.name });
  useMapFocus.getState().focus(clusterId, nodeId(key, namespace, obj.metadata.name));
}
