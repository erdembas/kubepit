import * as i18n from '@/i18n';
import { useEffect } from 'react';
import { openAlert } from '@/lib/alerts/actions';
import { postNotification } from '@/lib/alerts/notify';
import { alertSettingsOf, notifyDecision } from '@/lib/alerts/policy';
import { alertBody, alertTitle } from '@/lib/alerts/text';
import { events, ipc } from '@/lib/ipc';
import { windowLabel } from '@/lib/windowSeed';
import { useAlertStore } from '@/store/useAlertStore';
import { useAppStore } from '@/store/useAppStore';
import type { AlertNotice } from '@/types';

/** Fresh alerts arriving together become one notification. */
const COALESCE_MS = 400;

function clusterName(id: string) {
  return useAppStore.getState().clusters.find((c) => c.id === id)?.name ?? id;
}

/**
 * Mirrors the backend's alerts into `useAlertStore` and turns fresh ones
 * into notifications. Every window listens; only the window named by
 * `notice.notifier` posts OS notifications, and while Kubepit is in front
 * (with "only in the background" on) the focused window shows a toast.
 */
export function useAlertNotifications() {
  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    let queued: AlertNotice[] = [];
    let timer: number | undefined;

    const deliver = async () => {
      const batch = queued;
      queued = [];
      timer = undefined;
      // Settings may have changed in another window (mute, snooze): ask the backend.
      const settings = alertSettingsOf(
        await ipc.settingsGet().catch(() => useAppStore.getState().settings),
      );
      if (disposed) return;
      const now = Date.now();
      const os = batch.filter((n) => notifyDecision(settings, n, windowLabel, now) === 'os');
      const toasts = batch.filter((n) => notifyDecision(settings, n, windowLabel, now) === 'toast');

      if (toasts.length && document.hasFocus()) {
        const first = toasts[0]!.alert;
        const critical = toasts.some((n) => n.alert.severity === 'critical');
        useAppStore
          .getState()
          .pushToast(
            critical ? 'error' : 'info',
            toasts.length === 1
              ? `${alertTitle(first)} · ${clusterName(first.cluster_id)}`
              : i18n.plural('{count} new alert', '{count} new alerts', toasts.length),
          );
      }
      if (!os.length) return;
      const [single] = os;
      const notification =
        os.length === 1 && single
          ? {
              title: alertTitle(single.alert),
              body: alertBody(single.alert, clusterName(single.alert.cluster_id)),
              onClick: () => openAlert(single.alert),
            }
          : {
              title: i18n.plural('{count} new alert', '{count} new alerts', os.length),
              body: os
                .slice(0, 3)
                .map((n) => `${alertTitle(n.alert)} · ${clusterName(n.alert.cluster_id)}`)
                .join('\n'),
              onClick: () => useAppStore.setState({ rightPanel: 'alerts' }),
            };
      try {
        await postNotification(notification);
      } catch (e) {
        console.warn('alert notification failed', e);
      }
    };

    void useAlertStore
      .getState()
      .load()
      .catch(() => {});
    void (async () => {
      unlisten.push(
        await events.onAlert((notice) => {
          useAlertStore.getState().upsert(notice.alert);
          if (!notice.fresh) return;
          queued.push(notice);
          timer ??= window.setTimeout(() => void deliver(), COALESCE_MS);
        }),
        await events.onAlertsChanged(() => {
          void useAlertStore
            .getState()
            .load()
            .catch(() => {});
        }),
      );
      if (disposed) unlisten.forEach((fn) => fn());
    })();

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      unlisten.forEach((fn) => fn());
    };
  }, []);
}
