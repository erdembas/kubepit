import * as i18n from '@/i18n/core';
import { SquareTerminal } from 'lucide-react';
import { clusterTarget, selectionTarget, targetFor, usesContainer } from '@/lib/customActions';
import { ipc } from '@/lib/ipc';
import { asArray, asObject, asString, isObject, spec } from '@/lib/kube/accessors';
import { containerNames } from '@/lib/kube/pods';
import { useAppStore } from '@/store/useAppStore';
import { useCustomActionsStore } from '@/store/useCustomActionsStore';
import { useDockStore } from '@/store/useDockStore';
import type { ClusterId, CustomAction, CustomActionTarget, Gvk, KubeObject } from '@/types';
import { errorText } from '../../util';
import { useActionDialogs } from '../dialogStore';
import { openExternal } from '../openExternal';
import type { Anchor } from '../podActions';
import { useCustomActionRuns } from './runStore';

/**
 * Entry point of every custom action run (menus, details toolbar,
 * selection bar, palette, shortcuts): pick a container when the command
 * needs one, show the resolved command when the action asks for
 * confirmation (always for mutating actions on production clusters), then
 * open a terminal, run in the background or open the URL. The backend
 * re-resolves the saved definition and enforces `read_only`.
 */

export interface RunRequest {
  action: CustomAction;
  clusterId: ClusterId;
  /** Kind of `objects`; unused for cluster-level runs. */
  gvk?: Gvk | null;
  /** Empty = cluster-level run. */
  objects: readonly KubeObject[];
  /** Where a container picker opens (defaults to the window centre). */
  anchor?: Anchor;
  /** Namespace in scope for cluster-level runs. */
  namespace?: string | null;
}

/** Containers of a pod or of a workload's pod template. */
function objectContainers(obj: KubeObject): string[] {
  if (obj.kind === 'Pod') return containerNames(obj, false);
  const template = asObject(asObject(spec(obj).template).spec);
  return asArray(template.containers)
    .filter(isObject)
    .map((c) => asString(c.name))
    .filter(Boolean);
}

function targetLabel(target: CustomActionTarget, clusterName: string): string {
  if (target.selection.length > 1)
    return i18n.plural('{count} object', '{count} objects', target.selection.length);
  if (!target.name) return target.namespace ? `${clusterName} · ${target.namespace}` : clusterName;
  return target.namespace ? `${target.namespace}/${target.name}` : target.name;
}

function centre(): Anchor {
  return { x: Math.round(window.innerWidth / 2) - 80, y: Math.round(window.innerHeight / 3) };
}

export function runCustomAction(req: RunRequest) {
  const { action, clusterId, objects } = req;
  const cluster = useAppStore.getState().clusters.find((c) => c.id === clusterId);
  const push = useAppStore.getState().pushToast;
  if (action.mutating && cluster?.read_only) {
    push('error', i18n.t('Read-only cluster: changes are blocked'));
    return;
  }
  const withContainer = (container: string | null) => {
    const target: CustomActionTarget =
      !objects.length || !req.gvk
        ? clusterTarget(req.namespace ?? null)
        : objects.length === 1
          ? targetFor(objects[0]!, req.gvk, container)
          : selectionTarget(objects, req.gvk);
    prepare(action, clusterId, target, targetLabel(target, cluster?.name ?? clusterId));
  };
  const only = objects.length === 1 ? objects[0]! : null;
  if (only && usesContainer(action)) {
    const names = objectContainers(only);
    if (names.length > 1) {
      const anchor = req.anchor ?? centre();
      useActionDialogs.getState().open({
        kind: 'menu',
        clusterId,
        x: anchor.x,
        y: anchor.y,
        items: names.map((name) => ({
          id: name,
          label: name,
          icon: <SquareTerminal size={12} />,
          onClick: () => withContainer(name),
        })),
      });
      return;
    }
    withContainer(names[0] ?? null);
    return;
  }
  withContainer(null);
}

function prepare(
  action: CustomAction,
  clusterId: ClusterId,
  target: CustomActionTarget,
  label: string,
) {
  const cluster = useAppStore.getState().clusters.find((c) => c.id === clusterId);
  const production = cluster?.environment === 'production';
  const ask = action.confirm || (action.mutating && production);
  if (!ask) {
    dispatch(action, clusterId, target, label);
    return;
  }
  const runs = useCustomActionRuns.getState();
  runs.setConfirm({
    clusterId,
    action,
    target,
    label,
    resolved: null,
    error: null,
    typeToConfirm:
      action.mutating && production ? (target.name ?? cluster?.name ?? action.name) : null,
    run: () => dispatch(action, clusterId, target, label),
  });
  ipc
    .customActionResolve(action, clusterId, target)
    .then((resolved) => {
      if (useCustomActionRuns.getState().confirm?.action.id === action.id)
        useCustomActionRuns.getState().patchConfirm({ resolved });
    })
    .catch((e: unknown) => useCustomActionRuns.getState().patchConfirm({ error: errorText(e) }));
}

/** Run without asking (the confirmation already happened). */
export function dispatch(
  action: CustomAction,
  clusterId: ClusterId,
  target: CustomActionTarget,
  label: string,
) {
  const push = useAppStore.getState().pushToast;
  if (action.mode === 'terminal') {
    useDockStore.getState().openTab(clusterId, {
      kind: 'terminal',
      title: `${action.name} · ${label}`,
      spec: { kind: 'custom-action', cluster_id: clusterId, action_id: action.id, target },
    });
    return;
  }
  if (action.mode === 'open-url') {
    ipc
      .customActionRun(clusterId, action.id, target)
      .then((result) => openExternal(result.command))
      .catch((e: unknown) => push('error', errorText(e)));
    return;
  }
  const runs = useCustomActionRuns.getState();
  const id = crypto.randomUUID();
  runs.addRun({
    id,
    clusterId,
    action,
    target,
    label,
    status: 'running',
    result: null,
    error: null,
    startedAt: Date.now(),
  });
  ipc
    .customActionRun(clusterId, action.id, target)
    .then((result) => {
      const ok = result.exit_code === 0 && !result.timed_out;
      useCustomActionRuns
        .getState()
        .patchRun(id, { status: ok ? 'done' : 'failed', result, error: null });
      if (ok) push('success', i18n.t('“{name}” finished', { name: action.name }));
      else if (result.timed_out)
        push(
          'error',
          i18n.t('“{name}” timed out after {seconds}s', {
            name: action.name,
            seconds: action.timeout_secs,
          }),
        );
      else
        push(
          'error',
          i18n.t('“{name}” failed with exit code {code}', {
            name: action.name,
            code: result.exit_code ?? '?',
          }),
        );
    })
    .catch((e: unknown) => {
      useCustomActionRuns.getState().patchRun(id, { status: 'failed', error: errorText(e) });
      push('error', errorText(e));
    });
}

/** Run again with the saved definition (it may have been edited since). */
export function rerun(runId: string) {
  const run = useCustomActionRuns.getState().runs.find((r) => r.id === runId);
  if (!run) return;
  const action =
    useCustomActionsStore.getState().actions.find((a) => a.id === run.action.id) ?? run.action;
  prepare(action, run.clusterId, run.target, run.label);
}
