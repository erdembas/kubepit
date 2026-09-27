import * as i18n from '@/i18n/core';
import {
  ArrowRightLeft,
  Ban,
  Copy,
  Link2,
  Pencil,
  Play,
  RotateCcw,
  Scaling,
  ScrollText,
  SquareTerminal,
  Terminal,
  Trash2,
  CircleCheck,
  CirclePause,
  CirclePlay,
  type LucideIcon,
} from 'lucide-react';
import { ipc } from '@/lib/ipc';
import { asString, spec } from '@/lib/kube/accessors';
import { nodeUnschedulable } from '@/lib/kube/workloads';
import { useAppStore } from '@/store/useAppStore';
import { dock } from '@/store/useDockStore';
import type { ClusterDef, Gvk, KubeObject } from '@/types';
import { copyText, errorText } from '../util';
import { useActionDialogs } from './dialogStore';
import { confirmDestructive, runMutation } from './guard';

import {
  openPodLogs,
  openPodShell,
  pickContainer,
  podPorts,
  podsForWorkload,
  servicePortOptions,
  type Anchor,
} from './podActions';

export type { Anchor };
export { openPodLogs, openPodShell, podPorts, podsForWorkload, servicePortOptions };

export interface ResourceAction {
  id: string;
  label: string;
  icon: LucideIcon;
  tone?: 'danger';
  /** Blocked on read-only clusters. */
  mutating: boolean;
  /** Shown as a separate toolbar button (others collapse into the menu order). */
  primary?: boolean;
  run: (anchor: Anchor) => void;
}

const SCALABLE = new Set(['Deployment', 'StatefulSet', 'ReplicaSet', 'ReplicationController']);
export const RESTARTABLE = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);
const HAS_PODS = new Set([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'ReplicationController',
  'Job',
]);

export function resourceActions({
  clusterId,
  cluster,
  gvk,
  obj,
  onDeleted,
}: {
  clusterId: string;
  cluster: ClusterDef | undefined;
  gvk: Gvk;
  obj: KubeObject;
  onDeleted?: () => void;
}): ResourceAction[] {
  const ns = obj.metadata.namespace ?? null;
  const name = obj.metadata.name;
  const kind = obj.kind;
  const actions: ResourceAction[] = [];
  const add = (a: ResourceAction) => actions.push(a);

  if (kind === 'Pod') {
    add({
      id: 'logs',
      label: i18n.t('Logs'),
      icon: ScrollText,
      mutating: false,
      primary: true,
      run: () => openPodLogs(clusterId, obj),
    });
    add({
      id: 'shell',
      label: i18n.t('Shell'),
      icon: SquareTerminal,
      mutating: false,
      primary: true,
      run: (a) => openPodShell(clusterId, obj, a),
    });
    add({
      id: 'attach',
      label: i18n.t('Attach'),
      icon: Link2,
      mutating: false,
      run: (a) =>
        pickContainer(clusterId, obj, a, (c) =>
          dock.podAttach(clusterId, ns ?? 'default', name, c),
        ),
    });
    const ports = podPorts(obj);
    if (ports.length)
      add({
        id: 'port-forward',
        label: i18n.t('Port forward'),
        icon: ArrowRightLeft,
        mutating: false,
        run: () =>
          useActionDialogs.getState().open({
            kind: 'port-forward',
            clusterId,
            target: 'pod',
            namespace: ns ?? 'default',
            name,
            ports,
          }),
      });
  }
  if (HAS_PODS.has(kind)) {
    add({
      id: 'logs',
      label: i18n.t('Logs'),
      icon: ScrollText,
      mutating: false,
      primary: true,
      run: () => {
        void podsForWorkload(clusterId, obj)
          .then((pods) => {
            if (pods[0]) openPodLogs(clusterId, pods[0]);
            else
              useAppStore.getState().pushToast('info', i18n.t('{name} has no pods yet', { name }));
          })
          .catch((e: unknown) => useAppStore.getState().pushToast('error', errorText(e)));
      },
    });
  }
  if (SCALABLE.has(kind))
    add({
      id: 'scale',
      label: i18n.t('Scale'),
      icon: Scaling,
      mutating: true,
      primary: true,
      run: () => useActionDialogs.getState().open({ kind: 'scale', clusterId, gvk, obj }),
    });
  if (RESTARTABLE.has(kind))
    add({
      id: 'restart',
      label: i18n.t('Restart'),
      icon: RotateCcw,
      mutating: true,
      primary: true,
      run: () =>
        confirmDestructive({
          cluster,
          title: i18n.t('Restart {kind}', { kind }),
          message: i18n.t(
            'Roll out a restart of {name}? Pods are replaced according to the update strategy.',
            { name },
          ),
          confirmLabel: i18n.t('Restart'),
          typeName: name,
          run: () =>
            void runMutation(
              () => ipc.resourceRestart(clusterId, gvk, ns ?? 'default', name),
              i18n.t('Restarting {name}', { name }),
            ),
        }),
    });
  if (kind === 'Service') {
    const ports = servicePortOptions(obj);
    if (ports.length && asString(spec(obj).type) !== 'ExternalName')
      add({
        id: 'port-forward',
        label: i18n.t('Port forward'),
        icon: ArrowRightLeft,
        mutating: false,
        primary: true,
        run: () =>
          useActionDialogs.getState().open({
            kind: 'port-forward',
            clusterId,
            target: 'service',
            namespace: ns ?? 'default',
            name,
            ports,
          }),
      });
  }
  if (kind === 'CronJob') {
    add({
      id: 'trigger',
      label: i18n.t('Trigger now'),
      icon: Play,
      mutating: true,
      primary: true,
      run: () =>
        void runMutation(async () => {
          const job = await ipc.cronjobTrigger(clusterId, ns ?? 'default', name);
          useAppStore.getState().pushToast('success', i18n.t('Created job {job}', { job }));
        }),
    });
    const suspended = spec(obj).suspend === true;
    add({
      id: 'suspend',
      label: suspended ? i18n.t('Resume') : i18n.t('Suspend'),
      icon: suspended ? CirclePlay : CirclePause,
      mutating: true,
      primary: true,
      run: () =>
        void runMutation(
          () =>
            ipc.resourcePatch(clusterId, gvk, ns, name, { spec: { suspend: !suspended } }, 'merge'),
          suspended ? i18n.t('Resumed {name}', { name }) : i18n.t('Suspended {name}', { name }),
        ),
    });
  }
  if (kind === 'Node') {
    const cordoned = nodeUnschedulable(obj);
    add({
      id: 'node-shell',
      label: i18n.t('Node shell'),
      icon: Terminal,
      mutating: true,
      primary: true,
      run: () => dock.nodeShell(clusterId, name),
    });
    add({
      id: 'cordon',
      label: cordoned ? i18n.t('Uncordon') : i18n.t('Cordon'),
      icon: cordoned ? CircleCheck : Ban,
      mutating: true,
      primary: true,
      run: () =>
        void runMutation(
          () => ipc.nodeCordon(clusterId, name, !cordoned),
          cordoned ? i18n.t('Uncordoned {name}', { name }) : i18n.t('Cordoned {name}', { name }),
        ),
    });
    add({
      id: 'drain',
      label: i18n.t('Drain'),
      icon: ArrowRightLeft,
      tone: 'danger',
      mutating: true,
      primary: true,
      run: () =>
        confirmDestructive({
          cluster,
          title: i18n.t('Drain node'),
          message: i18n.t('Cordon {name} and evict every pod except DaemonSet and mirror pods?', {
            name,
          }),
          confirmLabel: i18n.t('Drain'),
          typeName: name,
          run: () =>
            void runMutation(
              () => ipc.nodeDrain(clusterId, name, false),
              i18n.t('Draining {name}', { name }),
            ),
        }),
    });
  }
  add({
    id: 'edit',
    label: i18n.t('Edit'),
    icon: Pencil,
    mutating: true,
    primary: true,
    run: () => dock.edit(clusterId, gvk, ns, name),
  });
  add({
    id: 'copy',
    label: i18n.t('Copy name'),
    icon: Copy,
    mutating: false,
    run: () => void copyText(name, name),
  });
  add({
    id: 'delete',
    label: i18n.t('Delete'),
    icon: Trash2,
    tone: 'danger',
    mutating: true,
    primary: true,
    run: () =>
      confirmDestructive({
        cluster,
        title: i18n.t('Delete {kind}', { kind }),
        message: ns
          ? i18n.t('Delete {kind} "{name}" in namespace {namespace}? This cannot be undone.', {
              kind,
              name,
              namespace: ns,
            })
          : i18n.t('Delete {kind} "{name}"? This cannot be undone.', { kind, name }),
        confirmLabel: i18n.t('Delete'),
        typeName: name,
        run: async () => {
          if (
            await runMutation(
              () => ipc.resourceDelete(clusterId, gvk, ns, name),
              i18n.t('Deleted {name}', { name }),
            )
          )
            onDeleted?.();
        },
      }),
  });
  return actions;
}
