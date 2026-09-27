import { openAndConnect } from '@/lib/clusterActions';
import type { ClusterId } from '@/types';

/**
 * Cross-surface navigation into a cluster workbench. Shell surfaces (fleet
 * events, command palette, dashboard) only know kinds and names; the
 * workbench registers the resolver that maps them onto its own navigation
 * state, which keeps the shell free of workbench internals.
 */
export type ObjectNavigator = (
  clusterId: ClusterId,
  kind: string,
  namespace: string | null,
  name: string | null,
) => void;

let navigator: ObjectNavigator | null = null;

export function registerObjectNavigator(fn: ObjectNavigator) {
  navigator = fn;
  return () => {
    if (navigator === fn) navigator = null;
  };
}

/** Open the cluster tab (connecting if needed) and focus a kind, optionally one object. */
export function openObject(
  clusterId: ClusterId,
  kind: string,
  namespace: string | null = null,
  name: string | null = null,
) {
  openAndConnect(clusterId);
  navigator?.(clusterId, kind, namespace, name);
}
