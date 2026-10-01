import { explainable } from '@/lib/ai/intents';
import { explainObject } from './aiActions';
import * as i18n from '@/i18n/core';
import {
  ArrowRightLeft,
  Ban,
  Bug,
  CalendarSearch,
  ClipboardCheck,
  FolderTree,
  Copy,
  Link2,
  Pencil,
  Play,
  RotateCcw,
  Scaling,
  Sparkles,
  ScrollText,
  SquareTerminal,
  Terminal,
  Trash2,
  CircleCheck,
  CirclePause,
  CirclePlay,
  GitCompareArrows,
  Radar,
  type LucideIcon,
} from 'lucide-react';
import { ipc } from '@/lib/ipc';
import type { AccessNeed } from '@/lib/kube/access';
import { asString, spec } from '@/lib/kube/accessors';
import { nodeUnschedulable } from '@/lib/kube/workloads';
import { useAppStore } from '@/store/useAppStore';
import { dock } from '@/store/useDockStore';
import type { ClusterDef, Gvk, KubeObject } from '@/types';
import { copyText } from '../util';
import { requiredAccess } from './access';
import { useActionDialogs } from './dialogStore';
import { confirmDestructive, runMutation } from './guard';
import { gitopsActions } from './gitopsActions';
import { withGitOpsWarning } from '../gitops/owner';
import { MERGED_LOG_KINDS, openPodDebug, openPodFiles, openWorkloadLogs } from './logsDebugActions';
import { workloadActions } from './workloadActions';
import { wizardActions } from './wizardActions';
// Power user: user-defined custom actions (k9s-plugin style).
import { customResourceActions } from './custom/customActions';
import { hasLokiLogs, openLokiForObject } from './lokiActions';
import { startInvestigation } from '../investigations/navigation';
import { openPodDiagnosis } from '../details/detailsTabs';

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
  /** RBAC permissions the action needs; filled from `ACTION_ACCESS` by id. */
  access?: AccessNeed;
  run: (anchor: Anchor) => void;
}

const SCALABLE = new Set(['Deployment', 'StatefulSet', 'ReplicaSet', 'ReplicationController']);
const INVESTIGABLE = new Set([
  'Pod',
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'Job',
  'CronJob',
]);
export const RESTARTABLE = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);

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
    if (gvk.group === '')
      add({
        id: 'diagnosis',
        label: i18n.t('Diagnosis'),
        icon: ClipboardCheck,
        mutating: false,
        access: [],
        run: () => openPodDiagnosis(clusterId, gvk, obj),
      });
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
    // Logs & debug: container files and ephemeral debug containers.
    add({
      id: 'files',
      label: i18n.t('Files'),
      icon: FolderTree,
      mutating: false,
      run: () => openPodFiles(clusterId, obj),
    });
    add({
      id: 'debug',
      label: i18n.t('Debug…'),
      icon: Bug,
      mutating: true,
      run: () => openPodDebug(clusterId, obj),
    });
  }
  if (
    MERGED_LOG_KINDS.has(kind) &&
    (kind !== 'Service' || asString(spec(obj).type) !== 'ExternalName')
  ) {
    // Merged logs of every pod the workload (or Service) selects.
    add({
      id: 'logs',
      label: i18n.t('Logs'),
      icon: ScrollText,
      mutating: false,
      primary: true,
      run: () => openWorkloadLogs(clusterId, obj),
    });
  }
  // Loki: historical logs of the pod or the workload's pods (read-only).
  if (hasLokiLogs(kind))
    add({
      id: 'loki-logs',
      label: i18n.t('Historical logs (Loki)'),
      icon: CalendarSearch,
      mutating: false,
      run: () => openLokiForObject(clusterId, obj),
    });
  if (useAppStore.getState().settings?.ai.enabled && explainable(kind))
    add({
      id: 'ai-explain',
      label: i18n.t('Explain with assistant'),
      icon: Sparkles,
      mutating: false,
      run: () => explainObject(clusterId, gvk, obj),
    });
  if (INVESTIGABLE.has(kind))
    add({
      id: 'investigate',
      label: i18n.t('Start investigation'),
      icon: ClipboardCheck,
      mutating: false,
      run: () => void startInvestigation(clusterId, gvk, obj),
    });
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
        withGitOpsWarning(clusterId, obj, (warning) =>
          confirmDestructive({
            cluster,
            title: i18n.t('Restart {kind}', { kind }),
            message: i18n.t(
              'Roll out a restart of {name}? Pods are replaced according to the update strategy.',
              { name },
            ),
            confirmLabel: i18n.t('Restart'),
            typeName: name,
            warning,
            run: () =>
              void runMutation(
                () => ipc.resourceRestart(clusterId, gvk, ns ?? 'default', name),
                i18n.t('Restarting {name}', { name }),
              ),
          }),
        ),
    });
  // Workload operations: set image, pause / resume rollout, roll back.
  workloadActions({ clusterId, cluster, gvk, obj }).forEach(add);
  // GitOps: Argo CD sync / refresh / terminate / auto-sync, Flux reconcile / suspend.
  gitopsActions({ clusterId, cluster, gvk, obj }).forEach(add);
  // Resource wizards: expose, create ingress, add role binding (forms → create editor).
  wizardActions({ clusterId, cluster, obj }).forEach(add);
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
      label: i18n.t('Review node maintenance'),
      icon: ArrowRightLeft,
      mutating: false,
      access: [],
      primary: true,
      run: () => useActionDialogs.getState().open({ kind: 'node-maintenance', clusterId, name }),
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
  // Fleet: cross-cluster compare / drift (read-only, opens a dock tab).
  add({
    id: 'compare',
    label: i18n.t('Compare across clusters…'),
    icon: GitCompareArrows,
    mutating: false,
    run: () => dock.compare(clusterId, gvk, ns, name, 'compare'),
  });
  add({
    id: 'drift',
    label: i18n.t('Check drift across clusters'),
    icon: Radar,
    mutating: false,
    run: () => dock.compare(clusterId, gvk, ns, name, 'drift'),
  });
  // Custom actions that apply to this object (never primary: they live in "More").
  customResourceActions({ clusterId, cluster, gvk, obj }).forEach(add);
  add({
    id: 'delete',
    label: i18n.t('Delete'),
    icon: Trash2,
    tone: 'danger',
    mutating: true,
    primary: true,
    run: () =>
      withGitOpsWarning(clusterId, obj, (warning) =>
        confirmDestructive({
          cluster,
          warning,
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
      ),
  });
  // Permission gating (see ./access.ts); ids without an entry stay ungated.
  for (const a of actions) a.access ??= requiredAccess(a.id, obj, gvk);
  return actions;
}
