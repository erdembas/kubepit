import * as i18n from '@/i18n/core';
import type { Alert, AlertReason } from '@/types';

/**
 * Localized wording of alerts for the notification center and OS
 * notifications (always in the UI's current language). Reasons, kinds,
 * names and Kubernetes messages are data and stay verbatim.
 */

function singleTitle(alert: Alert): string {
  const name = alert.object.name;
  switch (alert.reason) {
    case 'CrashLoopBackOff':
      return i18n.t('Pod {name} is in CrashLoopBackOff', { name });
    case 'OOMKilled':
      return i18n.t('Pod {name} was OOMKilled', { name });
    case 'ImagePullBackOff':
      return i18n.t('Pod {name} cannot pull its image', { name });
    case 'Evicted':
      return i18n.t('Pod {name} was evicted', { name });
    case 'JobFailed':
      return i18n.t('Job {name} failed', { name });
    case 'NodeNotReady':
      return i18n.t('Node {name} is NotReady', { name });
    case 'NodePressure':
      return i18n.t('Node {name} reports {condition}', {
        name,
        condition: alert.condition ?? alert.reason,
      });
    case 'ProgressDeadlineExceeded':
      return i18n.t('Deployment {name} exceeded its progress deadline', { name });
  }
}

function groupTitle(alert: Alert, count: number): string {
  const namespace = alert.object.namespace ?? '';
  const values = { namespace, condition: alert.condition ?? alert.reason };
  switch (alert.reason) {
    case 'CrashLoopBackOff':
      return i18n.plural(
        '{count} pod in CrashLoopBackOff in {namespace}',
        '{count} pods in CrashLoopBackOff in {namespace}',
        count,
        values,
      );
    case 'OOMKilled':
      return i18n.plural(
        '{count} pod OOMKilled in {namespace}',
        '{count} pods OOMKilled in {namespace}',
        count,
        values,
      );
    case 'ImagePullBackOff':
      return i18n.plural(
        '{count} pod cannot pull its image in {namespace}',
        '{count} pods cannot pull their images in {namespace}',
        count,
        values,
      );
    case 'Evicted':
      return i18n.plural(
        '{count} pod evicted in {namespace}',
        '{count} pods evicted in {namespace}',
        count,
        values,
      );
    case 'JobFailed':
      return i18n.plural(
        '{count} Job failed in {namespace}',
        '{count} Jobs failed in {namespace}',
        count,
        values,
      );
    case 'NodeNotReady':
      return i18n.plural('{count} node is NotReady', '{count} nodes are NotReady', count, values);
    case 'NodePressure':
      return i18n.plural(
        '{count} node reports {condition}',
        '{count} nodes report {condition}',
        count,
        values,
      );
    case 'ProgressDeadlineExceeded':
      return i18n.plural(
        '{count} Deployment exceeded its progress deadline in {namespace}',
        '{count} Deployments exceeded their progress deadline in {namespace}',
        count,
        values,
      );
  }
}

/** One-line summary: "Pod web-1 is in CrashLoopBackOff", "12 pods … in shop". */
export function alertTitle(alert: Alert): string {
  return alert.group ? groupTitle(alert, alert.group.total) : singleTitle(alert);
}

/** `namespace/kind/name` like the rest of the shell (data, not translated). */
export function alertObjectPath(alert: Alert): string {
  const { namespace, kind, name } = alert.object;
  return `${namespace ? `${namespace}/` : ''}${kind.toLowerCase()}${name ? `/${name}` : ''}`;
}

/** Names of a collapsed burst: the first few plus how many more. */
export function alertGroupNames(alert: Alert, shown = 4): string {
  if (!alert.group) return '';
  const names = alert.group.names.slice(0, shown).join(', ');
  const more = alert.group.total - Math.min(shown, alert.group.names.length);
  return more > 0 ? i18n.t('{names} and {count} more', { names, count: i18n.number(more) }) : names;
}

/** OS notification body: cluster, object, container and Kubernetes' message. */
export function alertBody(alert: Alert, clusterName: string): string {
  const where = alert.group ? alertGroupNames(alert) : alertObjectPath(alert);
  const container = alert.container ? i18n.t('container {name}', { name: alert.container }) : '';
  return [clusterName, where, container, alert.message].filter(Boolean).join(' · ');
}

/** What each reason means, for the settings page. */
export function reasonDescription(reason: AlertReason): string {
  switch (reason) {
    case 'CrashLoopBackOff':
      return i18n.t('A container keeps crashing and restarting.');
    case 'OOMKilled':
      return i18n.t('A container was killed for exceeding its memory limit.');
    case 'ImagePullBackOff':
      return i18n.t('An image cannot be pulled (ImagePullBackOff, ErrImagePull).');
    case 'Evicted':
      return i18n.t('A pod was evicted from its node.');
    case 'JobFailed':
      return i18n.t('A Job failed (backoff limit or deadline reached).');
    case 'NodeNotReady':
      return i18n.t('A node stopped being Ready (False or Unknown).');
    case 'NodePressure':
      return i18n.t('A node reports memory, disk or PID pressure.');
    case 'ProgressDeadlineExceeded':
      return i18n.t('A Deployment rollout is stuck past its progress deadline.');
  }
}
