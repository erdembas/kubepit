import { create } from 'zustand';
import type { ClusterId, Gvk, TerminalSpec } from '@/types';
import { useAppStore } from './useAppStore';

/**
 * Bottom dock of a cluster workbench (Freelens-style): terminals, pod and
 * workload logs, YAML editors and container file browsers live here as tabs. Every cluster has its own dock state,
 * kept for the whole app session so switching main tabs never kills a
 * shell or a log stream.
 *
 * This file is the contract between the resource views (which *open* dock
 * tabs) and the dock implementation in `components/workbench/dock/` (which
 * renders them).
 */

export type DockTab =
  | { id: string; kind: 'terminal'; title: string; spec: TerminalSpec }
  | {
      id: string;
      kind: 'logs';
      title: string;
      namespace: string;
      pod: string;
      /** Selected container; null = first container. */
      container: string | null;
      /** All containers (incl. init) so the tab can switch without refetching. */
      containers: string[];
      previous: boolean;
    }
  | {
      id: string;
      kind: 'editor';
      title: string;
      mode: 'create';
      /** Initial YAML (template or empty). */
      yaml: string;
      namespace: string | null;
    }
  | {
      id: string;
      kind: 'editor';
      title: string;
      mode: 'edit';
      gvk: Gvk;
      namespace: string | null;
      name: string;
    }
  // -- Logs & debug ---------------------------------------------------------
  | {
      id: string;
      kind: 'workload-logs';
      title: string;
      namespace: string;
      /** What the pods belong to (Deployment web, Service api, …). */
      workload: { kind: string; name: string };
      /** Label selector of the pods (`app=web,tier in (a,b)`). */
      selector: string;
      /** Container names of the pod template, for the filter before pods arrive. */
      containers: string[];
      initContainers: string[];
      /** Pods currently streamed (tab title); null until known. */
      pods: number | null;
    }
  | {
      id: string;
      kind: 'files';
      title: string;
      namespace: string;
      pod: string;
      /** Selected container; null = the pod's default container. */
      container: string | null;
      containers: string[];
    };

type DockTabInput =
  | Omit<Extract<DockTab, { kind: 'terminal' }>, 'id'>
  | Omit<Extract<DockTab, { kind: 'logs' }>, 'id'>
  | Omit<Extract<DockTab, { kind: 'editor'; mode: 'create' }>, 'id'>
  | Omit<Extract<DockTab, { kind: 'editor'; mode: 'edit' }>, 'id'>
  | Omit<Extract<DockTab, { kind: 'workload-logs' }>, 'id'>
  | Omit<Extract<DockTab, { kind: 'files' }>, 'id'>;

export interface ClusterDock {
  tabs: DockTab[];
  activeId: string | null;
  open: boolean;
  /** Height in px; clamped by the dock. */
  height: number;
  maximized: boolean;
}

interface DockState {
  docks: Record<ClusterId, ClusterDock>;
  /** Tab ids (editor tabs) holding unsaved changes; drives the `•` marker and close confirmation. */
  dirty: Record<string, true>;
  /** Adds a tab (or focuses an identical logs/edit tab) and opens the dock. Returns the tab id. */
  openTab: (clusterId: ClusterId, tab: DockTabInput) => string;
  closeTab: (clusterId: ClusterId, tabId: string) => void;
  setActive: (clusterId: ClusterId, tabId: string) => void;
  updateTab: (clusterId: ClusterId, tabId: string, patch: Partial<DockTab>) => void;
  setOpen: (clusterId: ClusterId, open: boolean) => void;
  toggle: (clusterId: ClusterId) => void;
  setHeight: (clusterId: ClusterId, height: number) => void;
  setMaximized: (clusterId: ClusterId, maximized: boolean) => void;
  /** Drops every tab of a removed cluster. */
  reset: (clusterId: ClusterId) => void;
  /** Closes several tabs at once (context menu "Close others" / "Close all"). */
  closeTabs: (clusterId: ClusterId, tabIds: string[]) => void;
  /** Moves a tab to `toIndex` (drag-reorder in the tab strip). */
  moveTab: (clusterId: ClusterId, tabId: string, toIndex: number) => void;
  setDirty: (tabId: string, dirty: boolean) => void;
}

const DEFAULT_HEIGHT = 320;

function emptyDock(): ClusterDock {
  return { tabs: [], activeId: null, open: false, height: DEFAULT_HEIGHT, maximized: false };
}

function withoutKeys(record: Record<string, true>, keys: Iterable<string>): Record<string, true> {
  let next = record;
  for (const key of keys) {
    if (!(key in next)) continue;
    if (next === record) next = { ...record };
    delete next[key];
  }
  return next;
}

/** Logs and edit tabs are unique per target; terminals are always new. */
function sameTarget(a: DockTab, b: DockTabInput): boolean {
  if (a.kind === 'logs' && b.kind === 'logs') return a.namespace === b.namespace && a.pod === b.pod;
  if (a.kind === 'editor' && b.kind === 'editor' && a.mode === 'edit' && b.mode === 'edit')
    return (
      a.gvk.group === b.gvk.group &&
      a.gvk.kind === b.gvk.kind &&
      a.namespace === b.namespace &&
      a.name === b.name
    );
  if (a.kind === 'workload-logs' && b.kind === 'workload-logs')
    return a.namespace === b.namespace && a.selector === b.selector;
  if (a.kind === 'files' && b.kind === 'files')
    return a.namespace === b.namespace && a.pod === b.pod;
  return false;
}

export const useDockStore = create<DockState>((set, get) => ({
  docks: {},
  dirty: {},
  openTab: (clusterId, input) => {
    const dock = get().docks[clusterId] ?? emptyDock();
    const existing = dock.tabs.find((t) => sameTarget(t, input));
    if (existing) {
      set((s) => ({
        docks: {
          ...s.docks,
          [clusterId]: {
            ...dock,
            tabs:
              input.kind === 'logs'
                ? dock.tabs.map((t) => (t.id === existing.id ? ({ ...t, ...input } as DockTab) : t))
                : dock.tabs,
            activeId: existing.id,
            open: true,
          },
        },
      }));
      return existing.id;
    }
    const id = crypto.randomUUID();
    const tab = { ...input, id } as DockTab;
    set((s) => ({
      docks: {
        ...s.docks,
        [clusterId]: { ...dock, tabs: [...dock.tabs, tab], activeId: id, open: true },
      },
    }));
    return id;
  },
  closeTab: (clusterId, tabId) =>
    set((s) => {
      const dock = s.docks[clusterId];
      if (!dock) return s;
      const idx = dock.tabs.findIndex((t) => t.id === tabId);
      if (idx < 0) return s;
      const tabs = dock.tabs.filter((t) => t.id !== tabId);
      const activeId =
        dock.activeId === tabId
          ? ((tabs[idx] ?? tabs[idx - 1] ?? null)?.id ?? null)
          : dock.activeId;
      return {
        docks: {
          ...s.docks,
          [clusterId]: { ...dock, tabs, activeId, open: tabs.length > 0 && dock.open },
        },
        dirty: withoutKeys(s.dirty, [tabId]),
      };
    }),
  setActive: (clusterId, tabId) =>
    set((s) => {
      const dock = s.docks[clusterId];
      if (!dock) return s;
      return { docks: { ...s.docks, [clusterId]: { ...dock, activeId: tabId, open: true } } };
    }),
  updateTab: (clusterId, tabId, patch) =>
    set((s) => {
      const dock = s.docks[clusterId];
      if (!dock) return s;
      return {
        docks: {
          ...s.docks,
          [clusterId]: {
            ...dock,
            tabs: dock.tabs.map((t) => (t.id === tabId ? ({ ...t, ...patch } as DockTab) : t)),
          },
        },
      };
    }),
  setOpen: (clusterId, open) =>
    set((s) => ({
      docks: { ...s.docks, [clusterId]: { ...(s.docks[clusterId] ?? emptyDock()), open } },
    })),
  toggle: (clusterId) => {
    const dock = get().docks[clusterId] ?? emptyDock();
    get().setOpen(clusterId, !dock.open);
  },
  setHeight: (clusterId, height) =>
    set((s) => ({
      docks: {
        ...s.docks,
        [clusterId]: { ...(s.docks[clusterId] ?? emptyDock()), height: Math.round(height) },
      },
    })),
  setMaximized: (clusterId, maximized) =>
    set((s) => ({
      docks: { ...s.docks, [clusterId]: { ...(s.docks[clusterId] ?? emptyDock()), maximized } },
    })),
  reset: (clusterId) =>
    set((s) => {
      const docks = { ...s.docks };
      const ids = s.docks[clusterId]?.tabs.map((t) => t.id) ?? [];
      delete docks[clusterId];
      return { docks, dirty: withoutKeys(s.dirty, ids) };
    }),
  closeTabs: (clusterId, tabIds) =>
    set((s) => {
      const dock = s.docks[clusterId];
      if (!dock || tabIds.length === 0) return s;
      const drop = new Set(tabIds);
      const tabs = dock.tabs.filter((t) => !drop.has(t.id));
      let activeId = dock.activeId;
      if (activeId && drop.has(activeId)) {
        const idx = dock.tabs.findIndex((t) => t.id === activeId);
        const after = dock.tabs.slice(idx + 1).find((t) => !drop.has(t.id));
        const before = dock.tabs
          .slice(0, idx)
          .reverse()
          .find((t) => !drop.has(t.id));
        activeId = (after ?? before)?.id ?? null;
      }
      return {
        docks: {
          ...s.docks,
          [clusterId]: { ...dock, tabs, activeId, open: tabs.length > 0 && dock.open },
        },
        dirty: withoutKeys(s.dirty, tabIds),
      };
    }),
  moveTab: (clusterId, tabId, toIndex) =>
    set((s) => {
      const dock = s.docks[clusterId];
      if (!dock) return s;
      const from = dock.tabs.findIndex((t) => t.id === tabId);
      if (from < 0) return s;
      const tabs = [...dock.tabs];
      const [tab] = tabs.splice(from, 1);
      tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, tab!);
      return { docks: { ...s.docks, [clusterId]: { ...dock, tabs } } };
    }),
  setDirty: (tabId, dirty) =>
    set((s) => {
      if (Boolean(s.dirty[tabId]) === dirty) return s;
      return { dirty: dirty ? { ...s.dirty, [tabId]: true } : withoutKeys(s.dirty, [tabId]) };
    }),
}));

// A removed cluster takes its dock with it: unmounting the tabs destroys their
// shells and stops their log streams.
let knownClusters = new Set(useAppStore.getState().clusters.map((c) => c.id));
useAppStore.subscribe((state, prev) => {
  if (state.clusters === prev.clusters) return;
  const next = new Set(state.clusters.map((c) => c.id));
  for (const id of knownClusters) {
    if (!next.has(id) && useDockStore.getState().docks[id]) useDockStore.getState().reset(id);
  }
  knownClusters = next;
});

/** Convenience openers used by resource views and the command palette. */
export const dock = {
  /** Login shell on this machine without any cluster context (no KUBECONFIG override). */
  localShell: (clusterId: ClusterId, title = 'Local shell') =>
    useDockStore.getState().openTab(clusterId, {
      kind: 'terminal',
      title,
      spec: { kind: 'local', cluster_id: null, namespace: null },
    }),
  shell: (clusterId: ClusterId, title: string, namespace: string | null = null) =>
    useDockStore.getState().openTab(clusterId, {
      kind: 'terminal',
      title,
      spec: { kind: 'local', cluster_id: clusterId, namespace },
    }),
  podExec: (clusterId: ClusterId, namespace: string, pod: string, container: string | null) =>
    useDockStore.getState().openTab(clusterId, {
      kind: 'terminal',
      title: container ? `${pod} · ${container}` : pod,
      spec: { kind: 'pod-exec', cluster_id: clusterId, namespace, pod, container, command: null },
    }),
  podAttach: (clusterId: ClusterId, namespace: string, pod: string, container: string | null) =>
    useDockStore.getState().openTab(clusterId, {
      kind: 'terminal',
      title: `attach ${pod}`,
      spec: { kind: 'pod-attach', cluster_id: clusterId, namespace, pod, container },
    }),
  nodeShell: (clusterId: ClusterId, node: string) =>
    useDockStore.getState().openTab(clusterId, {
      kind: 'terminal',
      title: `node/${node}`,
      spec: { kind: 'node-shell', cluster_id: clusterId, node },
    }),
  logs: (
    clusterId: ClusterId,
    namespace: string,
    pod: string,
    containers: string[],
    container: string | null = null,
    previous = false,
  ) =>
    useDockStore.getState().openTab(clusterId, {
      kind: 'logs',
      title: pod,
      namespace,
      pod,
      containers,
      container: container ?? containers[0] ?? null,
      previous,
    }),
  create: (clusterId: ClusterId, namespace: string | null, yaml = '') =>
    useDockStore.getState().openTab(clusterId, {
      kind: 'editor',
      mode: 'create',
      title: 'Create resource',
      yaml,
      namespace,
    }),
  edit: (clusterId: ClusterId, gvk: Gvk, namespace: string | null, name: string) =>
    useDockStore.getState().openTab(clusterId, {
      kind: 'editor',
      mode: 'edit',
      title: `${gvk.kind.toLowerCase()}/${name}`,
      gvk,
      namespace,
      name,
    }),
  /** Merged logs of every pod matching `selector` (a workload's or a Service's pods). */
  workloadLogs: (
    clusterId: ClusterId,
    target: {
      namespace: string;
      kind: string;
      name: string;
      selector: string;
      containers: string[];
      initContainers: string[];
    },
  ) =>
    useDockStore.getState().openTab(clusterId, {
      kind: 'workload-logs',
      title: target.name,
      namespace: target.namespace,
      workload: { kind: target.kind, name: target.name },
      selector: target.selector,
      containers: target.containers,
      initContainers: target.initContainers,
      pods: null,
    }),
  /** Container file browser. */
  files: (
    clusterId: ClusterId,
    namespace: string,
    pod: string,
    containers: string[],
    container: string | null = null,
  ) =>
    useDockStore.getState().openTab(clusterId, {
      kind: 'files',
      title: pod,
      namespace,
      pod,
      containers,
      container: container ?? containers[0] ?? null,
    }),
};
