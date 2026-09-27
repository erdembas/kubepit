/** Per-cluster shape of the demo data (matches the clusters in `mock/app.ts`). */
export interface ClusterProfile {
  id: string;
  platform: 'EKS' | 'GKE' | 'AKS' | 'kind';
  version: string;
  nodes: number;
  /** Approximate total pod count (filler team namespaces top up to it). */
  pods: number;
  zones: string[];
  region: string;
  domain: string;
  metrics: boolean;
  argocd: boolean;
  gpuNodes: number;
  /** Node index that is cordoned, if any. */
  cordoned: number | null;
  /** Node index that is NotReady, if any. */
  notReady: number | null;
  /** Emit the classic set of warning pods/events. */
  troubled: boolean;
  /** Cluster-wide secret listing is forbidden (namespaced access works). */
  forbidClusterSecrets: boolean;
  teams: string[];
  ipBase: number;
}

const TEAMS = [
  'payments',
  'search',
  'identity',
  'notifications',
  'catalog',
  'analytics',
  'growth',
  'fraud',
  'pricing',
  'shipping',
];

export const PROFILES: Record<string, ClusterProfile> = {
  'c-prod-eu': {
    id: 'c-prod-eu',
    platform: 'EKS',
    version: 'v1.31.4-eks-2d98532',
    nodes: 24,
    pods: 612,
    zones: ['eu-west-1a', 'eu-west-1b', 'eu-west-1c'],
    region: 'eu-west-1',
    domain: 'acme.eu',
    metrics: true,
    argocd: true,
    gpuNodes: 2,
    cordoned: null,
    notReady: null,
    troubled: true,
    forbidClusterSecrets: false,
    teams: TEAMS.slice(0, 8),
    ipBase: 10,
  },
  'c-prod-us': {
    id: 'c-prod-us',
    platform: 'EKS',
    version: 'v1.30.8-eks-2d98532',
    nodes: 18,
    pods: 431,
    zones: ['us-east-1a', 'us-east-1b', 'us-east-1c'],
    region: 'us-east-1',
    domain: 'acme.com',
    metrics: true,
    argocd: true,
    gpuNodes: 0,
    cordoned: 4,
    notReady: 11,
    troubled: true,
    forbidClusterSecrets: false,
    teams: TEAMS.slice(2, 8),
    ipBase: 20,
  },
  'c-staging': {
    id: 'c-staging',
    platform: 'GKE',
    version: 'v1.31.5-gke.1068000',
    nodes: 6,
    pods: 148,
    zones: ['europe-west4-a', 'europe-west4-b'],
    region: 'europe-west4',
    domain: 'staging.acme.dev',
    metrics: true,
    argocd: true,
    gpuNodes: 0,
    cordoned: 2,
    notReady: null,
    troubled: true,
    forbidClusterSecrets: true,
    teams: TEAMS.slice(0, 3),
    ipBase: 30,
  },
  'c-dev': {
    id: 'c-dev',
    platform: 'AKS',
    version: 'v1.30.6',
    nodes: 4,
    pods: 96,
    zones: ['westeurope-1', 'westeurope-2'],
    region: 'westeurope',
    domain: 'dev.acme.dev',
    metrics: false,
    argocd: false,
    gpuNodes: 0,
    cordoned: 3,
    notReady: null,
    troubled: true,
    forbidClusterSecrets: false,
    teams: TEAMS.slice(0, 2),
    ipBase: 40,
  },
  'c-kind': {
    id: 'c-kind',
    platform: 'kind',
    version: 'v1.32.2',
    nodes: 3,
    pods: 27,
    zones: [],
    region: 'local',
    domain: 'localtest.me',
    metrics: true,
    argocd: false,
    gpuNodes: 0,
    cordoned: null,
    notReady: null,
    troubled: false,
    forbidClusterSecrets: false,
    teams: [],
    ipBase: 50,
  },
};

export function profileFor(clusterId: string): ClusterProfile {
  return (
    PROFILES[clusterId] ?? {
      ...PROFILES['c-kind']!,
      id: clusterId,
    }
  );
}
