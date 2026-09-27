import { useEffect, useState } from 'react';
import { ipc } from '@/lib/ipc';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import { useAppStore } from '@/store/useAppStore';
import type { ChangeFilter, ChangePage, ClusterId, HelmRelease, KubeObject } from '@/types';
import { refreshPolledPrefix, usePolled } from '../data/polled';
import { helmListKey } from '../helm/HelmPage';

/** Poll cadences of the timeline sources while the view is visible. */
const JOURNAL_MS = 5_000;
const WARNINGS_MS = 15_000;
const SLOW_MS = 30_000;

export function changesKeyPrefix(clusterId: ClusterId) {
  return `${clusterId}|changes|`;
}

/** Journal page for `filter`; `since` is recomputed at every poll from `rangeMs`. */
export function useJournal(
  clusterId: ClusterId,
  filter: Omit<ChangeFilter, 'since' | 'until' | 'cursor'>,
  rangeMs: number | null,
  enabled: boolean,
  interval = JOURNAL_MS,
) {
  const key = `${changesKeyPrefix(clusterId)}journal|${JSON.stringify(filter)}|${rangeMs ?? '*'}`;
  return usePolled<ChangePage>(
    key,
    () =>
      ipc.changesList(clusterId, {
        ...filter,
        since: rangeMs === null ? null : Date.now() - rangeMs,
        until: null,
        cursor: null,
      }),
    interval,
    enabled,
  );
}

/** Warning events of the selected namespace (or all). */
export function useWarningEvents(clusterId: ClusterId, namespaces: string[], enabled: boolean) {
  const single = namespaces.length === 1 ? namespaces[0]! : null;
  return usePolled<KubeObject[]>(
    enabled ? `${changesKeyPrefix(clusterId)}warnings|${single ?? '*'}` : null,
    async () =>
      (await ipc.resourceList(clusterId, toGvk(BUILTIN.Event), single, null, 'type=Warning')).items,
    WARNINGS_MS,
    enabled,
  );
}

/** Helm releases (shared with the Helm Releases view). */
export function useHelmReleases(clusterId: ClusterId, namespaces: string[], enabled: boolean) {
  const single = namespaces.length === 1 ? namespaces[0]! : null;
  return usePolled<HelmRelease[]>(
    enabled ? helmListKey(clusterId, namespaces) : null,
    () => ipc.helmReleases(clusterId, single),
    SLOW_MS,
    enabled,
  );
}

/** ReplicaSets: one per Deployment rollout revision. */
export function useReplicaSets(clusterId: ClusterId, namespaces: string[], enabled: boolean) {
  const single = namespaces.length === 1 ? namespaces[0]! : null;
  return usePolled<KubeObject[]>(
    enabled ? `${changesKeyPrefix(clusterId)}replicasets|${single ?? '*'}` : null,
    async () => (await ipc.resourceList(clusterId, toGvk(BUILTIN.ReplicaSet), single)).items,
    SLOW_MS,
    enabled,
  );
}

/** Per-cluster recording switch, stored in the settings (`change_journal_disabled`). */
export function useRecordingToggle(clusterId: ClusterId) {
  const settings = useAppStore((s) => s.settings);
  const [saving, setSaving] = useState(false);
  const globallyOn = settings?.change_journal ?? true;
  const optedOut = settings?.change_journal_disabled.includes(clusterId) ?? false;
  const save = async (patch: (s: NonNullable<typeof settings>) => NonNullable<typeof settings>) => {
    if (!settings) return;
    setSaving(true);
    try {
      const saved = await ipc.settingsSet(patch(settings));
      useAppStore.getState().setSettings(saved);
      refreshPolledPrefix(changesKeyPrefix(clusterId));
    } catch (e) {
      useAppStore.getState().pushToast('error', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return {
    ready: !!settings,
    globallyOn,
    on: globallyOn && !optedOut,
    saving,
    /** Record (or stop recording) this cluster. */
    setOn: (on: boolean) =>
      save((s) => ({
        ...s,
        change_journal: on ? true : s.change_journal,
        change_journal_disabled: on
          ? s.change_journal_disabled.filter((id) => id !== clusterId)
          : [...new Set([...s.change_journal_disabled, clusterId])],
      })),
  };
}

/** A text filter applied after the user pauses typing. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return debounced;
}
