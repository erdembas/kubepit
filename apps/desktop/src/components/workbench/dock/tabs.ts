import * as i18n from '@/i18n/core';
import { useAppStore } from '@/store/useAppStore';
import { useDockStore, type DockTab } from '@/store/useDockStore';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ClusterId } from '@/types';

/**
 * Display title of a dock tab, derived from what the tab runs rather than
 * `tab.title` where that text is English UI copy (create/attach/local shell).
 */
export function tabTitle(tab: DockTab, clusterName: string | null): string {
  switch (tab.kind) {
    case 'terminal': {
      const spec = tab.spec;
      if (spec.kind === 'pod-exec')
        return spec.container ? `${spec.pod} · ${spec.container}` : spec.pod;
      if (spec.kind === 'pod-attach') return i18n.t('Attach · {pod}', { pod: spec.pod });
      if (spec.kind === 'node-shell') return `node/${spec.node}`;
      if (!spec.cluster_id) return i18n.t('Local shell');
      const name = clusterName ?? tab.title;
      return spec.namespace ? `${name} · ${spec.namespace}` : name;
    }
    case 'logs':
      return tab.container && tab.containers.length > 1 ? `${tab.pod} · ${tab.container}` : tab.pod;
    case 'editor':
      return tab.mode === 'create' ? i18n.t('Create resource') : tab.title;
    case 'compare':
      return tab.mode === 'drift'
        ? i18n.t('Drift · {name}', { name: tab.name })
        : i18n.t('Compare · {name}', { name: tab.name });
  }
}

/** Longer hover text: namespace, container, previous-instance flag… */
export function tabTooltip(tab: DockTab, clusterName: string | null): string {
  switch (tab.kind) {
    case 'terminal': {
      const spec = tab.spec;
      if (spec.kind === 'pod-exec' || spec.kind === 'pod-attach') {
        const target = `${spec.namespace}/${spec.pod}${spec.container ? ` (${spec.container})` : ''}`;
        return spec.kind === 'pod-exec'
          ? i18n.t('Shell in {target}', { target })
          : i18n.t('Attached to {target}', { target });
      }
      if (spec.kind === 'node-shell') return i18n.t('Shell on node {node}', { node: spec.node });
      if (!spec.cluster_id) return i18n.t('Local shell without a cluster context');
      return i18n.t('Local shell with KUBECONFIG for {cluster}', {
        cluster: clusterName ?? spec.cluster_id,
      });
    }
    case 'logs': {
      const target = `${tab.namespace}/${tab.pod}${tab.container ? ` (${tab.container})` : ''}`;
      return tab.previous
        ? i18n.t('Logs of {target} · previous instance', { target })
        : i18n.t('Logs of {target}', { target });
    }
    case 'editor':
      return tab.mode === 'create'
        ? i18n.t('Create resource in {namespace}', { namespace: tab.namespace ?? 'default' })
        : `${tab.namespace ? `${tab.namespace}/` : ''}${tab.gvk.kind}/${tab.name}`;
    case 'compare':
      return i18n.t('{kind} {name} across clusters', {
        kind: tab.gvk.kind,
        name: `${tab.namespace ? `${tab.namespace}/` : ''}${tab.name}`,
      });
  }
}

/** Titles with a ` (n)` suffix on same-kind duplicates so several shells stay distinguishable. */
export function uniqueTitles(tabs: DockTab[], clusterName: string | null): Map<string, string> {
  const seen = new Map<string, number>();
  const titles = new Map<string, string>();
  for (const tab of tabs) {
    const title = tabTitle(tab, clusterName);
    // Icons already tell kinds apart; only same-kind twins need a number.
    const key = `${tab.kind}\u0000${title}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    titles.set(tab.id, n > 1 ? `${title} (${n})` : title);
  }
  return titles;
}

/** Close tabs, asking first when any of them holds unsaved edits. */
export function requestCloseTabs(clusterId: ClusterId, tabIds: string[]): void {
  const { dirty, closeTabs, docks } = useDockStore.getState();
  const dirtyIds = tabIds.filter((id) => dirty[id]);
  if (dirtyIds.length === 0) {
    closeTabs(clusterId, tabIds);
    return;
  }
  const app = useAppStore.getState();
  const clusterName = app.clusters.find((c) => c.id === clusterId)?.name ?? null;
  const first = docks[clusterId]?.tabs.find((t) => t.id === dirtyIds[0]);
  app.requestConfirm({
    title: i18n.t('Discard unsaved changes?'),
    message:
      dirtyIds.length === 1 && first
        ? i18n.t('"{title}" has unsaved changes. Close it and discard them?', {
            title: tabTitle(first, clusterName),
          })
        : i18n.plural(
            '{count} tab has unsaved changes. Close and discard them?',
            '{count} tabs have unsaved changes. Close and discard them?',
            dirtyIds.length,
          ),
    confirmLabel: i18n.t('Discard & close'),
    tone: 'danger',
    onConfirm: () => closeTabs(clusterId, tabIds),
  });
}

/** Namespace the workbench is scoped to (single selection), else the cluster default. */
export function scopeNamespace(clusterId: ClusterId): string | null {
  const selected = useWorkbenchStore.getState().namespaces[clusterId] ?? [];
  if (selected.length === 1) return selected[0]!;
  return useAppStore.getState().clusters.find((c) => c.id === clusterId)?.default_namespace ?? null;
}
