import { apiVersionOf } from '@/lib/kube/catalog';
import { useAppStore } from '@/store/useAppStore';
import { gvkForCluster, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { AiScope, ClusterId, Gvk } from '@/types';

/**
 * What the assistant is looking at (spec §6): the selected cluster, its
 * namespace and the object selected in the focused view tab. The request
 * scope binds a chat to its cluster (tools and enablement are checked
 * against it) and names the object; it never carries object data.
 */

export interface ScopeParts {
  clusterId: ClusterId | null;
  /** The view's namespaces (`undefined` = the cluster default, `[]` = all). */
  namespaces: readonly string[] | undefined;
  defaultNamespace: string | null;
  /** The object selected in the focused view tab, resolved to its kind. */
  selection: { gvk: Gvk; namespace: string | null; name: string } | null;
}

export const EMPTY_SCOPE: AiScope = { cluster_id: null, namespace: null, object: null };

/** Pure: the scope of these parts. */
export function scopeFrom(parts: ScopeParts): AiScope {
  if (!parts.clusterId) return { ...EMPTY_SCOPE };
  const namespaces = parts.namespaces ?? (parts.defaultNamespace ? [parts.defaultNamespace] : []);
  const s = parts.selection;
  const object = s
    ? {
        api_version: apiVersionOf(s.gvk),
        kind: s.gvk.kind,
        namespace: s.gvk.namespaced ? s.namespace : null,
        name: s.name,
      }
    : null;
  return {
    cluster_id: parts.clusterId,
    namespace: object?.namespace ?? (namespaces.length === 1 ? namespaces[0]! : null),
    object,
  };
}

/** The parts of the current scope, read from the app and workbench stores. */
export function currentScopeParts(): ScopeParts {
  const app = useAppStore.getState();
  const clusterId = app.selectedClusterId ?? null;
  if (!clusterId)
    return { clusterId: null, namespaces: [], defaultNamespace: null, selection: null };
  const wb = useWorkbenchStore.getState();
  const kind = wb.activeKind[clusterId];
  const selected = kind ? wb.selection[clusterId]?.[kind] : undefined;
  const gvk = selected ? gvkForCluster(clusterId, selected.key) : null;
  return {
    clusterId,
    namespaces: wb.namespaces[clusterId],
    defaultNamespace: app.clusters.find((c) => c.id === clusterId)?.default_namespace ?? null,
    selection: selected && gvk ? { gvk, namespace: selected.namespace, name: selected.name } : null,
  };
}

/** The scope right now: selected cluster, its namespace and the focused tab's selection. */
export function currentScope(): AiScope {
  return scopeFrom(currentScopeParts());
}

/** Two scopes name the same cluster, namespace and object. */
export function sameScope(a: AiScope, b: AiScope): boolean {
  const oa = a.object;
  const ob = b.object;
  return (
    a.cluster_id === b.cluster_id &&
    a.namespace === b.namespace &&
    (oa === ob ||
      (!!oa &&
        !!ob &&
        oa.api_version === ob.api_version &&
        oa.kind === ob.kind &&
        oa.namespace === ob.namespace &&
        oa.name === ob.name))
  );
}
