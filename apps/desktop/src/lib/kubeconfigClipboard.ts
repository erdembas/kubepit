import * as i18n from '@/i18n/core';
import { copyText } from '@/components/workbench/dock/shared/platform';
import { ipc } from '@/lib/ipc';
import { useAppStore } from '@/store/useAppStore';
import type { ClusterDef } from '@/types';

/**
 * Copy and reveal helpers for a cluster's kubeconfig.
 *
 * Two files are involved:
 * - `kubeconfig_path`: the managed copy (or a legacy linked file). In keychain
 *   mode a managed copy lives in the credential store, so the path does not
 *   exist on disk.
 * - `run/<id>.kubeconfig` (`cluster_export_kubeconfig`): the single-context
 *   file terminals use, with the cluster's effective proxy. In keychain mode it
 *   is removed again when the cluster disconnects or Kubepit quits.
 */

type Platform = 'macos' | 'linux' | 'windows';

const SAFE_POSIX = /^[\w@%+=:,./-]+$/;

/** POSIX sh quoting; a leading `~/` stays unquoted so the shell expands it. */
export function posixQuote(value: string): string {
  if (SAFE_POSIX.test(value)) return value;
  if (value.startsWith('~/')) return `~/${posixQuote(value.slice(2))}`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell single-quoted string literal. */
export function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The shell line that points `KUBECONFIG` at `path`. */
export function kubeconfigExportCommand(path: string, platform: Platform | null): string {
  return platform === 'windows'
    ? `$env:KUBECONFIG = ${powershellQuote(path)}`
    : `export KUBECONFIG=${posixQuote(path)}`;
}

const keychainMode = () => useAppStore.getState().settings?.keychain_kubeconfigs ?? false;

/**
 * False when `kubeconfig_path` has no file behind it: a managed copy kept in
 * the keychain. Its run kubeconfig is temporary in exactly the same case.
 */
export function kubeconfigOnDisk(
  cluster: Pick<ClusterDef, 'managed'>,
  keychain = keychainMode(),
): boolean {
  return !cluster.managed || !keychain;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Copies `text`; failures always toast, success only when `success` is given. */
export async function copyToClipboard(text: string, success?: string): Promise<boolean> {
  const store = useAppStore.getState();
  try {
    await copyText(text);
  } catch {
    store.pushToast('error', i18n.t('Clipboard is not available'));
    return false;
  }
  if (success) store.pushToast('success', success);
  return true;
}

export function copyKubeconfigPath(cluster: ClusterDef, toast = true): Promise<boolean> {
  return copyToClipboard(
    cluster.kubeconfig_path,
    toast ? i18n.t('Copied the kubeconfig path of {name}', { name: cluster.name }) : undefined,
  );
}

/**
 * Writes the cluster's run kubeconfig and copies the line that exports it.
 * The success toast says so when the file is temporary (keychain mode).
 */
export async function copyKubeconfigExport(cluster: ClusterDef): Promise<boolean> {
  const store = useAppStore.getState();
  let path: string;
  try {
    path = await ipc.clusterExportKubeconfig(cluster.id);
  } catch (e) {
    store.pushToast(
      'error',
      i18n.t('Could not write the kubeconfig of {name}: {error}', {
        name: cluster.name,
        error: errorText(e),
      }),
    );
    return false;
  }
  const command = kubeconfigExportCommand(path, store.appInfo?.platform ?? null);
  return copyToClipboard(
    command,
    !kubeconfigOnDisk(cluster)
      ? i18n.t(
          'Copied the KUBECONFIG command for {name}. The file is removed when the cluster disconnects or Kubepit quits.',
          { name: cluster.name },
        )
      : i18n.t('Copied the KUBECONFIG command for {name}', { name: cluster.name }),
  );
}

/** Shows the kubeconfig file in Finder / Explorer / the file manager. */
export async function revealKubeconfig(cluster: ClusterDef): Promise<void> {
  try {
    await ipc.revealPath(cluster.kubeconfig_path);
  } catch (e) {
    useAppStore
      .getState()
      .pushToast(
        'error',
        i18n.t('Could not show the kubeconfig file: {error}', { error: errorText(e) }),
      );
  }
}
