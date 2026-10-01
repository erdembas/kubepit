import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@/types';
import {
  buildMatrixCluster,
  imageRows,
  matrixClusterSelection,
  normalizedImage,
  type MatrixInput,
  type MatrixSource,
} from './model';

const source = (items: KubeObject[] = [], complete = true): MatrixSource => ({ items, complete });
const ref = (kind: string, uid: string, name = kind.toLowerCase()) => ({
  apiVersion: 'apps/v1',
  kind,
  uid,
  name,
  controller: true,
});
const workload = (image = 'nginx:1', uid = 'deployment', name = 'deployment'): KubeObject => ({
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name, namespace: 'ns', uid },
  spec: { template: { spec: { containers: [{ name: 'app', image }] } } },
});
const rs: KubeObject = {
  apiVersion: 'apps/v1',
  kind: 'ReplicaSet',
  metadata: {
    name: 'replicaset',
    namespace: 'ns',
    uid: 'rs',
    ownerReferences: [ref('Deployment', 'deployment')],
  },
};
const pod = (image = 'nginx:1', imageID = 'containerd://sha256:aaa', node = 'a'): KubeObject => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: {
    name: `pod-${node}`,
    uid: `pod-${node}`,
    namespace: 'ns',
    ownerReferences: [ref('ReplicaSet', 'rs')],
  },
  spec: { nodeName: node, containers: [{ name: 'app', image }] },
  status: { phase: 'Running', containerStatuses: [{ name: 'app', image, imageID, ready: true }] },
});
const input = (): MatrixInput => ({
  workloads: { Deployment: source([workload()]), StatefulSet: source(), DaemonSet: source() },
  replicaSets: source([rs]),
  pods: source([pod()]),
  nodes: source(),
});

describe('image version matrix', () => {
  it('prunes removed selections before applying the cluster cap', () => {
    const registry = ['a', 'b', 'c'];
    const previous = ['removed', 'a', 'b'];
    const active = matrixClusterSelection(registry, previous, 3);
    expect(active).toEqual(['a', 'b']);
    expect(matrixClusterSelection(registry, [...active, 'c'], 3)).toEqual(['a', 'b', 'c']);
    expect(matrixClusterSelection(registry, ['a', 'a', 'b', 'c'], 3)).toEqual(registry);
    expect(matrixClusterSelection(registry, [], 3)).toEqual([]);
  });
  it('preserves an older runtime-reported image when the Pod spec already changed', () => {
    const data = input();
    data.workloads.Deployment = source([workload('nginx:2')]);
    const running = pod('nginx:2');
    running.status.containerStatuses[0].image = 'docker.io/library/nginx:1';
    data.pods = source([running]);
    const cell = buildMatrixCluster(data).cells[0]!;
    expect(cell.observed).toEqual(['nginx:2']);
    expect(cell.templateDiffers).toBe(false);
    expect(cell.runtimeReferenceDiffers).toBe(true);
    expect(cell.runtime[0]).toMatchObject({
      podSpecImage: 'nginx:2',
      image: 'docker.io/library/nginx:1',
      imageId: 'containerd://sha256:aaa',
    });
  });
  it('does not fill missing runtime fields from the Pod spec and retains separately reported fields', () => {
    const data = input();
    const running = pod();
    delete running.status.containerStatuses[0].image;
    data.pods = source([running]);
    expect(buildMatrixCluster(data).cells[0]?.runtime[0]).toMatchObject({
      image: null,
      imageId: 'containerd://sha256:aaa',
    });
    running.status.containerStatuses[0].image = 'nginx:1';
    delete running.status.containerStatuses[0].imageID;
    const cell = buildMatrixCluster(data).cells[0]!;
    expect(cell.runtime[0]).toMatchObject({ image: 'nginx:1', imageId: null });
    expect(cell.unknownRuntime).toBe(1);
    expect(cell.runtimeReferenceDiffers).toBe(false);
  });
  it('joins live Pod images via owner UIDs and ignores a reused workload name', () => {
    const data = input();
    expect(buildMatrixCluster(data).cells[0]).toMatchObject({
      total: 1,
      ready: 1,
      templateDiffers: false,
      complete: true,
    });
    data.workloads.Deployment = source([workload('nginx:1', 'replacement')]);
    expect(buildMatrixCluster(data).cells[0]?.total).toBe(0);
    expect(buildMatrixCluster(data).unattachedPods).toBe(1);
  });
  it('separates desired differences across clusters from rollout observations', () => {
    const first = input();
    const second = input();
    second.workloads.Deployment = source([workload('nginx:2')]);
    const row = imageRows({ a: buildMatrixCluster(first), b: buildMatrixCluster(second) })[0]!;
    expect(row.differentDesired).toBe(true);
    expect(row.cells.a?.templateDiffers).toBe(false);
    expect(row.cells.b?.templateDiffers).toBe(true);
  });
  it('normalizes equivalent Docker references without guessing registry versions', () => {
    expect(normalizedImage('nginx')).toBe(normalizedImage('docker.io/library/nginx:latest'));
    expect(normalizedImage('index.docker.io/team/api:1')).toBe(normalizedImage('team/api:1'));
    expect(normalizedImage('localhost:5000/api:1')).not.toBe(normalizedImage('api:1'));
    expect(normalizedImage('nginx:old@sha256:abc')).toBe(normalizedImage('nginx:new@sha256:abc'));
  });
  it('keeps missing ownership and partial lists unknown rather than a healthy zero', () => {
    const data = input();
    data.replicaSets = source([], false);
    const result = buildMatrixCluster(data);
    expect(result.cells[0]).toMatchObject({ total: 0, complete: false });
    data.workloads.Deployment = source([], false);
    expect(buildMatrixCluster(data).completeKinds.has('Deployment')).toBe(false);
  });
  it('groups runtime IDs by platform without treating architecture changes as image drift', () => {
    const data = input();
    data.pods = source([pod(), pod('nginx:1', 'docker-pullable://nginx@sha256:bbb', 'b')]);
    data.nodes = source(
      ['a', 'b'].map((name) => ({
        apiVersion: 'v1',
        kind: 'Node',
        metadata: {
          name,
          uid: name,
          labels: {
            'kubernetes.io/os': 'linux',
            'kubernetes.io/arch': name === 'a' ? 'amd64' : 'arm64',
          },
        },
      })),
    );
    const cell = buildMatrixCluster(data).cells[0]!;
    expect(cell.runtime.map((r) => r.platform).sort()).toEqual(['linux/amd64', 'linux/arm64']);
    expect(cell.templateDiffers).toBe(false);
    expect(cell.total).toBe(2);
  });
  it('preserves containers removed from the new template while older Pods remain', () => {
    const data = input();
    data.workloads.Deployment = source([
      { ...workload(), spec: { template: { spec: { containers: [] } } } },
    ]);
    expect(buildMatrixCluster(data).cells[0]).toMatchObject({
      desired: null,
      total: 1,
      templateDiffers: true,
    });
  });
  it('keeps init-container evidence separate and excludes completed Pods', () => {
    const data = input();
    const w = workload();
    w.spec = {
      template: {
        spec: {
          containers: [{ name: 'app', image: 'nginx:1' }],
          initContainers: [{ name: 'setup', image: 'busybox:1' }],
        },
      },
    };
    const p = pod();
    p.spec = { ...p.spec, initContainers: [{ name: 'setup', image: 'busybox:1' }] };
    p.status = {
      ...p.status,
      initContainerStatuses: [
        {
          name: 'setup',
          imageID: 'sha256:setup',
          ready: false,
          state: { terminated: { exitCode: 0 } },
        },
      ],
    };
    data.workloads.Deployment = source([w]);
    data.pods = source([p, { ...pod(), status: { phase: 'Succeeded' } }]);
    const cells = buildMatrixCluster(data).cells;
    expect(cells.find((c) => c.init)).toMatchObject({ container: 'setup', ready: 1, total: 1 });
    expect(cells.find((c) => !c.init)?.total).toBe(1);
  });
});
