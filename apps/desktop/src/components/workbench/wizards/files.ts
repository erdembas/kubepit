import * as i18n from '@/i18n/core';
import { ipc, isTauri } from '@/lib/ipc';
import { useAppStore } from '@/store/useAppStore';
import type { LocalFile } from '@/types';
import { errorText } from '../util';

/**
 * Local files for wizards: the native open dialog, then `local_file_read`
 * (bounded, base64). Browser previews have no filesystem, so the pickers
 * return paths inside a fictional home folder and the demo backend serves
 * fixture content for them.
 */

export type FilePurpose = 'any' | 'cert' | 'key' | 'env' | 'ssh-key' | 'known-hosts';

const DEMO = '/Users/demo';
const DEMO_FILES: Record<Exclude<FilePurpose, 'any'>, string> = {
  cert: `${DEMO}/certs/shop.demo.example.crt`,
  key: `${DEMO}/certs/shop.demo.example.key`,
  env: `${DEMO}/src/shop/.env`,
  'ssh-key': `${DEMO}/.ssh/deploy_ed25519`,
  'known-hosts': `${DEMO}/.ssh/known_hosts`,
};
const DEMO_ANY = [
  `${DEMO}/src/shop/config/app.properties`,
  `${DEMO}/src/shop/config/nginx.conf`,
  `${DEMO}/src/shop/assets/logo.png`,
];
let demoTurn = 0;

function title(purpose: FilePurpose): string {
  switch (purpose) {
    case 'cert':
      return i18n.t('Choose a PEM certificate');
    case 'key':
      return i18n.t('Choose a PEM private key');
    case 'env':
      return i18n.t('Choose a .env file');
    case 'ssh-key':
      return i18n.t('Choose an SSH private key');
    case 'known-hosts':
      return i18n.t('Choose a known_hosts file');
    default:
      return i18n.t('Choose files');
  }
}

async function pickPaths(purpose: FilePurpose, multiple: boolean): Promise<string[] | null> {
  if (!isTauri) {
    if (purpose !== 'any') return [DEMO_FILES[purpose]];
    if (multiple) return DEMO_ANY;
    return [DEMO_ANY[demoTurn++ % DEMO_ANY.length]!];
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ multiple, directory: false, title: title(purpose) });
  if (!picked) return null;
  const list = Array.isArray(picked) ? picked : [picked];
  return list.length ? list : null;
}

/**
 * Pick and read files. Files that cannot be read (too large, gone) are
 * reported in a toast and skipped; content never reaches a log.
 */
export async function pickLocalFiles(
  purpose: FilePurpose,
  multiple = false,
): Promise<LocalFile[] | null> {
  const paths = await pickPaths(purpose, multiple);
  if (!paths) return null;
  const files: LocalFile[] = [];
  for (const path of paths) {
    try {
      files.push(await ipc.localFileRead(path));
    } catch (err) {
      useAppStore.getState().pushToast('error', errorText(err));
    }
  }
  return files.length ? files : null;
}

/** UTF-8 text of a loaded file, or null for binary content. */
export function localFileText(file: LocalFile): string | null {
  if (!file.utf8) return null;
  try {
    const binary = atob(file.base64);
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}
