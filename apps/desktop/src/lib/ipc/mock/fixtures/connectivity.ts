import type { ClusterProxyInfo, KubeconfigChanged, SavedPortForward } from '@/types';

/** Demo data for connectivity: saved port forwards, busy ports, proxies, a kubeconfig change. */

const now = Date.now();
const DAY = 86_400_000;

export const DEMO_SAVED_FORWARDS: SavedPortForward[] = [
  {
    id: 'spf-checkout-db',
    cluster_id: 'c-staging',
    namespace: 'checkout',
    kind: 'service',
    name: 'postgres',
    remote_port: 5432,
    local_port: 15432,
    label: 'Checkout DB',
    start_on_connect: true,
    created_at: now - 12 * DAY,
  },
  {
    id: 'spf-grafana',
    cluster_id: 'c-staging',
    namespace: 'monitoring',
    kind: 'service',
    name: 'grafana',
    remote_port: 80,
    // Busy in the demo: starting it on connect fails visibly.
    local_port: 3000,
    label: 'Grafana',
    start_on_connect: true,
    created_at: now - 9 * DAY,
  },
  {
    id: 'spf-dev-api',
    cluster_id: 'c-dev',
    namespace: 'default',
    kind: 'service',
    name: 'api',
    remote_port: 8080,
    local_port: null,
    label: null,
    start_on_connect: false,
    created_at: now - 3 * DAY,
  },
];

/** Local ports "held by another program" in the demo. */
export const DEMO_BUSY_PORTS = new Set([3000, 5000, 8080, 8443, 9090]);

/** The kubeconfig proxy-url of demo clusters (overrides come from ClusterDef). */
export const DEMO_KUBECONFIG_PROXIES: Record<string, string> = {
  'c-prod-eu': 'socks5h://bastion.acme.internal:1080',
};

export function demoProxyInfo(
  clusterId: string,
  override: string | null | undefined,
): ClusterProxyInfo {
  if (override?.trim()) return { url: override.replace(/:([^:@/]+)@/, ':***@'), source: 'cluster' };
  const fromKubeconfig = DEMO_KUBECONFIG_PROXIES[clusterId];
  return fromKubeconfig
    ? { url: fromKubeconfig, source: 'kubeconfig' }
    : { url: null, source: null };
}

/** Emitted once a little after start: a context the demo discovery lists but nobody imported. */
export function demoKubeconfigChange(connected: string[]): KubeconfigChanged {
  return {
    paths: ['~/.kube/config'],
    new_contexts: [
      {
        path: '~/.kube/config',
        context: 'docker-desktop',
        server: 'https://kubernetes.docker.internal:6443',
      },
    ],
    reconnect: connected.filter((id) => id === 'c-staging' || id === 'c-dev'),
  };
}
