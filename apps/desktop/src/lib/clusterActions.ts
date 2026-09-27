import * as i18n from '@/i18n/core';
import { ipc } from '@/lib/ipc';
import { useAppStore } from '@/store/useAppStore';
import type { ClusterDef, ClusterId } from '@/types';

/**
 * Cluster lifecycle actions shared by the sidebar, dashboard cards, the
 * command palette and the workbench. Components call these instead of the
 * raw IPC so status bookkeeping and error toasts stay consistent.
 */

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const inflightOverview = new Set<ClusterId>();

export async function refreshOverview(id: ClusterId) {
  if (inflightOverview.has(id)) return;
  inflightOverview.add(id);
  try {
    const overview = await ipc.clusterOverview(id);
    useAppStore.getState().setOverview(id, overview);
  } catch (error) {
    useAppStore.getState().setOverview(id, null, errorText(error));
  } finally {
    inflightOverview.delete(id);
  }
}

export async function connectCluster(id: ClusterId, { quiet = false } = {}) {
  const store = useAppStore.getState();
  const current = store.statuses[id];
  if (current?.state === 'connecting') return;
  store.setStatus({
    id,
    state: 'connecting',
    error: null,
    version: current?.version ?? null,
    platform: current?.platform ?? null,
    server: current?.server ?? null,
    connected_at: null,
  });
  try {
    const status = await ipc.clusterConnect(id);
    useAppStore.getState().setStatus(status);
    if (status.state === 'connected') void refreshOverview(id);
    else if (!quiet && status.error) useAppStore.getState().pushToast('error', status.error);
  } catch (error) {
    const message = errorText(error);
    useAppStore.getState().setStatus({
      id,
      state: 'error',
      error: message,
      version: null,
      platform: null,
      server: current?.server ?? null,
      connected_at: null,
    });
    if (!quiet) useAppStore.getState().pushToast('error', message);
  }
}

export async function disconnectCluster(id: ClusterId) {
  try {
    await ipc.clusterDisconnect(id);
  } finally {
    const store = useAppStore.getState();
    const current = store.statuses[id];
    store.setStatus({
      id,
      state: 'disconnected',
      error: null,
      version: current?.version ?? null,
      platform: current?.platform ?? null,
      server: current?.server ?? null,
      connected_at: null,
    });
    store.setOverview(id, null);
  }
}

/** Open the cluster tab and connect it if it is not live yet. */
export function openAndConnect(id: ClusterId) {
  const store = useAppStore.getState();
  store.openCluster(id);
  const state = store.statuses[id]?.state ?? 'disconnected';
  if (state === 'disconnected' || state === 'error') void connectCluster(id);
}

export function requestRemoveCluster(cluster: ClusterDef) {
  useAppStore.getState().requestConfirm({
    title: i18n.t('Remove cluster'),
    message: i18n.t(
      'Remove "{name}" from Kubepit? Your kubeconfig files are not changed; only the Kubepit entry is removed.',
      { name: cluster.name },
    ),
    confirmLabel: i18n.t('Remove'),
    tone: 'danger',
    onConfirm: async () => {
      await ipc.clusterRemove(cluster.id);
      const store = useAppStore.getState();
      store.setClusters(store.clusters.filter((c) => c.id !== cluster.id));
      store.pushToast('success', i18n.t('Removed {name}', { name: cluster.name }));
    },
  });
}

export async function saveCluster(cluster: ClusterDef) {
  const saved = await ipc.clusterUpdate(cluster);
  const store = useAppStore.getState();
  store.setClusters(store.clusters.map((c) => (c.id === saved.id ? saved : c)));
  return saved;
}
