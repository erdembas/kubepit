import * as i18n from '@/i18n/core';
import { CirclePause, CirclePlay, Container, History } from 'lucide-react';
import { ipc } from '@/lib/ipc';
import { spec } from '@/lib/kube/accessors';
import { objectImages, supportsSetImage } from '@/lib/kube/images';
import { hasRollout } from '@/lib/kube/rollout';
import type { ClusterDef, Gvk, KubeObject } from '@/types';
import { openRolloutHistory } from '../details/detailsTabs';
import { useActionDialogs } from './dialogStore';
import { runMutation } from './guard';
import type { ResourceAction } from './resourceActions';

/**
 * Workload operations offered next to the generic resource actions:
 * set image (pods and pod-template workloads), pause / resume a Deployment
 * rollout, and roll back (opens the History tab on the previous revision).
 */
export function workloadActions({
  clusterId,
  gvk,
  obj,
}: {
  clusterId: string;
  cluster: ClusterDef | undefined;
  gvk: Gvk;
  obj: KubeObject;
}): ResourceAction[] {
  const actions: ResourceAction[] = [];
  const name = obj.metadata.name;
  // A Job's pod template is immutable, so set image would always be rejected.
  if (supportsSetImage(obj) && obj.kind !== 'Job' && objectImages(obj).length)
    actions.push({
      id: 'set-image',
      label: i18n.t('Set image…'),
      icon: Container,
      mutating: true,
      primary: true,
      run: () => useActionDialogs.getState().open({ kind: 'set-image', clusterId, gvk, obj }),
    });
  if (!hasRollout(obj)) return actions;
  if (obj.kind === 'Deployment') {
    const paused = spec(obj).paused === true;
    actions.push({
      id: 'pause-rollout',
      label: paused ? i18n.t('Resume rollout') : i18n.t('Pause rollout'),
      icon: paused ? CirclePlay : CirclePause,
      mutating: true,
      run: () =>
        void runMutation(
          () =>
            ipc.resourcePatch(
              clusterId,
              gvk,
              obj.metadata.namespace ?? null,
              name,
              { spec: { paused: !paused } },
              'merge',
            ),
          paused
            ? i18n.t('Resumed rollout of {name}', { name })
            : i18n.t('Paused rollout of {name}', { name }),
        ),
    });
  }
  actions.push({
    id: 'rollback',
    label: i18n.t('Roll back…'),
    icon: History,
    mutating: true,
    run: () => openRolloutHistory(clusterId, gvk, obj, 'rollback'),
  });
  return actions;
}
