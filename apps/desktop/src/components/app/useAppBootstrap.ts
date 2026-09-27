import { useEffect } from 'react';
import { events, ipc } from '@/lib/ipc';
import { refreshOverview } from '@/lib/clusterActions';
import { UNASSIGNED_BUCKET, useAppStore } from '@/store/useAppStore';
import type { WorkspaceSnapshot } from '@/types';

const OVERVIEW_INTERVAL_MS = 30_000;
const SAVE_DEBOUNCE_MS = 400;

/**
 * Loads app info, settings, the cluster registry and the workspace layout,
 * subscribes to backend events, persists section edits back to
 * `~/.kubepit/workspace.json`, and keeps dashboard overviews fresh for
 * connected clusters.
 */
export function useAppBootstrap() {
  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];

    void (async () => {
      const [appInfo, settings, clusters, statuses, workspace, forwards] = await Promise.all([
        ipc.appInfo().catch(() => null),
        ipc.settingsGet().catch(() => null),
        ipc.clusterList().catch(() => []),
        ipc.clusterStatuses().catch(() => ({})),
        ipc.workspaceLoad().catch(() => null),
        ipc.portForwardList().catch(() => []),
      ]);
      if (disposed) return;
      const store = useAppStore.getState();
      if (workspace && workspace.version === 1) {
        store.hydrateWorkspace({
          sections: workspace.sections ?? [],
          clusterSection: workspace.clusterSection ?? {},
          collapsedSections: workspace.collapsedSections ?? {},
          sectionItemOrder: workspace.sectionItemOrder ?? {},
        });
      }
      store.setClusters(clusters);
      for (const status of Object.values(statuses)) store.setStatus(status);
      store.setPortForwards(forwards);
      if (settings) store.setSettings(settings);
      useAppStore.setState({ appInfo, bootstrapped: true });
      for (const status of Object.values(statuses)) {
        if (status.state === 'connected') void refreshOverview(status.id);
      }

      unlisten.push(
        await events.onClusterStatus((status) => {
          const previous = useAppStore.getState().statuses[status.id]?.state;
          useAppStore.getState().setStatus(status);
          if (status.state === 'connected' && previous !== 'connected')
            void refreshOverview(status.id);
        }),
        await events.onClustersChanged((list) => useAppStore.getState().setClusters(list)),
        await events.onPortForwards((list) => useAppStore.getState().setPortForwards(list)),
      );
      if (disposed) unlisten.forEach((fn) => fn());
    })();

    return () => {
      disposed = true;
      unlisten.forEach((fn) => fn());
    };
  }, []);

  // Persist the workspace layout (sections, membership, order, collapse).
  useEffect(() => {
    let timer: number | undefined;
    const unsubscribe = useAppStore.subscribe((state, prev) => {
      if (!state.bootstrapped) return;
      if (
        state.sections === prev.sections &&
        state.clusterSection === prev.clusterSection &&
        state.collapsedSections === prev.collapsedSections &&
        state.sectionItemOrder === prev.sectionItemOrder
      )
        return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const s = useAppStore.getState();
        const ids = new Set(s.clusters.map((c) => itemKey(c.id)));
        const snapshot: WorkspaceSnapshot = {
          version: 1,
          sections: s.sections,
          clusterSection: s.clusterSection,
          collapsedSections: s.collapsedSections,
          // Drop order hints for clusters that no longer exist.
          sectionItemOrder: Object.fromEntries(
            Object.entries(s.sectionItemOrder).map(([bucket, keys]) => [
              bucket,
              bucket === UNASSIGNED_BUCKET || s.sections.some((x) => x.id === bucket)
                ? keys.filter((k) => ids.has(k))
                : [],
            ]),
          ),
        };
        void ipc.workspaceSave(snapshot).catch(console.error);
      }, SAVE_DEBOUNCE_MS);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  // Dashboard numbers refresh on a slow cadence while clusters stay connected.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      const { statuses } = useAppStore.getState();
      for (const status of Object.values(statuses)) {
        if (status.state === 'connected') void refreshOverview(status.id);
      }
    }, OVERVIEW_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);
}

function itemKey(id: string) {
  return `cluster:${id}`;
}
