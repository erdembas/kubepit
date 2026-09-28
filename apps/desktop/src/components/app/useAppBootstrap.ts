import { useEffect } from 'react';
import { events, ipc } from '@/lib/ipc';
import { refreshOverview } from '@/lib/clusterActions';
import { remoteSettings } from '@/lib/settingsSync';
import { syncThemeAcrossWindows } from '@/lib/theme';
import { windowLabel, windowSeed } from '@/lib/windowSeed';
import { UNASSIGNED_BUCKET, useAppStore } from '@/store/useAppStore';
import { useHealthStore } from '@/store/useHealthStore';
import type { WorkspaceSnapshot } from '@/types';

const OVERVIEW_INTERVAL_MS = 30_000;
const SAVE_DEBOUNCE_MS = 400;

/** Set while applying another window's workspace, so it is not saved back. */
let applyingRemoteWorkspace = false;

function hydrate(workspace: WorkspaceSnapshot) {
  useAppStore.getState().hydrateWorkspace({
    sections: workspace.sections ?? [],
    clusterSection: workspace.clusterSection ?? {},
    collapsedSections: workspace.collapsedSections ?? {},
    sectionItemOrder: workspace.sectionItemOrder ?? {},
  });
  useHealthStore.getState().hydrateIgnores(workspace.healthIgnores ?? {});
  useHealthStore.getState().hydrateOptIns(workspace.healthOptIns ?? {});
}

/**
 * Loads app info, settings, the cluster registry and the workspace layout,
 * subscribes to backend events, persists section edits back to
 * `~/.kubepit/workspace.json` (and applies the ones other windows save),
 * applies the settings other windows save (`settings://changed`), and
 * keeps dashboard overviews fresh for connected clusters. A window
 * opened from another one starts with that window's tabs.
 */
export function useAppBootstrap() {
  useEffect(() => syncThemeAcrossWindows(), []);

  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    if (windowSeed) useAppStore.getState().hydrateMainLayout(windowSeed.mainLayout);

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
      if (workspace && workspace.version === 1) hydrate(workspace);
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
        // Settings saved in another window (mute, snooze, preferences).
        await events.onSettingsChanged((event) => {
          const next = remoteSettings(event, windowLabel);
          if (next) useAppStore.getState().setSettings(next);
        }),
        await events.onWorkspaceChanged(({ source, snapshot }) => {
          if (source === windowLabel || snapshot.version !== 1) return;
          applyingRemoteWorkspace = true;
          try {
            hydrate(snapshot);
          } finally {
            applyingRemoteWorkspace = false;
          }
        }),
      );
      if (disposed) unlisten.forEach((fn) => fn());
    })();

    return () => {
      disposed = true;
      unlisten.forEach((fn) => fn());
    };
  }, []);

  // Persist the workspace layout (sections, membership, order, collapse), health ignores and opt-ins.
  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
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
          healthIgnores: useHealthStore.getState().ignores,
          healthOptIns: useHealthStore.getState().optIns,
        };
        void ipc.workspaceSave(snapshot).catch(console.error);
      }, SAVE_DEBOUNCE_MS);
    };
    const unsubscribe = useAppStore.subscribe((state, prev) => {
      if (!state.bootstrapped || applyingRemoteWorkspace) return;
      if (
        state.sections === prev.sections &&
        state.clusterSection === prev.clusterSection &&
        state.collapsedSections === prev.collapsedSections &&
        state.sectionItemOrder === prev.sectionItemOrder
      )
        return;
      schedule();
    });
    const unsubscribeHealth = useHealthStore.subscribe((state, prev) => {
      if (!useAppStore.getState().bootstrapped || applyingRemoteWorkspace) return;
      if (state.ignores !== prev.ignores || state.optIns !== prev.optIns) schedule();
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
      unsubscribeHealth();
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
