import { BUILTIN_KINDS, apiVersionOf } from '@/lib/kube/catalog';
import type { ApiResourceInfo, MetricsResult, NodeMetric, PodMetric } from '@/types';
import { list, type ClusterDb } from './db';
import { crdsFor } from './crds';
import { hashString } from './util';

/** `api_resources` and metrics.k8s.io for the demo clusters. */

const ALL_VERBS = [
  'create',
  'delete',
  'deletecollection',
  'get',
  'list',
  'patch',
  'update',
  'watch',
];

const EXTRA: Array<[string, string, string, string, boolean, string[]]> = [
  ['', 'v1', 'PodTemplate', 'podtemplates', true, []],
  ['', 'v1', 'ComponentStatus', 'componentstatuses', false, ['cs']],
  ['apps', 'v1', 'ControllerRevision', 'controllerrevisions', true, []],
  ['storage.k8s.io', 'v1', 'CSIDriver', 'csidrivers', false, []],
  ['storage.k8s.io', 'v1', 'CSINode', 'csinodes', false, []],
  ['storage.k8s.io', 'v1', 'VolumeAttachment', 'volumeattachments', false, []],
  [
    'certificates.k8s.io',
    'v1',
    'CertificateSigningRequest',
    'certificatesigningrequests',
    false,
    ['csr'],
  ],
  ['events.k8s.io', 'v1', 'Event', 'events', true, ['ev']],
  ['flowcontrol.apiserver.k8s.io', 'v1', 'FlowSchema', 'flowschemas', false, []],
  ['apiregistration.k8s.io', 'v1', 'APIService', 'apiservices', false, []],
];

export function apiResources(db: ClusterDb): ApiResourceInfo[] {
  const out: ApiResourceInfo[] = BUILTIN_KINDS.map((k) => ({
    group: k.group,
    version: k.version,
    kind: k.kind,
    plural: k.plural,
    namespaced: k.namespaced,
    api_version: apiVersionOf(k),
    verbs:
      k.kind === 'Event'
        ? ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch']
        : ALL_VERBS,
    short_names: k.shortNames,
    categories: [
      'Pod',
      'Deployment',
      'DaemonSet',
      'StatefulSet',
      'ReplicaSet',
      'Job',
      'CronJob',
      'Service',
      'ReplicationController',
    ].includes(k.kind)
      ? ['all']
      : [],
  }));
  for (const [group, version, kind, plural, namespaced, shortNames] of EXTRA) {
    out.push({
      group,
      version,
      kind,
      plural,
      namespaced,
      api_version: group ? `${group}/${version}` : version,
      verbs: ALL_VERBS,
      short_names: shortNames,
      categories: [],
    });
  }
  if (db.profile.metrics) {
    for (const [kind, plural, namespaced] of [
      ['NodeMetrics', 'nodes', false],
      ['PodMetrics', 'pods', true],
    ] as const)
      out.push({
        group: 'metrics.k8s.io',
        version: 'v1beta1',
        kind,
        plural,
        namespaced,
        api_version: 'metrics.k8s.io/v1beta1',
        verbs: ['get', 'list'],
        short_names: [],
        categories: [],
      });
  }
  for (const c of crdsFor(db)) {
    const version = c.versions[c.versions.length - 1]!;
    out.push({
      group: c.group,
      version,
      kind: c.kind,
      plural: c.plural,
      namespaced: c.scope === 'Namespaced',
      api_version: `${c.group}/${version}`,
      verbs: ALL_VERBS,
      short_names: c.shortNames ?? [],
      categories: c.categories ?? [],
    });
  }
  return out;
}

type Res = { requests?: Record<string, string>; limits?: Record<string, string> };

function cpu(v: string | undefined) {
  if (!v) return 0;
  return v.endsWith('m') ? Number(v.slice(0, -1)) : Number(v) * 1000;
}

function mem(v: string | undefined) {
  if (!v) return 0;
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi)?$/.exec(v);
  if (!m) return 0;
  const mult = m[2] === 'Gi' ? 1024 ** 3 : m[2] === 'Mi' ? 1024 ** 2 : m[2] === 'Ki' ? 1024 : 1;
  return Number(m[1]) * mult;
}

/** Deterministic-ish usage: each container hovers around a stable share of its request. */
function usage(seed: string, res: Res | undefined, tick: number) {
  const h = hashString(seed);
  const wobble = Math.sin(tick / 3 + (h % 17)) * 0.08;
  const shareCpu = 0.15 + (h % 70) / 100 + wobble;
  const shareMem = 0.35 + ((h >>> 7) % 55) / 100 + wobble / 2;
  const reqCpu = cpu(res?.requests?.cpu) || 50;
  const reqMem = mem(res?.requests?.memory) || 64 * 1024 ** 2;
  return {
    cpu_millicores: Math.max(1, Math.round(reqCpu * shareCpu)),
    memory_bytes: Math.round(reqMem * shareMem),
  };
}

export function podMetrics(db: ClusterDb, namespace: string | null): MetricsResult<PodMetric> {
  if (!db.profile.metrics) return { available: false, items: [] };
  const tick = Math.floor(Date.now() / 15_000);
  const items: PodMetric[] = [];
  for (const pod of list(db, 'pods')) {
    if (namespace && pod.metadata.namespace !== namespace) continue;
    if (pod.status?.phase !== 'Running') continue;
    const containers = (
      (pod.spec?.containers as Array<{ name: string; resources?: Res }>) ?? []
    ).map((c) => ({
      name: c.name,
      ...usage(`${pod.metadata.name}/${c.name}`, c.resources, tick),
    }));
    items.push({
      namespace: pod.metadata.namespace ?? '',
      name: pod.metadata.name,
      cpu_millicores: containers.reduce((s, c) => s + c.cpu_millicores, 0),
      memory_bytes: containers.reduce((s, c) => s + c.memory_bytes, 0),
      containers,
    });
  }
  return { available: true, items };
}

export function nodeMetrics(db: ClusterDb): MetricsResult<NodeMetric> {
  if (!db.profile.metrics) return { available: false, items: [] };
  const pods = podMetrics(db, null).items;
  const byPod = new Map(pods.map((p) => [`${p.namespace}/${p.name}`, p]));
  const items: NodeMetric[] = [];
  for (const node of list(db, 'nodes')) {
    const ready = (
      node.status?.conditions as Array<{ type: string; status: string }> | undefined
    )?.some((c) => c.type === 'Ready' && c.status === 'True');
    if (!ready) continue;
    let c = 180;
    let m = 900 * 1024 ** 2;
    for (const pod of list(db, 'pods')) {
      if (pod.spec?.nodeName !== node.metadata.name) continue;
      const pm = byPod.get(`${pod.metadata.namespace}/${pod.metadata.name}`);
      if (pm) {
        c += pm.cpu_millicores;
        m += pm.memory_bytes;
      }
    }
    items.push({ name: node.metadata.name, cpu_millicores: c, memory_bytes: m });
  }
  return { available: true, items };
}
