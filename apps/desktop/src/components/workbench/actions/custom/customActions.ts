import { actionApplies, isClusterLevel, isMultiSelect } from '@/lib/customActions';
import { enabledCustomActions } from '@/store/useCustomActionsStore';
import type { ClusterDef, CustomAction, Gvk, KubeObject } from '@/types';
import type { BulkAction } from '../bulkActions';
import type { ResourceAction } from '../resourceActions';
import { customActionIcon } from './icons';
import { runCustomAction } from './runCustomAction';

/**
 * Custom actions as entries of the existing action system, so menus, the
 * details toolbar and the selection bar gate them like every other action
 * (`mutating` → blocked on read-only clusters). Ids are `custom:<id>`;
 * RBAC needs are unknown, so they stay ungated (the API server decides).
 */

export const CUSTOM_ACTION_PREFIX = 'custom:';

/** Enabled actions offered for one object. */
export function customActionsFor(
  cluster: ClusterDef | undefined,
  gvk: Gvk,
  obj: KubeObject,
): CustomAction[] {
  return enabledCustomActions().filter((a) =>
    actionApplies(a, {
      cluster,
      kind: gvk.kind,
      group: gvk.group,
      namespace: obj.metadata.namespace ?? null,
    }),
  );
}

/** Enabled cluster-level actions of a cluster. */
export function clusterCustomActions(cluster: ClusterDef | undefined): CustomAction[] {
  return enabledCustomActions().filter(
    (a) =>
      isClusterLevel(a) && actionApplies(a, { cluster, kind: null, group: '', namespace: null }),
  );
}

/** Multi-select actions (`{selection.names}`) that apply to every target. */
export function multiCustomActionsFor(
  cluster: ClusterDef | undefined,
  gvk: Gvk,
  targets: readonly KubeObject[],
): CustomAction[] {
  return enabledCustomActions().filter(
    (a) =>
      isMultiSelect(a) &&
      targets.every((o) =>
        actionApplies(a, {
          cluster,
          kind: gvk.kind,
          group: gvk.group,
          namespace: o.metadata.namespace ?? null,
        }),
      ),
  );
}

export function customResourceActions({
  clusterId,
  cluster,
  gvk,
  obj,
}: {
  clusterId: string;
  cluster: ClusterDef | undefined;
  gvk: Gvk;
  obj: KubeObject;
}): ResourceAction[] {
  return customActionsFor(cluster, gvk, obj).map((action) => ({
    id: `${CUSTOM_ACTION_PREFIX}${action.id}`,
    label: action.name,
    icon: customActionIcon(action.icon),
    mutating: action.mutating,
    run: (anchor) => runCustomAction({ action, clusterId, gvk, objects: [obj], anchor }),
  }));
}

export function customBulkActions({
  clusterId,
  cluster,
  gvk,
  targets,
}: {
  clusterId: string;
  cluster: ClusterDef | undefined;
  gvk: Gvk;
  targets: KubeObject[];
}): BulkAction[] {
  if (!targets.length) return [];
  return multiCustomActionsFor(cluster, gvk, targets).map((action) => ({
    id: `${CUSTOM_ACTION_PREFIX}${action.id}`,
    label: action.name,
    icon: customActionIcon(action.icon),
    mutating: action.mutating,
    run: () => runCustomAction({ action, clusterId, gvk, objects: targets }),
  }));
}
