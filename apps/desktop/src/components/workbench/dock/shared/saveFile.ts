import * as i18n from '@/i18n/core';
import { ipc, isTauri } from '@/lib/ipc';
import { downloadText } from './platform';

/**
 * Native file pickers for the dock (log export, container file copy). The
 * desktop app uses `@tauri-apps/plugin-dialog`; browser previews have no
 * paths, so callers fall back to downloads / file inputs there.
 */

/** Ask where to save a file. Null when cancelled (or outside the desktop app). */
export async function pickSavePath(
  defaultName: string,
  filter?: { name: string; extensions: string[] },
): Promise<string | null> {
  if (!isTauri) return null;
  const { save } = await import('@tauri-apps/plugin-dialog');
  return save({ defaultPath: defaultName, filters: filter ? [filter] : undefined });
}

/** Ask for one local file to open. Null when cancelled (or outside the desktop app). */
export async function pickOpenPath(): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ multiple: false, directory: false });
  return typeof picked === 'string' ? picked : null;
}

/**
 * "Save logs…": the save dialog plus `save_text_file` in the desktop app, a
 * plain download in browser previews. Resolves to the written path, or null
 * when the user cancelled or the browser took over.
 */
export async function saveTextAs(
  defaultName: string,
  text: string,
  filter?: { name: string; extensions: string[] },
): Promise<string | null> {
  if (!isTauri) {
    downloadText(defaultName, text);
    return null;
  }
  const path = await pickSavePath(
    defaultName,
    filter ?? { name: i18n.t('Log files'), extensions: ['log', 'txt'] },
  );
  if (!path) return null;
  await ipc.saveTextFile(path, text);
  return path;
}
