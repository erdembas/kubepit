import * as i18n from '@/i18n/core';
import { ipc } from '@/lib/ipc';
import { openObject } from '@/lib/navigation';
import { useAlertStore } from '@/store/useAlertStore';
import { useAppStore } from '@/store/useAppStore';
import type { Alert, AlertSettings } from '@/types';
import { alertSettingsOf } from './policy';

/** Mark read and open the object (a burst opens its kind in the cluster). */
export function openAlert(alert: Alert) {
  if (!alert.read) void useAlertStore.getState().markRead([alert.id]).catch(console.error);
  openObject(
    alert.cluster_id,
    alert.object.kind,
    alert.object.namespace,
    alert.object.name || null,
  );
}

/** Apply an alert-settings change right away (mute, snooze from the panel). */
export async function updateAlertSettings(change: (s: AlertSettings) => AlertSettings) {
  try {
    const current = useAppStore.getState().settings ?? (await ipc.settingsGet());
    const saved = await ipc.settingsSet({
      ...current,
      alerts: change(alertSettingsOf(current)),
    });
    useAppStore.getState().setSettings(saved);
  } catch (e) {
    useAppStore.getState().pushToast(
      'error',
      i18n.t('Could not save notification settings: {error}', {
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }
}
