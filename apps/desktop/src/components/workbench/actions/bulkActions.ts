import * as i18n from '@/i18n/core';
import {
  Ban,
  CircleCheck,
  CirclePause,
  CirclePlay,
  Copy,
  Download,
  Play,
  RotateCcw,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { ipc } from '@/lib/ipc';
import type { AccessNeed } from '@/lib/kube/access';
import { spec } from '@/lib/kube/accessors';
import { nodeUnschedulable } from '@/lib/kube/workloads';
import { useAppStore } from '@/store/useAppStore';
import type { ClusterDef, Gvk, KubeObject } from '@/types';
import { copyText, errorText } from '../util';
import { bulkAccess } from './access';
import { confirmDestructive } from './guard';
import { RESTARTABLE } from './resourceActions';
// Power user: multi-select custom actions (`{selection.names}`).
import { customBulkActions } from './custom/customActions';

export interface BulkAction {
  id: string;
  label: string;
  icon: LucideIcon;
  tone?: 'danger';
  /** Blocked on read-only clusters. */
  mutating: boolean;
  /** RBAC permissions (allowed on at least one target); see ./access.ts. */
  access?: AccessNeed;
  run: () => void;
}

/** Parallel requests per bulk action, so large selections don't flood the API server. */
const CONCURRENCY = 8;

/** Runs `task` for every target and reports one summary toast. */
async function runBulk(
  targets: KubeObject[],
  task: (obj: KubeObject) => Promise<unknown>,
  success: string,
) {
  const errors: unknown[] = [];
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const obj = targets[next++]!;
      await task(obj).catch((e: unknown) => errors.push(e));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  const push = useAppStore.getState().pushToast;
  if (errors.length)
    push(
      'error',
      i18n.t('{failed} of {total} failed: {error}', {
        failed: errors.length,
        total: targets.length,
        error: errorText(errors[0]),
      }),
    );
  else push('success', success);
}

function nameList(targets: KubeObject[]) {
  return (
    targets
      .slice(0, 8)
      .map((o) => o.metadata.name)
      .join('\n') + (targets.length > 8 ? '\n…' : '')
  );
}

/** Actions offered by the selection bar for the checked rows of one kind. */
export function bulkActions({
  clusterId,
  cluster,
  gvk,
  label,
  targets,
  onDeleted,
  onExport,
}: {
  clusterId: string;
  cluster: ClusterDef | undefined;
  gvk: Gvk;
  /** Plural view label, e.g. "Deployments". */
  label: string;
  targets: KubeObject[];
  onDeleted: () => void;
  /** Opens the export dialog on the selected rows. */
  onExport?: () => void;
}): BulkAction[] {
  if (!targets.length) return [];
  const kind = gvk.kind;
  const count = targets.length;
  const only = count === 1 ? targets[0]! : null;
  const ns = (o: KubeObject) => o.metadata.namespace ?? null;
  const actions: BulkAction[] = [];
  const add = (a: BulkAction) => actions.push(a);

  if (RESTARTABLE.has(kind))
    add({
      id: 'restart',
      label: i18n.t('Restart'),
      icon: RotateCcw,
      mutating: true,
      run: () =>
        confirmDestructive({
          cluster,
          title: only
            ? i18n.t('Restart {kind}', { kind })
            : i18n.plural('Restart {count} object', 'Restart {count} objects', count),
          message: only
            ? i18n.t(
                'Roll out a restart of {name}? Pods are replaced according to the update strategy.',
                { name: only.metadata.name },
              )
            : i18n.t(
                'Roll out a restart of {count} {kind}? Pods are replaced according to each update strategy.\n\n{names}',
                { count, kind: label, names: nameList(targets) },
              ),
          confirmLabel: i18n.t('Restart'),
          typeName: only ? only.metadata.name : (cluster?.name ?? 'restart'),
          run: () =>
            runBulk(
              targets,
              (o) => ipc.resourceRestart(clusterId, gvk, ns(o) ?? 'default', o.metadata.name),
              i18n.plural('Restarting {count} object', 'Restarting {count} objects', count),
            ),
        }),
    });

  if (kind === 'Node') {
    const schedulable = targets.filter((o) => !nodeUnschedulable(o));
    const cordoned = targets.filter((o) => nodeUnschedulable(o));
    if (schedulable.length)
      add({
        id: 'cordon',
        label: i18n.t('Cordon'),
        icon: Ban,
        mutating: true,
        run: () =>
          void runBulk(
            schedulable,
            (o) => ipc.nodeCordon(clusterId, o.metadata.name, true),
            i18n.plural('Cordoned {count} node', 'Cordoned {count} nodes', schedulable.length),
          ),
      });
    if (cordoned.length)
      add({
        id: 'uncordon',
        label: i18n.t('Uncordon'),
        icon: CircleCheck,
        mutating: true,
        run: () =>
          void runBulk(
            cordoned,
            (o) => ipc.nodeCordon(clusterId, o.metadata.name, false),
            i18n.plural('Uncordoned {count} node', 'Uncordoned {count} nodes', cordoned.length),
          ),
      });
  }

  if (kind === 'CronJob') {
    const active = targets.filter((o) => spec(o).suspend !== true);
    const suspended = targets.filter((o) => spec(o).suspend === true);
    add({
      id: 'trigger',
      label: i18n.t('Trigger now'),
      icon: Play,
      mutating: true,
      run: () =>
        void runBulk(
          targets,
          (o) => ipc.cronjobTrigger(clusterId, ns(o) ?? 'default', o.metadata.name),
          i18n.plural('Triggered {count} CronJob', 'Triggered {count} CronJobs', count),
        ),
    });
    if (active.length)
      add({
        id: 'suspend',
        label: i18n.t('Suspend'),
        icon: CirclePause,
        mutating: true,
        run: () =>
          void runBulk(
            active,
            (o) =>
              ipc.resourcePatch(
                clusterId,
                gvk,
                ns(o),
                o.metadata.name,
                { spec: { suspend: true } },
                'merge',
              ),
            i18n.plural('Suspended {count} CronJob', 'Suspended {count} CronJobs', active.length),
          ),
      });
    if (suspended.length)
      add({
        id: 'resume',
        label: i18n.t('Resume'),
        icon: CirclePlay,
        mutating: true,
        run: () =>
          void runBulk(
            suspended,
            (o) =>
              ipc.resourcePatch(
                clusterId,
                gvk,
                ns(o),
                o.metadata.name,
                { spec: { suspend: false } },
                'merge',
              ),
            i18n.plural('Resumed {count} CronJob', 'Resumed {count} CronJobs', suspended.length),
          ),
      });
  }

  add({
    id: 'copy',
    label: i18n.plural('Copy name', 'Copy names', count),
    icon: Copy,
    mutating: false,
    run: () =>
      void copyText(
        targets.map((o) => o.metadata.name).join('\n'),
        i18n.plural('{count} name', '{count} names', count),
      ),
  });

  if (onExport)
    add({
      id: 'export',
      label: i18n.t('Export…'),
      icon: Download,
      mutating: false,
      run: onExport,
    });

  customBulkActions({ clusterId, cluster, gvk, targets }).forEach(add);

  add({
    id: 'delete',
    label: i18n.t('Delete'),
    icon: Trash2,
    tone: 'danger',
    mutating: true,
    run: () =>
      confirmDestructive({
        cluster,
        title: only
          ? i18n.t('Delete {kind}', { kind })
          : i18n.plural('Delete {count} object', 'Delete {count} objects', count),
        message: !only
          ? i18n.t('Delete {count} {kind}? This cannot be undone.\n\n{names}', {
              count,
              kind: label,
              names: nameList(targets),
            })
          : ns(only)
            ? i18n.t('Delete {kind} "{name}" in namespace {namespace}? This cannot be undone.', {
                kind,
                name: only.metadata.name,
                namespace: ns(only)!,
              })
            : i18n.t('Delete {kind} "{name}"? This cannot be undone.', {
                kind,
                name: only.metadata.name,
              }),
        confirmLabel: i18n.t('Delete'),
        typeName: only ? only.metadata.name : (cluster?.name ?? 'delete'),
        run: async () => {
          await runBulk(
            targets,
            (o) => ipc.resourceDelete(clusterId, gvk, ns(o), o.metadata.name),
            i18n.plural('Deleted {count} object', 'Deleted {count} objects', count),
          );
          onDeleted();
        },
      }),
  });

  // Permission gating (see ./access.ts); ids without an entry stay ungated.
  for (const a of actions) a.access ??= bulkAccess(a.id, targets, gvk);
  return actions;
}
