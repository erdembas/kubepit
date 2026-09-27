import * as i18n from '@/i18n/core';
import { ipc } from '@/lib/ipc';
import { forwardTitle, type ForwardRow } from '@/lib/portForwards';
import { useAppStore } from '@/store/useAppStore';
import { useConnectivityStore } from '@/store/useConnectivityStore';
import type { PortForward, SavedPortForward } from '@/types';

/**
 * Port-forward actions shared by the cluster page, the global table and the
 * right rail. Lists refresh from `portforward://changed` / `portforward://saved`;
 * the local updates here only make the change visible immediately.
 */

function fail(error: unknown) {
  useAppStore.getState().pushToast('error', error instanceof Error ? error.message : String(error));
}

function upsertLive(forward: PortForward) {
  const store = useAppStore.getState();
  store.setPortForwards([...store.portForwards.filter((f) => f.id !== forward.id), forward]);
}

function upsertSaved(saved: SavedPortForward) {
  const store = useConnectivityStore.getState();
  store.setSavedForwards([...store.savedForwards.filter((s) => s.id !== saved.id), saved]);
}

export async function copyUrl(url: string) {
  try {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeText(url);
  } catch {
    await navigator.clipboard?.writeText(url).catch(() => undefined);
  }
}

export async function stopForward(forward: PortForward) {
  try {
    await ipc.portForwardStop(forward.id);
    const store = useAppStore.getState();
    store.setPortForwards(store.portForwards.filter((f) => f.id !== forward.id));
    if (forward.state !== 'error')
      store.pushToast(
        'success',
        i18n.t('Stopped forwarding localhost:{port}', { port: forward.local_port }),
      );
  } catch (error) {
    fail(error);
  }
}

export async function restartForward(forward: PortForward) {
  try {
    upsertLive(await ipc.portForwardRestart(forward.id));
  } catch (error) {
    fail(error);
  }
}

export async function startSaved(saved: SavedPortForward) {
  try {
    const forward = await ipc.portForwardSavedStart(saved.id);
    upsertLive(forward);
    useAppStore.getState().pushToast(
      'success',
      i18n.t('Forwarding localhost:{port} to {name}', {
        port: forward.local_port,
        name: forwardTitle(saved),
      }),
    );
  } catch (error) {
    fail(error);
  }
}

/** Save a running forward on its current local port. */
export async function saveForward(forward: PortForward) {
  try {
    upsertSaved(
      await ipc.portForwardSave({
        cluster_id: forward.cluster_id,
        namespace: forward.namespace,
        kind: forward.kind,
        name: forward.name,
        remote_port: forward.remote_port,
        local_port: forward.local_port || null,
        label: null,
        start_on_connect: false,
      }),
    );
  } catch (error) {
    fail(error);
  }
}

export async function unsaveForward(saved: SavedPortForward) {
  try {
    await ipc.portForwardUnsave(saved.id);
    const store = useConnectivityStore.getState();
    store.setSavedForwards(store.savedForwards.filter((s) => s.id !== saved.id));
  } catch (error) {
    fail(error);
  }
}

export async function updateSaved(saved: SavedPortForward) {
  try {
    upsertSaved(await ipc.portForwardSavedUpdate(saved));
    return true;
  } catch (error) {
    fail(error);
    return false;
  }
}

export function toggleStartOnConnect(saved: SavedPortForward) {
  return updateSaved({ ...saved, start_on_connect: !saved.start_on_connect });
}

/** Save or forget the row's forward. */
export function toggleSaved(row: ForwardRow) {
  if (row.saved) return unsaveForward(row.saved);
  if (row.live) return saveForward(row.live);
  return Promise.resolve();
}
