import { isTauri } from '@/lib/ipc';

/** Open a URL in the system browser (Tauri opener plugin; `window.open` in previews). */
export async function openExternal(url: string) {
  if (isTauri) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
      return;
    } catch {
      /* fall through to window.open */
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
