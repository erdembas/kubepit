import type { KubeObject } from '@/types';

/**
 * "Sync to…": turn an object read from one cluster into a manifest that can
 * be server-side applied to another cluster (or namespace).
 *
 * A live object carries two kinds of fields nobody wrote: server
 * bookkeeping (uid, resourceVersion, managed fields, status) and values the
 * *source* cluster assigned (cluster IPs, node names, bound volumes,
 * generated selectors, injected service-account token volumes, controller
 * revision annotations). Applying those elsewhere either fails (immutable or
 * conflicting values) or pins the target to the source's allocations, so
 * they are removed here; everything the user controls stays.
 *
 * Pure helper: callers pass the result through the normal dry-run review
 * before anything is applied.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

/** Metadata the API server owns. */
const META_DROP = [
  'uid',
  'resourceVersion',
  'generation',
  'creationTimestamp',
  'deletionTimestamp',
  'deletionGracePeriodSeconds',
  'selfLink',
  'managedFields',
  'generateName',
  // Owner uids exist only on the source cluster; finalizers belong to the
  // controllers that added them there.
  'ownerReferences',
  'finalizers',
] as const;

const ANNOTATIONS_DROP = [
  'kubectl.kubernetes.io/last-applied-configuration',
  'deployment.kubernetes.io/revision',
  'deprecated.daemonset.template.generation',
  'endpoints.kubernetes.io/last-change-trigger-time',
  'control-plane.alpha.kubernetes.io/leader',
  'kubernetes.io/service-account.uid',
  'pv.kubernetes.io/bind-completed',
  'pv.kubernetes.io/bound-by-controller',
  'pv.kubernetes.io/provisioned-by',
  'volume.beta.kubernetes.io/storage-provisioner',
  'volume.kubernetes.io/storage-provisioner',
  'volume.kubernetes.io/selected-node',
];

const LABELS_DROP = [
  'pod-template-hash',
  'controller-revision-hash',
  'controller-uid',
  'job-name',
  'batch.kubernetes.io/controller-uid',
  'batch.kubernetes.io/job-name',
];

/** Service spec values the cluster allocates or defaults per cluster. */
const SERVICE_SPEC_DROP = [
  'clusterIP',
  'clusterIPs',
  'healthCheckNodePort',
  'ipFamilies',
  'ipFamilyPolicy',
];

/** Tolerations the DefaultTolerationSeconds admission plugin adds to every pod. */
const DEFAULT_TOLERATION_KEYS = ['node.kubernetes.io/not-ready', 'node.kubernetes.io/unreachable'];

/** Kinds that describe one cluster's own state and are never synced. */
const CLUSTER_OWNED_KINDS = new Set([
  'Node',
  'Event',
  'Endpoints',
  'EndpointSlice',
  'Lease',
  'ControllerRevision',
  'ComponentStatus',
  'TokenReview',
  'SelfSubjectAccessReview',
  'SelfSubjectRulesReview',
  'CertificateSigningRequest',
]);

export type SyncBlocker = 'cluster-owned' | 'controlled';

/**
 * Why an object should not be synced: kinds that mirror one cluster's own
 * state, and objects a controller owns (the controller would revert or
 * delete a copy; sync the owner instead). Null when it can be synced.
 */
export function syncBlocker(obj: Pick<KubeObject, 'kind' | 'metadata'>): SyncBlocker | null {
  if (CLUSTER_OWNED_KINDS.has(obj.kind)) return 'cluster-owned';
  const owners = (obj.metadata as { ownerReferences?: Array<{ controller?: boolean }> })
    .ownerReferences;
  if (owners?.some((o) => o.controller)) return 'controlled';
  return null;
}

function dropKeys(target: JsonObject | undefined, keys: readonly string[]) {
  if (!target) return;
  for (const key of keys) delete target[key];
}

function pruneEmpty(target: JsonObject, key: string) {
  const value = target[key];
  if (isObject(value) && Object.keys(value).length === 0) delete target[key];
  if (Array.isArray(value) && value.length === 0) delete target[key];
}

function cleanLabels(meta: JsonObject | undefined) {
  if (!meta) return;
  if (isObject(meta.labels)) dropKeys(meta.labels, LABELS_DROP);
  pruneEmpty(meta, 'labels');
}

/** Values the scheduler and admission plugins fill into a Pod's spec. */
function cleanPodSpec(spec: JsonObject) {
  delete spec.nodeName;
  // `priority` is resolved from priorityClassName by admission.
  delete spec.priority;
  if (Array.isArray(spec.volumes)) {
    const injected = new Set<string>();
    spec.volumes = spec.volumes.filter((v) => {
      const name = isObject(v) && typeof v.name === 'string' ? v.name : '';
      const isToken = /^kube-api-access-/.test(name) || /^default-token-/.test(name);
      if (isToken) injected.add(name);
      return !isToken;
    });
    for (const key of ['containers', 'initContainers', 'ephemeralContainers']) {
      const list = spec[key];
      if (!Array.isArray(list)) continue;
      for (const c of list) {
        if (!isObject(c) || !Array.isArray(c.volumeMounts)) continue;
        c.volumeMounts = c.volumeMounts.filter(
          (m) => !(isObject(m) && typeof m.name === 'string' && injected.has(m.name)),
        );
        pruneEmpty(c, 'volumeMounts');
      }
    }
    pruneEmpty(spec, 'volumes');
  }
  if (Array.isArray(spec.tolerations)) {
    spec.tolerations = spec.tolerations.filter(
      (t) =>
        !(
          isObject(t) &&
          typeof t.key === 'string' &&
          DEFAULT_TOLERATION_KEYS.includes(t.key) &&
          t.effect === 'NoExecute' &&
          t.tolerationSeconds === 300
        ),
    );
    pruneEmpty(spec, 'tolerations');
  }
}

function cleanTemplate(spec: JsonObject) {
  const template = spec.template;
  if (!isObject(template)) return;
  if (isObject(template.metadata)) {
    cleanLabels(template.metadata);
    dropKeys(template.metadata, ['creationTimestamp']);
    pruneEmpty(template, 'metadata');
  }
}

/**
 * A copy of `obj` that can be applied to another cluster (see module
 * docs). With `keepNamespace: false` the namespace is removed so the
 * apply's target namespace fills it in.
 */
export function toSyncManifest(
  obj: KubeObject | Record<string, unknown>,
  { keepNamespace = false }: { keepNamespace?: boolean } = {},
): JsonObject {
  const copy = clone(obj) as unknown as JsonObject;
  delete copy.status;
  const meta = isObject(copy.metadata) ? copy.metadata : {};
  dropKeys(meta, META_DROP);
  if (!keepNamespace) delete meta.namespace;
  if (isObject(meta.annotations)) dropKeys(meta.annotations, ANNOTATIONS_DROP);
  pruneEmpty(meta, 'annotations');
  cleanLabels(meta);

  const kind = typeof copy.kind === 'string' ? copy.kind : '';
  const spec = isObject(copy.spec) ? copy.spec : null;
  if (kind === 'Namespace') {
    if (isObject(meta.labels)) delete meta.labels['kubernetes.io/metadata.name'];
    pruneEmpty(meta, 'labels');
    // `spec.finalizers: [kubernetes]` is the server default.
    delete copy.spec;
  } else if (kind === 'Service' && spec) {
    dropKeys(spec, SERVICE_SPEC_DROP);
    // Node ports are allocated unless the Service is a NodePort one (then
    // they are usually chosen on purpose).
    if (spec.type !== 'NodePort' && Array.isArray(spec.ports)) {
      for (const port of spec.ports) if (isObject(port)) delete port.nodePort;
    }
  } else if (kind === 'Pod' && spec) {
    cleanPodSpec(spec);
  } else if (kind === 'PersistentVolumeClaim' && spec) {
    delete spec.volumeName;
  } else if (kind === 'PersistentVolume' && spec) {
    delete spec.claimRef;
  } else if (kind === 'ServiceAccount') {
    // Token secret references are generated per cluster.
    delete copy.secrets;
  } else if (kind === 'Secret' && copy.type === 'kubernetes.io/service-account-token') {
    // The target's token controller fills in its own token.
    delete copy.data;
  } else if (kind === 'Job' && spec) {
    // The selector is generated from the Job's uid unless set manually.
    if (spec.manualSelector !== true) delete spec.selector;
  }
  if (spec && kind !== 'Namespace') cleanTemplate(spec);
  if (kind === 'CronJob' && spec && isObject(spec.jobTemplate)) {
    const jobSpec = spec.jobTemplate.spec;
    if (isObject(jobSpec)) cleanTemplate(jobSpec);
  }

  const out: JsonObject = {};
  for (const key of ['apiVersion', 'kind', 'metadata']) if (key in copy) out[key] = copy[key]!;
  out.metadata = meta;
  for (const key of Object.keys(copy)) if (!(key in out)) out[key] = copy[key]!;
  return out;
}
