import presets from '../../../../../../../perf/scale-presets.json';
import type { KubeObject, ObjectMeta, WatchBatch } from '@/types';
import { b64, hashString } from './util';

/**
 * Scaled demo clusters for performance work (`?scale=s|m|l`, `&churn=<n>`).
 * The presets come from `perf/scale-presets.json`, shared with the Rust
 * fake-API-server fixture (`crates/kubepit-core/tests/support/scale.rs`);
 * `generateScaleObjects` mirrors that fixture's names and shapes, so backend
 * and UI numbers stay comparable. Pure: no DB, no timers, no clock.
 */

export type ScalePresetName = 's' | 'm' | 'l';
type ScalePreset = (typeof presets)[ScalePresetName];

const PRESET_NAMES: readonly ScalePresetName[] = ['s', 'm', 'l'];
/** Upper bound of `&churn=` (pod changes per second). */
export const MAX_CHURN = 1000;
/** The backend flushes a watch batch once this many objects are pending (`watch.rs`). */
export const WATCH_BATCH_MAX = 500;
/** The backend's watch flush cadence (`watch.rs`). */
export const WATCH_BATCH_INTERVAL_MS = 150;

/** `?scale=` and `&churn=` of a location search string. */
export function scaleParams(search: string): { scale: ScalePresetName | null; churn: number } {
  const params = new URLSearchParams(search);
  const raw = params.get('scale');
  const scale = PRESET_NAMES.find((p) => p === raw) ?? null;
  const churn = Number(params.get('churn') ?? 0);
  return {
    scale,
    churn: Number.isFinite(churn) ? Math.min(MAX_CHURN, Math.max(0, churn)) : 0,
  };
}

/** `target` with the scale switches (and `perf`) of `current`, for a new demo window. */
export function withScaleParams(target: URL, current: string): URL {
  const url = new URL(target);
  const from = new URLSearchParams(current);
  for (const key of ['scale', 'churn', 'perf']) {
    const value = from.get(key);
    if (value !== null) url.searchParams.set(key, value);
  }
  return url;
}

export function scaleClusterId(preset: ScalePresetName) {
  return `c-scale-${preset}`;
}

/** The preset of a `c-scale-<preset>` cluster id, else `null`. */
export function scalePresetOf(clusterId: string): ScalePresetName | null {
  return PRESET_NAMES.find((p) => scaleClusterId(p) === clusterId) ?? null;
}

export function scalePreset(preset: ScalePresetName): ScalePreset {
  return presets[preset];
}

/**
 * An initial list cut into backend-sized batches: at most `max` objects,
 * `reset` only on the first and `synced` only on the last. An empty list is
 * one reset + synced batch. `deliverList` (`./db.ts`) paces them like the
 * backend: full batches at once, the rest with `synced` at the next flush tick.
 */
export function chunkBatches(
  watchId: string,
  items: readonly KubeObject[],
  max = WATCH_BATCH_MAX,
): WatchBatch[] {
  const size = Math.max(1, Math.floor(max));
  const batches: WatchBatch[] = [];
  for (let start = 0; start < items.length || batches.length === 0; start += size) {
    batches.push({
      watch_id: watchId,
      reset: start === 0,
      upserts: items.slice(start, start + size),
      deletes: [],
      synced: start + size >= items.length,
      error: null,
      recovered: false,
    });
  }
  return batches;
}

// ---------------------------------------------------------------------------
// Generator (mirrors `generate_objects` in the Rust fixture)
// ---------------------------------------------------------------------------

const TEAMS = [
  'payments',
  'search',
  'identity',
  'catalog',
  'growth',
  'pricing',
  'shipping',
  'platform',
];
const ROLES = ['api', 'web', 'worker', 'cache', 'gateway'];
const ZONES = ['zone-a', 'zone-b', 'zone-c'];
const ALPHABET = 'bcdfghjklmnpqrstvwxz2456789';
const CLUSTER_BORN = '2026-06-01T00:00:00Z';
const APP_BORN = '2026-08-01T00:00:00Z';
const ROLLOUT = '2026-08-30T00:00:00Z';
const EVENT_REASONS: Array<[string, string]> = [
  ['Scheduled', 'Successfully assigned {ns}/{pod} to {node}'],
  ['Pulled', 'Container image "{image}" already present on machine'],
  ['Created', 'Created container {container}'],
  ['Started', 'Started container {container}'],
];

// uid tags per kind (second uuid group), as in the Rust fixture.
const TAG = {
  namespace: 0x1,
  node: 0x2,
  serviceAccount: 0x3,
  deployment: 0x4,
  replicaSet: 0x5,
  pod: 0x6,
  service: 0x7,
  endpointSlice: 0x8,
  configMap: 0x9,
  secret: 0xa,
  crd: 0xb,
  customResource: 0xc,
  event: 0xd,
  /** Pods recreated by `&churn=` (demo only). */
  churn: 0xe,
} as const;

/** Seeded xorshift32, one stream per object (seed, tag, index); bit-identical to the Rust `Rng`. */
export class ScaleRng {
  private state: number;

  constructor(seed: number, tag: number, index: number) {
    let h = seed ^ Math.imul(tag, 0x9e3779b1) ^ Math.imul(index, 0x85ebca77);
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    h >>>= 0;
    this.state = h === 0 ? 0x6d2b79f5 : h;
  }

  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }

  name(length: number): string {
    let out = '';
    for (let i = 0; i < length; i++) out += ALPHABET[this.next() % ALPHABET.length];
    return out;
  }
}

/** A new name suffix for the `sequence`-th pod recreated by churn. */
export function churnSuffix(preset: ScalePresetName, sequence: number) {
  return new ScaleRng(presets[preset].seed, TAG.churn, sequence).name(5);
}

const pad = (n: number) => String(n).padStart(4, '0');
const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');

function metadata(name: string, namespace: string | null, uid: string, created: string) {
  const meta: ObjectMeta = { name, uid, creationTimestamp: created };
  if (namespace) meta.namespace = namespace;
  return meta;
}

function owner(o: KubeObject) {
  const ref = {
    apiVersion: o.apiVersion,
    kind: o.kind,
    name: o.metadata.name,
    uid: o.metadata.uid,
    controller: true,
    blockOwnerDeletion: true,
  };
  return [ref];
}

const nodeIp = (index: number) => `10.0.${Math.floor(index / 200)}.${(index % 200) + 10}`;
const podIp = (index: number) =>
  `10.${128 + Math.floor(index / 62_500)}.${Math.floor(index / 250) % 250}.${(index % 250) + 2}`;

function eventTime(index: number) {
  const secs = index % 86_400;
  const two = (n: number) => String(n).padStart(2, '0');
  return `2026-08-31T${two(Math.floor(secs / 3600))}:${two(Math.floor(secs / 60) % 60)}:${two(secs % 60)}Z`;
}

function container(role: string, image: string) {
  return {
    name: role,
    image,
    ports: [{ name: 'http', containerPort: 8080, protocol: 'TCP' }],
    resources: {
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: '500m', memory: '256Mi' },
    },
  };
}

function template(app: string, team: string, hash: string | null, role: string, image: string) {
  const labels: Record<string, string> = { app, team };
  if (hash) labels['pod-template-hash'] = hash;
  return {
    metadata: { labels },
    spec: { serviceAccountName: 'default', containers: [container(role, image)] },
  };
}

const byNamespaceAndName = (a: KubeObject, b: KubeObject) => {
  const an = a.metadata.namespace ?? '';
  const bn = b.metadata.namespace ?? '';
  if (an !== bn) return an < bn ? -1 : 1;
  return a.metadata.name < b.metadata.name ? -1 : a.metadata.name > b.metadata.name ? 1 : 0;
};

/**
 * Every object of a scaled demo cluster: the Rust fixture's collections
 * (metrics excepted: the demo derives them from the pods), each kind sorted
 * by (namespace, name). Deterministic for (`preset`, `clusterId`); uids are
 * unique per cluster id.
 */
export function generateScaleObjects(preset: ScalePresetName, clusterId: string): KubeObject[] {
  const p = presets[preset];
  const seed = p.seed;
  const cluster = hex(hashString(clusterId), 8);
  const uid = (tag: number, index: number) =>
    `${cluster}-${hex(tag, 4)}-4000-8000-${hex(index, 12)}`;
  const kinds = new Map<string, KubeObject[]>();
  const push = (o: KubeObject) => {
    const key = `${o.apiVersion}/${o.kind}`;
    let items = kinds.get(key);
    if (!items) kinds.set(key, (items = []));
    items.push(o);
  };

  // Namespaces, each with its `default` ServiceAccount.
  for (let i = 1; i <= p.namespaces; i++) {
    const name = `ns-${pad(i)}`;
    const team = TEAMS[(i - 1) % TEAMS.length]!;
    const meta = metadata(name, null, uid(TAG.namespace, i), CLUSTER_BORN);
    meta.labels = { 'kubernetes.io/metadata.name': name, team };
    push({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: meta,
      spec: { finalizers: ['kubernetes'] },
      status: { phase: 'Active' },
    });
    push({
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: metadata('default', name, uid(TAG.serviceAccount, i), CLUSTER_BORN),
    });
  }

  // Nodes.
  for (let i = 1; i <= p.nodes; i++) {
    const name = `node-${pad(i)}`;
    const meta = metadata(name, null, uid(TAG.node, i), CLUSTER_BORN);
    meta.labels = {
      'kubernetes.io/hostname': name,
      'kubernetes.io/os': 'linux',
      'kubernetes.io/arch': 'amd64',
      'topology.kubernetes.io/zone': ZONES[(i - 1) % ZONES.length]!,
    };
    push({
      apiVersion: 'v1',
      kind: 'Node',
      metadata: meta,
      spec: { podCIDR: `10.244.${i - 1}.0/24` },
      status: {
        capacity: { cpu: '8', memory: '32Gi', pods: '110' },
        allocatable: { cpu: '7910m', memory: '31Gi', pods: '110' },
        conditions: [
          {
            type: 'Ready',
            status: 'True',
            reason: 'KubeletReady',
            lastTransitionTime: CLUSTER_BORN,
          },
        ],
        addresses: [
          { type: 'InternalIP', address: nodeIp(i - 1) },
          { type: 'Hostname', address: name },
        ],
        nodeInfo: {
          kubeletVersion: 'v1.31.0',
          kubeProxyVersion: 'v1.31.0',
          osImage: 'Ubuntu 24.04 LTS',
          operatingSystem: 'linux',
          architecture: 'amd64',
          containerRuntimeVersion: 'containerd://1.7.22',
        },
      },
    });
  }

  // Apps: `deploymentsPerNamespace` Deployments per namespace (the remainder
  // of a fractional value goes to the first namespaces), each with its old
  // and current ReplicaSets, pods (round-robin over nodes), Services with one
  // EndpointSlice each, ConfigMaps and Secrets. One xorshift stream per
  // Deployment draws, in order: the current and old pod-template hashes, the
  // pod suffixes, then the EndpointSlice suffixes.
  const total = Math.round(p.namespaces * p.deploymentsPerNamespace);
  const base = Math.floor(p.deploymentsPerNamespace);
  const extra = Math.max(0, total - base * p.namespaces);
  const nodes = Math.max(1, p.nodes);
  let d = 0;
  let podIndex = 0;
  let serviceIndex = 0;
  let rsIndex = 0;
  let cmIndex = 0;
  let secretIndex = 0;
  const eventPods: Array<{ name: string; ns: string; node: string; role: string; image: string }> =
    [];
  for (let nsIndex = 1; nsIndex <= p.namespaces; nsIndex++) {
    const ns = `ns-${pad(nsIndex)}`;
    const team = TEAMS[(nsIndex - 1) % TEAMS.length]!;
    const count = base + (nsIndex <= extra ? 1 : 0);
    for (let n = 0; n < count; n++) {
      d++;
      const role = ROLES[(d - 1) % ROLES.length]!;
      const app = `app-${pad(d)}-${role}`;
      const image = `registry.example.com/${role}:1.${d % 20}.0`;
      const rng = new ScaleRng(seed, TAG.deployment, d);
      const hash = rng.name(10);
      const oldHashes = Array.from({ length: p.oldReplicaSets }, () => rng.name(10));
      const revision = p.oldReplicaSets + 1;

      const depMeta = metadata(app, ns, uid(TAG.deployment, d), APP_BORN);
      depMeta.labels = { app, team };
      depMeta.annotations = { 'deployment.kubernetes.io/revision': String(revision) };
      depMeta.generation = revision;
      const deployment: KubeObject = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: depMeta,
        spec: {
          replicas: p.replicas,
          selector: { matchLabels: { app } },
          strategy: {
            type: 'RollingUpdate',
            rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' },
          },
          template: template(app, team, null, role, image),
        },
        status: {
          observedGeneration: revision,
          replicas: p.replicas,
          updatedReplicas: p.replicas,
          readyReplicas: p.replicas,
          availableReplicas: p.replicas,
          conditions: [
            {
              type: 'Available',
              status: 'True',
              reason: 'MinimumReplicasAvailable',
              lastTransitionTime: ROLLOUT,
            },
            {
              type: 'Progressing',
              status: 'True',
              reason: 'NewReplicaSetAvailable',
              lastTransitionTime: ROLLOUT,
            },
          ],
        },
      };

      const replicaSet = (
        name: string,
        podHash: string,
        rev: number,
        replicas: number,
        created: string,
        index: number,
      ): KubeObject => {
        const meta = metadata(name, ns, uid(TAG.replicaSet, index), created);
        meta.labels = { app, team, 'pod-template-hash': podHash };
        meta.annotations = {
          'deployment.kubernetes.io/revision': String(rev),
          'deployment.kubernetes.io/desired-replicas': String(p.replicas),
        };
        meta.ownerReferences = owner(deployment);
        return {
          apiVersion: 'apps/v1',
          kind: 'ReplicaSet',
          metadata: meta,
          spec: {
            replicas,
            selector: { matchLabels: { app, 'pod-template-hash': podHash } },
            template: template(app, team, podHash, role, image),
          },
          status: {
            replicas,
            fullyLabeledReplicas: replicas,
            readyReplicas: replicas,
            availableReplicas: replicas,
            observedGeneration: 1,
          },
        };
      };
      oldHashes.forEach((old, k) => {
        rsIndex++;
        push(replicaSet(`${app}-${old}`, old, k + 1, 0, APP_BORN, rsIndex));
      });
      rsIndex++;
      const rsName = `${app}-${hash}`;
      const current = replicaSet(rsName, hash, revision, p.replicas, ROLLOUT, rsIndex);

      const pods: KubeObject[] = [];
      for (let r = 0; r < p.replicas; r++) {
        const name = `${rsName}-${rng.name(5)}`;
        const node = `node-${pad((podIndex % nodes) + 1)}`;
        const meta = metadata(name, ns, uid(TAG.pod, podIndex + 1), ROLLOUT);
        meta.labels = { app, team, 'pod-template-hash': hash };
        meta.ownerReferences = owner(current);
        pods.push({
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: meta,
          spec: {
            ...template(app, team, hash, role, image).spec,
            nodeName: node,
            restartPolicy: 'Always',
          },
          status: {
            phase: 'Running',
            podIP: podIp(podIndex),
            hostIP: nodeIp(podIndex % nodes),
            startTime: ROLLOUT,
            qosClass: 'Burstable',
            conditions: [
              { type: 'Initialized', status: 'True', lastTransitionTime: ROLLOUT },
              { type: 'Ready', status: 'True', lastTransitionTime: ROLLOUT },
              { type: 'ContainersReady', status: 'True', lastTransitionTime: ROLLOUT },
              { type: 'PodScheduled', status: 'True', lastTransitionTime: ROLLOUT },
            ],
            containerStatuses: [
              {
                name: role,
                image,
                ready: true,
                started: true,
                restartCount: 0,
                state: { running: { startedAt: ROLLOUT } },
              },
            ],
          },
        });
        eventPods.push({ name, ns, node, role, image });
        podIndex++;
      }

      for (let k = 1; k <= p.servicesPerDeployment; k++) {
        serviceIndex++;
        const name = k === 1 ? app : `${app}-${k}`;
        const svcMeta = metadata(name, ns, uid(TAG.service, serviceIndex), APP_BORN);
        svcMeta.labels = { app, team };
        const service: KubeObject = {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: svcMeta,
          spec: {
            type: 'ClusterIP',
            clusterIP: `10.96.${Math.floor((serviceIndex - 1) / 250)}.${((serviceIndex - 1) % 250) + 2}`,
            selector: { app },
            ports: [{ name: 'http', port: 80, targetPort: 8080, protocol: 'TCP' }],
          },
        };
        const sliceMeta = metadata(
          `${name}-${rng.name(5)}`,
          ns,
          uid(TAG.endpointSlice, serviceIndex),
          ROLLOUT,
        );
        sliceMeta.labels = {
          'kubernetes.io/service-name': name,
          'endpointslice.kubernetes.io/managed-by': 'endpointslice-controller.k8s.io',
        };
        sliceMeta.ownerReferences = owner(service);
        push({
          apiVersion: 'discovery.k8s.io/v1',
          kind: 'EndpointSlice',
          metadata: sliceMeta,
          addressType: 'IPv4',
          endpoints: pods.map((pod) => ({
            addresses: [pod.status.podIP],
            conditions: { ready: true, serving: true, terminating: false },
            nodeName: pod.spec.nodeName,
            targetRef: {
              kind: 'Pod',
              namespace: ns,
              name: pod.metadata.name,
              uid: pod.metadata.uid,
            },
          })),
          ports: [{ name: 'http', port: 8080, protocol: 'TCP' }],
        });
        push(service);
      }
      for (let k = 1; k <= p.configMapsPerDeployment; k++) {
        cmIndex++;
        const meta = metadata(`${app}-config-${k}`, ns, uid(TAG.configMap, cmIndex), APP_BORN);
        meta.labels = { app, team };
        push({
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: meta,
          data: {
            LOG_LEVEL: 'info',
            'app.properties': `service.name=${app}\nservice.port=8080\n`,
          },
        });
      }
      for (let k = 1; k <= p.secretsPerDeployment; k++) {
        secretIndex++;
        const meta = metadata(`${app}-secret-${k}`, ns, uid(TAG.secret, secretIndex), APP_BORN);
        meta.labels = { app, team };
        push({
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: meta,
          type: 'Opaque',
          data: { username: b64(app), password: b64(`scale-secret-${secretIndex}`) },
        });
      }
      push(deployment);
      push(current);
      for (const pod of pods) push(pod);
    }
  }

  // CRDs `widgets.scale{i}.example.com`, their Widgets spread round-robin
  // over the namespaces.
  for (let i = 1; i <= p.crds; i++) {
    const group = `scale${i}.example.com`;
    const names = { kind: 'Widget', listKind: 'WidgetList', plural: 'widgets', singular: 'widget' };
    push({
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: metadata(`widgets.${group}`, null, uid(TAG.crd, i), CLUSTER_BORN),
      spec: {
        group,
        names,
        scope: 'Namespaced',
        versions: [
          {
            name: 'v1',
            served: true,
            storage: true,
            schema: {
              openAPIV3Schema: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
            },
          },
        ],
      },
      status: {
        acceptedNames: names,
        storedVersions: ['v1'],
        conditions: [
          {
            type: 'Established',
            status: 'True',
            reason: 'InitialNamesAccepted',
            lastTransitionTime: CLUSTER_BORN,
          },
        ],
      },
    });
    for (let j = 1; j <= p.crsPerCrd; j++) {
      const index = (i - 1) * p.crsPerCrd + j;
      const ns = `ns-${pad(((index - 1) % Math.max(1, p.namespaces)) + 1)}`;
      const meta = metadata(`widget-${pad(j)}`, ns, uid(TAG.customResource, index), APP_BORN);
      meta.generation = 1;
      push({
        apiVersion: `${group}/v1`,
        kind: 'Widget',
        metadata: meta,
        spec: { size: ((i * j) % 10) + 1, color: ZONES[j % ZONES.length] },
        status: { ready: true, observedGeneration: 1 },
      });
    }
  }

  // Events: round-robin over the pods, reasons in lifecycle order.
  if (eventPods.length) {
    for (let k = 0; k < p.events; k++) {
      const pod = eventPods[k % eventPods.length]!;
      const [reason, text] =
        EVENT_REASONS[Math.floor(k / eventPods.length) % EVENT_REASONS.length]!;
      const message = text
        .replace('{ns}', pod.ns)
        .replace('{pod}', pod.name)
        .replace('{node}', pod.node)
        .replace('{image}', pod.image)
        .replace('{container}', pod.role);
      const rng = new ScaleRng(seed, TAG.event, k);
      const at = eventTime(k);
      push({
        apiVersion: 'v1',
        kind: 'Event',
        metadata: metadata(
          `${pod.name}.${hex(rng.next(), 8)}${hex(rng.next(), 8)}`,
          pod.ns,
          uid(TAG.event, k + 1),
          at,
        ),
        involvedObject: {
          apiVersion: 'v1',
          kind: 'Pod',
          namespace: pod.ns,
          name: pod.name,
          uid: uid(TAG.pod, (k % eventPods.length) + 1),
        },
        reason,
        message,
        type: 'Normal',
        count: 1,
        firstTimestamp: at,
        lastTimestamp: at,
        source: { component: 'kubelet', host: pod.node },
        reportingComponent: 'kubelet',
        reportingInstance: pod.node,
      });
    }
  }

  const out: KubeObject[] = [];
  for (const items of kinds.values()) out.push(...items.sort(byNamespaceAndName));
  return out;
}
