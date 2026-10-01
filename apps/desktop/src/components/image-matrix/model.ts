import type { KubeObject } from '@/types';
import { asArray, asObject, asString, get } from '@/lib/kube/accessors';
import { objectImages, podSpecImages, splitImage } from '@/lib/kube/images';

export const MATRIX_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet'] as const;
export type MatrixKind = (typeof MATRIX_KINDS)[number];
export const MATRIX_SOURCE_LIMIT = 10_000;
export const MATRIX_ROW_LIMIT = 500;
export interface MatrixSource {
  items: readonly KubeObject[];
  complete: boolean;
}
export interface MatrixInput {
  workloads: Record<MatrixKind, MatrixSource>;
  pods: MatrixSource;
  replicaSets: MatrixSource;
  nodes: MatrixSource;
}
export interface RuntimeImage {
  podSpecImage: string;
  /** Independent fields reported in containerStatuses, never filled from the spec. */
  image: string | null;
  imageId: string | null;
  platform: string | null;
  count: number;
}
export interface ImageCell {
  key: string;
  workloadKey: string;
  kind: MatrixKind;
  namespace: string;
  name: string;
  container: string;
  init: boolean;
  desired: string | null;
  observed: string[];
  runtime: RuntimeImage[];
  ready: number;
  total: number;
  unknownRuntime: number;
  templateDiffers: boolean;
  runtimeReferenceDiffers: boolean;
  complete: boolean;
}
export interface MatrixCluster {
  cells: ImageCell[];
  workloadKeys: Set<string>;
  completeKinds: Set<MatrixKind>;
  truncated: boolean;
  unattachedPods: number;
}
export interface ImageRow {
  key: string;
  example: ImageCell;
  cells: Record<string, ImageCell>;
  differentDesired: boolean;
}

/** Removed clusters and duplicates cannot occupy a slot in the selection cap. */
export function matrixClusterSelection(
  registeredIds: readonly string[],
  selectedIds: readonly string[] | null,
  limit: number,
): string[] {
  const registered = new Set(registeredIds);
  return [...new Set(selectedIds ?? registeredIds)]
    .filter((id) => registered.has(id))
    .slice(0, limit);
}

export function normalizedImage(image: string): string {
  const { repository, tag, digest } = splitImage(image);
  const parts = repository.split('/');
  const first = parts[0] ?? '';
  const qualified =
    parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost');
  let repo = qualified ? repository : `docker.io/${repository}`;
  repo = repo.replace(/^index\.docker\.io\//, 'docker.io/');
  if (repo.startsWith('docker.io/') && repo.split('/').length === 2)
    repo = repo.replace('docker.io/', 'docker.io/library/');
  return digest ? `${repo}@${digest}` : `${repo}:${tag || 'latest'}`;
}
const workloadKey = (kind: string, namespace: string, name: string) =>
  JSON.stringify([kind, namespace, name]);
const owner = (o: KubeObject) => o.metadata.ownerReferences?.find((ref) => ref.controller === true);
const sameOwner = (ref: ReturnType<typeof owner>, target: KubeObject) =>
  !!ref?.uid &&
  ref.uid === target.metadata.uid &&
  ref.name === target.metadata.name &&
  ref.kind === target.kind &&
  ref.apiVersion?.split('/')[0] === 'apps';

/** Observations are joined by Kubernetes owner UID, never by a loose label match.
 * Runtime image IDs are evidence, not a comparison against a registry/index digest. */
export function buildMatrixCluster(input: MatrixInput): MatrixCluster {
  let truncated = false;
  const bounded = (source: MatrixSource) => {
    if (source.items.length > MATRIX_SOURCE_LIMIT) truncated = true;
    return source.items.slice(0, MATRIX_SOURCE_LIMIT);
  };
  const workloads = MATRIX_KINDS.flatMap((kind) => bounded(input.workloads[kind]));
  const replicaSets = new Map(
    bounded(input.replicaSets)
      .filter((o) => o.metadata.uid)
      .map((o) => [o.metadata.uid!, o]),
  );
  const byUid = new Map(workloads.filter((o) => o.metadata.uid).map((o) => [o.metadata.uid!, o]));
  const nodes = new Map(bounded(input.nodes).map((o) => [o.metadata.name, o]));
  const podGroups = new Map<string, KubeObject[]>();
  let unattachedPods = 0;
  for (const pod of bounded(input.pods)) {
    if (pod.kind !== 'Pod' || ['Succeeded', 'Failed'].includes(asString(get(pod, 'status.phase'))))
      continue;
    let ref = owner(pod);
    if (ref?.kind === 'ReplicaSet' && ref.apiVersion?.split('/')[0] === 'apps') {
      const rs = replicaSets.get(ref.uid);
      if (!rs || rs.metadata.namespace !== pod.metadata.namespace || !sameOwner(ref, rs)) {
        unattachedPods++;
        continue;
      }
      ref = owner(rs);
    }
    const workload = ref?.uid ? byUid.get(ref.uid) : undefined;
    if (
      !workload ||
      workload.metadata.namespace !== pod.metadata.namespace ||
      !sameOwner(ref, workload)
    ) {
      // Jobs, standalone Pods and unavailable ownership chains are outside these rows.
      unattachedPods++;
      continue;
    }
    const uid = workload.metadata.uid!;
    const group = podGroups.get(uid) ?? [];
    group.push(pod);
    podGroups.set(uid, group);
  }
  const cells: ImageCell[] = [];
  const workloadKeys = new Set<string>();
  const completeKinds = new Set(
    MATRIX_KINDS.filter(
      (kind) =>
        input.workloads[kind].complete && input.workloads[kind].items.length <= MATRIX_SOURCE_LIMIT,
    ),
  );
  for (const workload of workloads) {
    if (!MATRIX_KINDS.includes(workload.kind as MatrixKind) || workload.apiVersion !== 'apps/v1')
      continue;
    const kind = workload.kind as MatrixKind;
    const namespace = workload.metadata.namespace ?? '';
    const name = workload.metadata.name;
    const wKey = workloadKey(kind, namespace, name);
    workloadKeys.add(wKey);
    const pods = podGroups.get(workload.metadata.uid ?? '') ?? [];
    const templates = objectImages(workload);
    const byContainer = new Map(
      templates.map((image) => [JSON.stringify([image.init, image.container]), image]),
    );
    for (const pod of pods) {
      for (const image of podSpecImages(pod.spec)) {
        const key = JSON.stringify([image.init, image.container]);
        if (!byContainer.has(key)) byContainer.set(key, { ...image, image: '' });
      }
    }
    for (const template of byContainer.values()) {
      const observed = new Set<string>();
      const runtime = new Map<string, RuntimeImage>();
      let ready = 0;
      let total = 0;
      let unknownRuntime = 0;
      let runtimeReferenceDiffers = false;
      for (const pod of pods) {
        const current = podSpecImages(pod.spec).find(
          (c) => c.init === template.init && c.container === template.container,
        );
        if (!current) continue;
        total++;
        observed.add(current.image);
        const states = asArray(
          get(pod, template.init ? 'status.initContainerStatuses' : 'status.containerStatuses'),
        ).map(asObject);
        const state = states.find((c) => c.name === template.container);
        if (
          state?.ready === true ||
          (template.init && get(state, 'state.terminated.exitCode') === 0)
        )
          ready++;
        const image = asString(state?.image) || null;
        const imageId = asString(state?.imageID) || null;
        if (!imageId) unknownRuntime++;
        // References can have different tag/digest forms. This marks a reported
        // reference difference, never a claim that image bytes or rollout are bad.
        if (image && normalizedImage(image) !== normalizedImage(current.image))
          runtimeReferenceDiffers = true;
        if (!image && !imageId) continue;
        const node = nodes.get(asString(get(pod, 'spec.nodeName')));
        const architecture =
          asString(node?.metadata.labels?.['kubernetes.io/arch']) ||
          asString(get(node, 'status.nodeInfo.architecture'));
        const os =
          asString(node?.metadata.labels?.['kubernetes.io/os']) ||
          asString(get(node, 'status.nodeInfo.operatingSystem'));
        const platform = architecture && os ? `${os}/${architecture}` : null;
        const runtimeKey = JSON.stringify([current.image, image, imageId, platform]);
        const record = runtime.get(runtimeKey) ?? {
          podSpecImage: current.image,
          image,
          imageId,
          platform,
          count: 0,
        };
        record.count++;
        runtime.set(runtimeKey, record);
      }
      const desired = template.image || null;
      cells.push({
        key: JSON.stringify([kind, namespace, name, template.init, template.container]),
        workloadKey: wKey,
        kind,
        namespace,
        name,
        container: template.container,
        init: template.init,
        desired,
        observed: [...observed].sort(),
        runtime: [...runtime.values()].sort((a, b) =>
          (a.imageId ?? '').localeCompare(b.imageId ?? ''),
        ),
        ready,
        total,
        unknownRuntime,
        templateDiffers: [...observed].some(
          (image) => !desired || normalizedImage(image) !== normalizedImage(desired),
        ),
        runtimeReferenceDiffers,
        complete:
          !!workload.metadata.uid &&
          completeKinds.has(kind) &&
          input.pods.complete &&
          input.pods.items.length <= MATRIX_SOURCE_LIMIT &&
          (kind !== 'Deployment' ||
            (input.replicaSets.complete && input.replicaSets.items.length <= MATRIX_SOURCE_LIMIT)),
      });
    }
  }
  return { cells, workloadKeys, completeKinds, truncated, unattachedPods };
}

export function imageRows(clusters: Record<string, MatrixCluster>): ImageRow[] {
  const rows = new Map<string, ImageRow>();
  for (const [id, cluster] of Object.entries(clusters))
    for (const cell of cluster.cells) {
      const row = rows.get(cell.key) ?? {
        key: cell.key,
        example: cell,
        cells: {},
        differentDesired: false,
      };
      row.cells[id] = cell;
      rows.set(cell.key, row);
    }
  return [...rows.values()]
    .map((row) => ({
      ...row,
      differentDesired:
        new Set(
          Object.values(row.cells).flatMap((cell) =>
            cell.desired ? [normalizedImage(cell.desired)] : [],
          ),
        ).size > 1,
    }))
    .sort(
      (a, b) =>
        a.example.namespace.localeCompare(b.example.namespace) ||
        a.example.name.localeCompare(b.example.name) ||
        a.key.localeCompare(b.key),
    );
}
