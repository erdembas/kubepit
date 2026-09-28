import { invoke } from '@tauri-apps/api/core';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { isTauri } from '@/lib/ipc';

/**
 * OS notifications: `tauri-plugin-notification` in the desktop app, the web
 * Notification API in browser previews (`pnpm dev:ui`).
 *
 * Desktop notifications cannot report clicks (the plugin only supports
 * actions on mobile); clicking one brings Kubepit to the front, and
 * `clickThrough.ts` then opens the alert when that focus follows the
 * notification within 10 seconds. Browser notifications open the alert on
 * click themselves.
 */

export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

const webNotifications = () => typeof window !== 'undefined' && 'Notification' in window;

export async function notificationPermission(): Promise<NotificationPermissionState> {
  if (isTauri) return (await isPermissionGranted()) ? 'granted' : 'default';
  if (!webNotifications()) return 'unsupported';
  return Notification.permission;
}

/** Ask once, from a user gesture (settings, the notification center). */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (isTauri) {
    if (await isPermissionGranted()) return 'granted';
    return await requestPermission();
  }
  if (!webNotifications()) return 'unsupported';
  return await Notification.requestPermission();
}

export interface OsNotification {
  title: string;
  body: string;
  /**
   * Browser previews: runs after focusing the window. Desktop notifications
   * never call it; the caller hands it to `clickThrough.ts` instead.
   */
  onClick?: () => void;
}

/** Post a notification; false when permission is missing (never prompts). */
export async function postNotification(n: OsNotification): Promise<boolean> {
  if (isTauri) {
    if (!(await isPermissionGranted())) return false;
    // Await the native command so delivery errors surface (like RunHQ).
    await invoke('plugin:notification|notify', { options: { title: n.title, body: n.body } });
    return true;
  }
  if (!webNotifications() || Notification.permission !== 'granted') return false;
  const notification = new Notification(n.title, { body: n.body });
  notification.onclick = () => {
    window.focus();
    notification.close();
    n.onClick?.();
  };
  return true;
}
