import { isTauri } from '@/lib/ipc';

/**
 * Small platform bridges used by the dock (clipboard, external links,
 * downloads). Each prefers the Tauri plugin inside the desktop app and falls
 * back to the web API in browser previews.
 */

export async function copyText(text: string): Promise<void> {
  if (isTauri) {
    try {
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
      await writeText(text);
      return;
    } catch {
      // Fall through to the web clipboard.
    }
  }
  await navigator.clipboard.writeText(text);
}

export async function readText(): Promise<string> {
  if (isTauri) {
    try {
      const { readText: read } = await import('@tauri-apps/plugin-clipboard-manager');
      return (await read()) ?? '';
    } catch {
      // Fall through to the web clipboard.
    }
  }
  return navigator.clipboard.readText();
}

/** Open a link in the user's browser — never inside the app webview. */
export function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  if (isTauri) {
    void import('@tauri-apps/plugin-opener')
      .then(({ openUrl }) => openUrl(url))
      .catch((err: unknown) => console.warn('openUrl failed', err));
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Save text through a Blob `<a download>` (works in Tauri webviews and browsers). */
export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
