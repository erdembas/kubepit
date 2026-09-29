import { describe, expect, it } from 'vitest';
import type { ClusterOverview, ClusterStatus } from '@/types';
import { clusterDetail, clusterUsage, shortVersion } from './explorerMeta';

const status = (extra: Partial<ClusterStatus> = {}): ClusterStatus => ({
  id: 'c1',
  state: 'connected',
  error: null,
  version: 'v1.31.2-gke.1066000',
  platform: 'GKE',
  server: 'https://10.0.0.1',
  connected_at: 1,
  ...extra,
});

const overview = (extra: Partial<ClusterOverview> = {}): ClusterOverview =>
  ({
    version: null,
    platform: null,
    nodes: { total: 3, ready: 2 },
    allocatable: { cpu_millicores: 4000, memory_bytes: 8 * 2 ** 30, pods: 330 },
    usage: { cpu_millicores: 1000, memory_bytes: 6 * 2 ** 30 },
    ...extra,
  }) as ClusterOverview;

describe('shortVersion', () => {
  it('drops the distribution suffix', () => {
    expect(shortVersion('v1.31.2-gke.1066000')).toBe('v1.31.2');
    expect(shortVersion('1.29.0+k3s1')).toBe('v1.29.0');
  });

  it('keeps what it cannot parse', () => {
    expect(shortVersion('dev')).toBe('dev');
    expect(shortVersion(null)).toBeNull();
  });
});

describe('clusterUsage', () => {
  it('reports percent of allocatable', () => {
    expect(clusterUsage(overview())).toEqual({ cpu: 25, memory: 75 });
  });

  it('is null without metrics-server', () => {
    expect(clusterUsage(overview({ usage: null }))).toBeNull();
    expect(clusterUsage(undefined)).toBeNull();
  });

  it('clamps and handles empty capacity', () => {
    const o = overview({
      allocatable: { cpu_millicores: 0, memory_bytes: 2 ** 30, pods: 0 },
      usage: { cpu_millicores: 10, memory_bytes: 2 ** 31 },
    });
    expect(clusterUsage(o)).toEqual({ cpu: null, memory: 100 });
  });
});

describe('clusterDetail', () => {
  const cluster = { name: 'staging', context: 'gke_acme_europe-west1_staging' };

  it('shows platform, version and node readiness once connected', () => {
    expect(clusterDetail(cluster, status(), overview())).toEqual(['GKE', 'v1.31.2', '2/3 nodes']);
  });

  it('uses the singular for one node', () => {
    expect(
      clusterDetail(cluster, status(), overview({ nodes: { total: 1, ready: 1 } })).at(-1),
    ).toBe('1/1 node');
  });

  it('shows the kubeconfig context while offline', () => {
    expect(clusterDetail(cluster, status({ state: 'disconnected' }), undefined)).toEqual([
      cluster.context,
    ]);
    expect(clusterDetail(cluster, undefined, undefined)).toEqual([cluster.context]);
  });

  it('omits a context that equals the name', () => {
    expect(clusterDetail({ name: 'kind', context: 'kind' }, undefined, undefined)).toEqual([]);
  });
});
