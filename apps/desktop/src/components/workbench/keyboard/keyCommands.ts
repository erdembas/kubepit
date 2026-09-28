import * as i18n from '@/i18n/core';
import { ipc } from '@/lib/ipc';
import { checkKey, evaluateNeed, needChecks } from '@/lib/kube/access';
import type { KeyCommand } from '@/lib/keymap';
import { readAccess } from '@/store/useAccessStore';
import { useAppStore } from '@/store/useAppStore';
import type { KubeObject } from '@/types';
import {
  deniedMessage,
  gateState,
  OPEN_GATE,
  type ActionGate,
  type GateableAction,
} from '../access/gates';
import { requiredAccess } from '../actions/access';
import { confirmDestructive, runMutation } from '../actions/guard';
import { resourceActions } from '../actions/resourceActions';
import { useDetailsTabRequest, type DetailsTabId } from '../details/detailsTabs';
import type { TableController } from './tableKeyboard';

/**
 * Keyboard mode commands on the focused table. Row actions reuse
 * `resourceActions`, so RBAC gating, read-only and the confirmation flows
 * (typed names on production) are exactly the ones of menus and toolbars.
 */

/** `useActionGates` for one action outside React (cached access answers). */
export function actionGate(
  clusterId: string,
  action: GateableAction,
  readOnly: boolean,
): ActionGate {
  if (action.mutating && readOnly)
    return {
      blocked: true,
      reason: 'read-only',
      message: i18n.t('Read-only cluster: changes are blocked'),
    };
  if (!action.access) return OPEN_GATE;
  const checks = needChecks(action.access);
  const answers = readAccess(clusterId, checks);
  const byKey = new Map(checks.map((c, i) => [checkKey(c), answers[i]]));
  const { state, blocking } = evaluateNeed(action.access, (c) =>
    gateState(byKey.get(checkKey(c)), c),
  );
  if (state === 'denied' && blocking)
    return { blocked: true, reason: 'permission', message: deniedMessage(blocking) };
  return OPEN_GATE;
}

/** Commands bound to an existing resource action id. */
const ACTION_IDS: Partial<Record<KeyCommand, string>> = {
  logs: 'logs',
  shell: 'shell',
  edit: 'edit',
  delete: 'delete',
  restart: 'restart',
  scale: 'scale',
  'port-forward': 'port-forward',
};

const TABS: Partial<Record<KeyCommand, DetailsTabId>> = { yaml: 'yaml', details: 'details' };

function info(message: string) {
  useAppStore.getState().pushToast('info', message);
}

function runAction(controller: TableController, obj: KubeObject, id: string, label: string) {
  const { clusterId, gvk } = controller;
  const cluster = useAppStore.getState().clusters.find((c) => c.id === clusterId);
  const action = resourceActions({ clusterId, cluster, gvk, obj }).find((a) => a.id === id);
  if (!action) {
    info(i18n.t('{action} is not available for {kind}', { action: label, kind: obj.kind }));
    return;
  }
  const gate = actionGate(clusterId, action, !!cluster?.read_only);
  if (gate.blocked) {
    useAppStore.getState().pushToast('error', gate.message ?? label);
    return;
  }
  action.run(controller.anchor(obj));
}

/** Delete a pod immediately (grace period 0) after the usual confirmation. */
function killPod(controller: TableController, obj: KubeObject) {
  const { clusterId, gvk } = controller;
  if (obj.kind !== 'Pod') {
    info(
      i18n.t('{action} is not available for {kind}', { action: i18n.t('Kill'), kind: obj.kind }),
    );
    return;
  }
  const cluster = useAppStore.getState().clusters.find((c) => c.id === clusterId);
  const gate = actionGate(
    clusterId,
    { id: 'delete', mutating: true, access: requiredAccess('delete', obj, gvk) },
    !!cluster?.read_only,
  );
  if (gate.blocked) {
    useAppStore.getState().pushToast('error', gate.message ?? i18n.t('Kill'));
    return;
  }
  const name = obj.metadata.name;
  const namespace = obj.metadata.namespace ?? null;
  confirmDestructive({
    cluster,
    title: i18n.t('Kill pod'),
    message: i18n.t(
      'Delete pod "{name}" in namespace {namespace} immediately, without a grace period?',
      { name, namespace: namespace ?? '' },
    ),
    confirmLabel: i18n.t('Kill'),
    typeName: name,
    run: () =>
      void runMutation(
        () => ipc.resourceDelete(clusterId, gvk, namespace, name, { grace_period_seconds: 0 }),
        i18n.t('Killed {name}', { name }),
      ),
  });
}

/** Run a row command on the controller's current object. */
export function runRowCommand(command: KeyCommand, controller: TableController, label: string) {
  const obj = controller.current();
  if (!obj) {
    info(i18n.t('Select a row first (j / k, then Enter)'));
    return;
  }
  const tab = TABS[command];
  if (tab) {
    controller.open(obj);
    useDetailsTabRequest
      .getState()
      .open({ clusterId: controller.clusterId, uid: obj.metadata.uid, tab });
    return;
  }
  if (command === 'kill') return killPod(controller, obj);
  const id = ACTION_IDS[command];
  if (id) runAction(controller, obj, id, label);
}
