import * as i18n from '@/i18n/core';
import type {
  ClusterDef,
  ClusterId,
  ClusterStatus,
  KubeconfigChanged,
  KubeconfigNewContext,
} from '@/types';

/**
 * Pure helpers behind the kubeconfig-change notice: successive
 * `kubeconfig://changed` events accumulate until the user acts on them or
 * dismisses the notice.
 */

export const contextKey = (path: string, context: string) => `${path}\u0000${context}`;

export function mergeKubeconfigChange(
  previous: KubeconfigChanged | null,
  next: KubeconfigChanged,
): KubeconfigChanged {
  if (!previous) return next;
  const seen = new Set(previous.new_contexts.map((c) => contextKey(c.path, c.context)));
  return {
    paths: [...new Set([...previous.paths, ...next.paths])],
    new_contexts: [
      ...previous.new_contexts,
      ...next.new_contexts.filter((c) => !seen.has(contextKey(c.path, c.context))),
    ],
    reconnect: [...new Set([...previous.reconnect, ...next.reconnect])],
  };
}

/** What is still actionable: contexts not imported meanwhile, clusters still connected. */
export function pendingNotice(
  notice: KubeconfigChanged | null,
  clusters: ClusterDef[],
  statuses: Record<ClusterId, ClusterStatus>,
): { newContexts: KubeconfigNewContext[]; reconnect: ClusterDef[] } {
  if (!notice) return { newContexts: [], reconnect: [] };
  const registered = new Set(clusters.map((c) => contextKey(c.kubeconfig_path, c.context)));
  return {
    newContexts: notice.new_contexts.filter((c) => !registered.has(contextKey(c.path, c.context))),
    reconnect: clusters.filter(
      (c) => notice.reconnect.includes(c.id) && statuses[c.id]?.state === 'connected',
    ),
  };
}

/**
 * `~/…` for paths inside the home directory, which is the parent of the data
 * folder unless `KUBEPIT_HOME` moved it.
 */
export function tildify(path: string, dataDir: string | null | undefined): string {
  const home = dataDir?.match(/^(.+)[\\/]\.kubepit[\\/]?$/)?.[1];
  if (!home) return path;
  if (path === home) return '~';
  if (path.startsWith(`${home}/`) || path.startsWith(`${home}\\`))
    return `~${path.slice(home.length)}`;
  return path;
}

export function newContextsMessage(
  contexts: KubeconfigNewContext[],
  dataDir: string | null | undefined,
): string {
  const paths = [...new Set(contexts.map((c) => c.path))];
  if (paths.length === 1)
    return i18n.plural(
      '{count} new context in {path}',
      '{count} new contexts in {path}',
      contexts.length,
      { path: tildify(paths[0]!, dataDir) },
    );
  return i18n.plural(
    '{count} new context in your kubeconfig files',
    '{count} new contexts in your kubeconfig files',
    contexts.length,
  );
}

export function reconnectMessage(clusters: ClusterDef[]): string {
  if (clusters.length === 1)
    return i18n.t('The kubeconfig of {name} changed on disk.', { name: clusters[0]!.name });
  return i18n.plural(
    'The kubeconfig of {count} connected cluster changed on disk.',
    'The kubeconfigs of {count} connected clusters changed on disk.',
    clusters.length,
  );
}
