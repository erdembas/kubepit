import * as i18n from '@/i18n/core';
import type { StatusTone } from '@/lib/kube/pods';
import type { EdgeFamily, EdgeKind, NodeFlag } from '@/lib/kube/topology';

/** Translated legend and tooltip labels (Kubernetes names stay verbatim). */

export function familyLabel(family: EdgeFamily): string {
  switch (family) {
    case 'ownership':
      return i18n.t('Ownership');
    case 'traffic':
      return i18n.t('Traffic');
    case 'config':
      return i18n.t('Configuration');
    case 'storage':
      return i18n.t('Storage');
    case 'access':
      return i18n.t('Identity & access');
    case 'policy':
      return i18n.t('Policies');
    case 'scaling':
      return i18n.t('Autoscaling');
    default:
      return i18n.t('Scheduling');
  }
}

/** Full sentence for an edge tooltip (`from` / `to` are object names). */
export function edgeDescription(kind: EdgeKind, from: string, to: string): string {
  const v = { from, to };
  switch (kind) {
    case 'owns':
      return i18n.t('{from} owns {to}', v);
    case 'selects':
      return i18n.t('{from} selects {to}', v);
    case 'endpoints':
      return i18n.t('{from} publishes endpoints in {to}', v);
    case 'routes':
      return i18n.t('{from} routes traffic to {to}', v);
    case 'parent':
      return i18n.t('{from} attaches to {to}', v);
    case 'class':
      return i18n.t('{from} uses the class {to}', v);
    case 'tls':
      return i18n.t('{from} terminates TLS with {to}', v);
    case 'mounts':
      return i18n.t('{from} mounts {to}', v);
    case 'env':
      return i18n.t('{from} reads environment variables from {to}', v);
    case 'pull-secret':
      return i18n.t('{from} pulls images with {to}', v);
    case 'claims':
      return i18n.t('{from} uses the volume claim {to}', v);
    case 'bound':
      return i18n.t('{from} is bound to {to}', v);
    case 'identity':
      return i18n.t('{from} runs as {to}', v);
    case 'binds':
      return i18n.t('{from} binds {to}', v);
    case 'role-ref':
      return i18n.t('{from} grants {to}', v);
    case 'runs-on':
      return i18n.t('{from} runs on {to}', v);
    case 'scales':
      return i18n.t('{from} scales {to}', v);
    case 'policy':
      return i18n.t('{from} restricts traffic of {to}', v);
    default:
      return i18n.t('{from} limits disruptions of {to}', v);
  }
}

export function toneLabel(tone: StatusTone): string {
  switch (tone) {
    case 'success':
      return i18n.t('Healthy');
    case 'warning':
      return i18n.t('Degraded or pending');
    case 'error':
      return i18n.t('Failing');
    case 'info':
      return i18n.t('In progress');
    default:
      return i18n.t('Idle or completed');
  }
}

export function flagLabel(flag: NodeFlag): string {
  switch (flag) {
    case 'missing':
      return i18n.t('Referenced but not found');
    case 'unresolved':
      return i18n.t('Referenced (not loaded)');
    default:
      return i18n.t('Selects no pods');
  }
}
