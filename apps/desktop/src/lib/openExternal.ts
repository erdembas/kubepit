import { isTauri } from '@/lib/ipc';

/** Open a URL in the user's default browser (Tauri opener, window.open in previews). */
export async function openExternal(url: string) {
  if (isTauri) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
