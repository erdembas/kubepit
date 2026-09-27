import * as i18n from '@/i18n/core';
import {
  CirclePause,
  CirclePlay,
  GitPullRequestArrow,
  ListChecks,
  OctagonX,
  RefreshCcw,
  RefreshCw,
  Zap,
  ZapOff,
} from 'lucide-react';
import { ipc } from '@/lib/ipc';
import {
  isArgoApplication,
  isFluxHelmRelease,
  isFluxKustomization,
  isFluxObject,
  isFluxReconcilable,
} from '@/lib/kube/gitops/kinds';
import { argoAppStatus, fluxStatus } from '@/lib/kube/gitops/model';
import {
  argoAutoSyncPatch,
  argoRefreshPatch,
  argoTerminatePatch,
  fluxReconcilePatch,
  fluxRequestToken,
  fluxSuspendPatch,
} from '@/lib/kube/gitops/patches';
import { useAppStore } from '@/store/useAppStore';
import type { ClusterDef, Gvk, KubeObject } from '@/types';
import { useActionDialogs } from './dialogStore';
import { confirmDestructive, runMutation } from './guard';
import type { ResourceAction } from './resourceActions';

/**
 * GitOps actions (Argo CD Applications, Flux objects). Every one is a merge
 * patch through `resource_patch`, so read-only clusters and RBAC gate them
 * like any other mutation (see `ACTION_ACCESS`).
 */

/** Open the Argo CD sync dialog (optionally preset to a history revision). */
export function openArgoSync(clusterId: string, gvk: Gvk, obj: KubeObject, revision?: string) {
  useActionDialogs.getState().open({ kind: 'argo-sync', clusterId, gvk, obj, revision });
}

/** Enable (after a confirmation: Argo CD syncs right away) or disable automated sync. */
export function setArgoAutoSync(
  target: { clusterId: string; cluster: ClusterDef | undefined; gvk: Gvk; obj: KubeObject },
  enable: boolean,
) {
  const { clusterId, cluster, gvk, obj } = target;
  const name = obj.metadata.name;
  const patch = () =>
    runMutation(
      () =>
        ipc.resourcePatch(
          clusterId,
          gvk,
          obj.metadata.namespace ?? null,
          name,
          argoAutoSyncPatch(obj, enable),
          'merge',
        ),
      enable
        ? i18n.t('Auto-sync enabled for {name}', { name })
        : i18n.t('Auto-sync disabled for {name}', { name }),
    );
  if (!enable) {
    void patch();
    return;
  }
  useAppStore.getState().requestConfirm({
    title: i18n.t('Enable auto-sync'),
    message: i18n.t(
      'Let Argo CD sync {name} automatically whenever Git changes? An out-of-sync application is synced right away.',
      { name },
    ),
    confirmLabel: i18n.t('Enable auto-sync'),
    tone: cluster?.environment === 'production' ? 'danger' : 'default',
    onConfirm: async () => {
      await patch();
    },
  });
}

export function gitopsActions({
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
  const actions: ResourceAction[] = [];
  const ns = obj.metadata.namespace ?? null;
  const name = obj.metadata.name;
  const patch = (body: unknown, success: string) =>
    runMutation(() => ipc.resourcePatch(clusterId, gvk, ns, name, body, 'merge'), success);

  if (isArgoApplication(obj)) {
    const s = argoAppStatus(obj);
    actions.push({
      id: 'argo-sync',
      label: i18n.t('Sync…'),
      icon: GitPullRequestArrow,
      mutating: true,
      primary: true,
      run: () => openArgoSync(clusterId, gvk, obj),
    });
    actions.push({
      id: 'argo-refresh',
      label: i18n.t('Refresh'),
      icon: RefreshCw,
      mutating: true,
      primary: true,
      run: () =>
        void patch(argoRefreshPatch(false), i18n.t('Refresh requested for {name}', { name })),
    });
    actions.push({
      id: 'argo-hard-refresh',
      label: i18n.t('Hard refresh'),
      icon: RefreshCcw,
      mutating: true,
      run: () =>
        void patch(argoRefreshPatch(true), i18n.t('Hard refresh requested for {name}', { name })),
    });
    if (s.operationRunning)
      actions.push({
        id: 'argo-terminate',
        label: i18n.t('Terminate operation'),
        icon: OctagonX,
        tone: 'danger',
        mutating: true,
        primary: true,
        run: () =>
          confirmDestructive({
            cluster,
            title: i18n.t('Terminate operation'),
            message: i18n.t(
              'Stop the running operation of {name}? Resources it already applied stay as they are.',
              { name },
            ),
            confirmLabel: i18n.t('Terminate'),
            typeName: name,
            run: () =>
              void patch(
                argoTerminatePatch(),
                i18n.t('Terminating the operation of {name}', { name }),
              ),
          }),
      });
    actions.push({
      id: 'argo-auto-sync',
      label: s.automated ? i18n.t('Disable auto-sync') : i18n.t('Enable auto-sync'),
      icon: s.automated ? ZapOff : Zap,
      mutating: true,
      run: () => setArgoAutoSync({ clusterId, cluster, gvk, obj }, !s.automated),
    });
  }

  if (isFluxReconcilable(obj)) {
    const suspended = fluxStatus(obj).suspended;
    actions.push({
      id: 'flux-reconcile',
      label: i18n.t('Reconcile'),
      icon: RefreshCw,
      mutating: true,
      primary: true,
      run: () => {
        if (suspended) {
          useAppStore
            .getState()
            .pushToast('info', i18n.t('{name} is suspended; resume it to reconcile.', { name }));
          return;
        }
        void patch(
          fluxReconcilePatch(fluxRequestToken()),
          i18n.t('Reconciliation requested for {name}', { name }),
        );
      },
    });
    if (isFluxKustomization(obj) || isFluxHelmRelease(obj))
      actions.push({
        id: 'flux-reconcile-options',
        label: i18n.t('Reconcile with options…'),
        icon: ListChecks,
        mutating: true,
        run: () =>
          useActionDialogs.getState().open({ kind: 'flux-reconcile', clusterId, gvk, obj }),
      });
  }
  if (isFluxObject(obj)) {
    const suspended = fluxStatus(obj).suspended;
    actions.push({
      id: 'flux-suspend',
      label: suspended ? i18n.t('Resume') : i18n.t('Suspend'),
      icon: suspended ? CirclePlay : CirclePause,
      mutating: true,
      primary: true,
      run: () =>
        void patch(
          fluxSuspendPatch(!suspended),
          suspended ? i18n.t('Resumed {name}', { name }) : i18n.t('Suspended {name}', { name }),
        ),
    });
  }
  return actions;
}
