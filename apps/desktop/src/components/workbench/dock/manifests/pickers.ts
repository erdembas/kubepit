import * as i18n from '@/i18n/core';
import { isTauri } from '@/lib/ipc';

/**
 * Native pickers for local manifests (`@tauri-apps/plugin-dialog`).
 *
 * Browser previews (`pnpm dev:ui`) have no filesystem: the pickers return
 * paths inside a fictional project, and the demo backend renders a fixture
 * project for whatever path it is given.
 */
const DEMO_PROJECT = '/Users/demo/src/shop-deploy';

const MANIFEST_FILTER = () => ({
  name: i18n.t('Kubernetes manifests'),
  extensions: ['yaml', 'yml', 'json'],
});

/** One folder: a plain manifest tree, a Kustomize directory or a Helm chart. */
export async function pickManifestFolder(defaultPath?: string): Promise<string | null> {
  if (!isTauri) return DEMO_PROJECT;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false, defaultPath });
  return typeof picked === 'string' ? picked : null;
}

/** One or more manifest files. */
export async function pickManifestFiles(defaultPath?: string): Promise<string[] | null> {
  if (!isTauri) return [`${DEMO_PROJECT}/namespace.yaml`, `${DEMO_PROJECT}/storefront/api.yaml`];
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({
    directory: false,
    multiple: true,
    defaultPath,
    filters: [MANIFEST_FILTER()],
  });
  if (!picked) return null;
  const list = Array.isArray(picked) ? picked : [picked];
  return list.length ? list : null;
}

/** Values files for `helm template`, starting in the chart folder. */
export async function pickValuesFiles(chartDir: string): Promise<string[] | null> {
  if (!isTauri) return [`${chartDir}/values-prod.yaml`];
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({
    directory: false,
    multiple: true,
    defaultPath: chartDir,
    filters: [{ name: i18n.t('Helm values'), extensions: ['yaml', 'yml'] }],
  });
  if (!picked) return null;
  const list = Array.isArray(picked) ? picked : [picked];
  return list.length ? list : null;
}
