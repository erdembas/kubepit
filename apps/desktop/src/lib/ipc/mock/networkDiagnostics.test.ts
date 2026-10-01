import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClusterDef } from '@/types';
import type { NetworkDiagnosticsRequest } from '@/types/networkDiagnostics';
import { runningContainers } from '@/components/workbench/network-diagnostics/model';
import './fixtures/build';
import { getDb, list, put } from './fixtures/db';
import { demoNetworkDiagnostics } from './networkDiagnostics';
import { handlers } from './registry';

const original = handlers.cluster_list;
afterEach(() => {
  handlers.cluster_list = original!;
  vi.useRealTimers();
});

function request(clusterId = 'c-kind'): NetworkDiagnosticsRequest {
  const pods = list(getDb(clusterId), 'pods');
  const pod = pods.find((p) => runningContainers(p).length > 0)!;
  const service = list(getDb(clusterId), 'services').find(
    (s) => s.metadata.name === 'payment-api',
  )!;
  return {
    namespace: pod.metadata.namespace!,
    pod: pod.metadata.name,
    container: runningContainers(pod)[0]!,
    target_namespace: service.metadata.namespace!,
    service: service.metadata.name,
    port: Number((service.spec?.ports as Array<{ port: number }>)[0]!.port),
    protocol: 'http',
    path: '/',
  };
}

describe('demo network diagnostics', () => {
  it('blocks read-only exec before inspecting source data', async () => {
    handlers.cluster_list = () => [{ id: 'c-kind', read_only: true } as ClusterDef];
    await expect(demoNetworkDiagnostics('c-kind', request())).rejects.toThrow(
      'network-diagnostics:read-only',
    );
  });
  it('blocks denied Pod exec even when locally writable', async () => {
    handlers.cluster_list = () => [{ id: 'c-prod-eu', read_only: false } as ClusterDef];
    await expect(demoNetworkDiagnostics('c-prod-eu', request('c-prod-eu'))).rejects.toThrow(
      'network-diagnostics:exec-permission',
    );
  });
  it('retains source, Service endpoints and bounded request commands', async () => {
    vi.useFakeTimers();
    handlers.cluster_list = () => [{ id: 'c-kind', read_only: false } as ClusterDef];
    const input = request();
    const promise = demoNetworkDiagnostics('c-kind', input);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result.request).toEqual(input);
    expect(result.service.ready_endpoints + result.service.unready_endpoints).toBeGreaterThan(0);
    expect(result.probes.map((p) => p.kind)).toEqual(['dns', 'tcp', 'http']);
    expect(result.probes.at(-1)?.command).toContain('--head');
    expect(result.probes.at(-1)?.command).not.toContain('--location');
  });
  it('maps invalid paths consistently with the native backend', async () => {
    handlers.cluster_list = () => [{ id: 'c-kind', read_only: false } as ClusterDef];
    await expect(
      demoNetworkDiagnostics('c-kind', { ...request(), path: '//other.host' }),
    ).rejects.toThrow('network-diagnostics:invalid-path');
  });
  it('does not invent a network failure for ExternalName targets without slices', async () => {
    vi.useFakeTimers();
    handlers.cluster_list = () => [{ id: 'c-kind', read_only: false } as ClusterDef];
    put(getDb('c-kind'), {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: 'external-fixture',
        namespace: 'checkout',
        uid: 'external-service-fixture',
      },
      spec: {
        type: 'ExternalName',
        externalName: 'fixture.example',
        ports: [{ port: 443, protocol: 'TCP' }],
      },
    });
    const promise = demoNetworkDiagnostics('c-kind', {
      ...request(),
      target_namespace: 'checkout',
      service: 'external-fixture',
      port: 443,
      protocol: 'https',
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result.service.external_name).toBe('fixture.example');
    expect(result.service.ready_endpoints).toBe(0);
    expect(
      result.probes.every((p) => p.status === 'unavailable' && p.reason === 'demo_external_name'),
    ).toBe(true);
  });
});
