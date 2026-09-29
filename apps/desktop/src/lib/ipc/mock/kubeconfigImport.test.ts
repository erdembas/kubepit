import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ClusterDef, ClusterInput, ClusterStatus, KubeconfigSource } from '@/types';

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
let invoke: Invoke;
beforeAll(async () => {
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('location', { search: '', href: 'http://localhost:1430/' });
  const mock = await import('./index');
  invoke = (command, args = {}) => mock.mockInvoke(command, args);
});
afterAll(() => vi.unstubAllGlobals());

function input(changes: Partial<ClusterInput> = {}): ClusterInput {
  return {
    name: 'Imported fixture',
    context: 'kind-kubepit',
    kubeconfig_path: '~/.kube/config',
    tags: ['kept'],
    environment: 'local',
    color: '#10b981',
    default_namespace: 'team',
    accessible_namespaces: ['team'],
    read_only: true,
    notes: 'My notes',
    ...changes,
  };
}
const contextless = '~/.kube/contextless-demo.yaml';

describe('demo managed kubeconfig lifecycle', () => {
  it('imports a file as a selected private copy with provenance and unchanged source', async () => {
    const original = await invoke<KubeconfigSource>('kubeconfig_parse_file', {
      path: '~/.kube/config',
    });
    const [added] = await invoke<ClusterDef[]>('cluster_add', { inputs: [input()] });
    expect(added!.managed).toBe(true);
    expect(added!.source_kubeconfig_path).toBe('~/.kube/config');
    expect(added!.kubeconfig_path).toMatch(/^~\/\.kubepit\/kubeconfigs\//);
    const copied = await invoke<KubeconfigSource>('cluster_kubeconfig_source', { id: added!.id });
    expect(copied.contexts.map((c) => c.name)).toEqual(['kind-kubepit']);
    expect(copied.clusters).toHaveLength(1);
    expect(copied.users).toEqual(['kind-kubepit']);
    expect(await invoke('kubeconfig_parse_file', { path: '~/.kube/config' })).toEqual(original);
    // Metadata saves cannot retarget a managed record or forge its provenance.
    const updated = await invoke<ClusterDef>('cluster_update', {
      cluster: {
        ...added,
        name: 'Renamed',
        managed: false,
        kubeconfig_path: '/untrusted.yaml',
        source_kubeconfig_path: '/forged.yaml',
      },
    });
    expect(updated).toMatchObject({
      name: 'Renamed',
      managed: true,
      kubeconfig_path: added!.kubeconfig_path,
      source_kubeconfig_path: '~/.kube/config',
    });
  });
  it('creates a connection from a contextless file and can repair from its stored copy', async () => {
    const original = await invoke<KubeconfigSource>('kubeconfig_parse_file', { path: contextless });
    const [added] = await invoke<ClusterDef[]>('cluster_add', {
      inputs: [
        input({
          context: 'my-reader',
          kubeconfig_path: contextless,
          create_context: { cluster: 'demo-west', user: 'demo-reader', namespace: 'team' },
        }),
      ],
    });
    const copied = await invoke<KubeconfigSource>('cluster_kubeconfig_source', { id: added!.id });
    expect(copied.current_context).toBe('my-reader');
    expect(copied.users).toEqual(['demo-reader']);
    expect(copied.clusters.map((c) => c.name)).toEqual(['demo-west']);
    const reimported = await invoke<ClusterDef>('cluster_reimport_kubeconfig', {
      id: added!.id,
      input: {
        context: 'new-reader',
        create_context: { cluster: 'demo-west', user: 'demo-reader', namespace: 'new-team' },
      },
    });
    expect(reimported).toMatchObject({
      id: added!.id,
      context: 'new-reader',
      name: added!.name,
      read_only: true,
      tags: ['kept'],
      notes: 'My notes',
      source_kubeconfig_path: contextless,
    });
    const status = await invoke<Record<string, ClusterStatus>>('cluster_statuses');
    expect(status[added!.id]).toMatchObject({ state: 'disconnected', error: null });
    const repairedSource = await invoke<KubeconfigSource>('cluster_kubeconfig_source', {
      id: added!.id,
    });
    expect(repairedSource.contexts).toHaveLength(1);
    expect(repairedSource.contexts[0]).toMatchObject({ name: 'new-reader', namespace: 'new-team' });
    expect(await invoke('kubeconfig_parse_file', { path: contextless })).toEqual(original);
  });
  it('reimports a legacy broken-context record preserving its id/settings, then supports pasted replacement', async () => {
    const existing = (await invoke<ClusterDef[]>('cluster_list')).find((c) => c.id === 'c-dev')!;
    const next = await invoke<ClusterDef>('cluster_reimport_kubeconfig', {
      id: existing.id,
      input: {
        kubeconfig_path: contextless,
        context: 'repair',
        create_context: { cluster: 'demo-east', user: 'demo-admin', namespace: null },
      },
    });
    expect(next).toMatchObject({
      id: existing.id,
      name: existing.name,
      tags: existing.tags,
      color: existing.color,
      environment: existing.environment,
      managed: true,
      source_kubeconfig_path: contextless,
    });
    const pasted = await invoke<ClusterDef>('cluster_reimport_kubeconfig', {
      id: existing.id,
      input: {
        context: 'anonymous',
        kubeconfig_text:
          'clusters: [{name: solo, cluster: {server: https://solo.example.invalid}}]',
        create_context: { cluster: 'solo', user: null, namespace: null },
      },
    });
    expect(pasted.source_kubeconfig_path).toBeNull();
    const inspected = await invoke<KubeconfigSource>('cluster_kubeconfig_source', {
      id: existing.id,
    });
    expect(inspected.users).toEqual([]);
    expect(inspected.contexts[0]?.name).toBe('anonymous');
  });
  it('keeps records unchanged when add or reimport selection is invalid', async () => {
    const before = structuredClone(await invoke<ClusterDef[]>('cluster_list'));
    await expect(
      invoke('cluster_add', { inputs: [input(), input({ context: 'nonexistent' })] }),
    ).rejects.toThrow();
    await expect(
      invoke('cluster_reimport_kubeconfig', {
        id: before[0]!.id,
        input: {
          context: 'new',
          kubeconfig_path: contextless,
          create_context: { cluster: 'demo-east', user: 'absent', namespace: null },
        },
      }),
    ).rejects.toThrow();
    expect(await invoke('cluster_list')).toEqual(before);
  });
});
