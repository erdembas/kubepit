import YAML from 'yaml';
import { kindKey, parseApiVersion, resolveRef } from '@/lib/kube/catalog';
import { podSpecPath, setImageChangeCause } from '@/lib/kube/images';
import type { ApplyMode, ClusterDef, ContainerImage, DryRunResult, Gvk, KubeObject } from '@/types';
import { sleep } from './bus';
import { find, getDb, list, put, type ClusterDb } from './fixtures/db';
import { apiResources } from './fixtures/discovery';
import { emitEvent } from './fixtures/events';
import { getObject } from './fixtures/ops';
import {
  CHANGE_CAUSE,
  historyOf,
  rollControllerRevision,
  rollDeployment,
  stripHash,
  undoTarget,
} from './fixtures/rollouts';
import { clone, mergePatch, nowIso } from './fixtures/util';
import { handlers, register, type MockArgs } from './registry';

/**
 * Demo implementations of the workload operations: rollout history / undo,
 * set image and the server-side dry run. Messages mirror kubepit-core so the
 * preview shows the errors users will see against a real cluster.
 */

function assertWritable(clusterId: string) {
  const clusters = (handlers.cluster_list?.({}) as ClusterDef[] | undefined) ?? [];
  const cluster = clusters.find((c) => c.id === clusterId);
  if (cluster?.read_only)
    throw new Error(`Cluster "${cluster.name}" is read-only: this change is not allowed`);
}

const ROLLOUT_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);

function rolloutObject(db: ClusterDb, gvk: Gvk, namespace: string, name: string) {
  if (gvk.group !== 'apps' || !ROLLOUT_KINDS.has(gvk.kind))
    throw new Error(
      `${gvk.kind} has no rollout history (only Deployments, StatefulSets and DaemonSets do)`,
    );
  return getObject(db, gvk, namespace, name);
}

// -- Set image ----------------------------------------------------------------

type Container = { name: string; image: string };

function podSpecOf(o: KubeObject, path: string): Record<string, unknown> {
  let cur: Record<string, unknown> = o as unknown as Record<string, unknown>;
  for (const key of path.split('.')) cur = (cur[key] ?? {}) as Record<string, unknown>;
  return cur;
}

function checkImage(image: string) {
  if (!image) throw new Error('the image must not be empty');
  if (/\s/.test(image)) throw new Error(`image "${image}" must not contain whitespace`);
  const bad = /[^A-Za-z0-9._\-/:@]/.exec(image);
  if (bad) throw new Error(`image "${image}" contains the invalid character '${bad[0]}'`);
}

function setImage(
  db: ClusterDb,
  gvk: Gvk,
  namespace: string | null,
  name: string,
  images: ContainerImage[],
) {
  const path = podSpecPath(gvk.group, gvk.kind);
  if (!path) throw new Error(`set image is not supported for ${gvk.kind}`);
  if (!images.length) throw new Error('no images to set');
  images.forEach((i) => checkImage(i.image));
  const o = getObject(db, gvk, namespace, name);
  const podSpec = podSpecOf(o, path);
  const changes = images.filter((entry) => {
    const list = (podSpec[entry.init ? 'initContainers' : 'containers'] as Container[]) ?? [];
    const current = list.find((c) => c.name === entry.container);
    if (!current)
      throw new Error(
        `cannot set image on ${gvk.kind} ${name}: ${entry.init ? 'init container' : 'container'} "${entry.container}" not found`,
      );
    return current.image !== entry.image;
  });
  if (!changes.length) throw new Error(`${gvk.kind} ${name} already runs these images`);
  if (gvk.kind === 'Job')
    throw new Error(
      `failed to set image on Job ${name}: Job.batch "${name}" is invalid: spec.template: Invalid value: core.PodTemplateSpec{…}: field is immutable`,
    );

  for (const entry of changes) {
    const list = podSpec[entry.init ? 'initContainers' : 'containers'] as Container[];
    list.find((c) => c.name === entry.container)!.image = entry.image;
  }
  if (gvk.kind === 'Pod') {
    for (const entry of changes) {
      const statuses = (o.status?.[entry.init ? 'initContainerStatuses' : 'containerStatuses'] ??
        []) as Array<{ name: string; image: string; restartCount?: number }>;
      const s = statuses.find((x) => x.name === entry.container);
      if (s) {
        s.image = entry.image;
        s.restartCount = (s.restartCount ?? 0) + 1;
      }
      emitEvent(db, {
        target: o,
        type: 'Normal',
        reason: 'Killing',
        message: `Container ${entry.container} definition changed, will be restarted`,
        firstAgo: 0,
        host: String(o.spec?.nodeName ?? ''),
      });
    }
    put(db, o);
    return o;
  }
  o.metadata.annotations = {
    ...o.metadata.annotations,
    [CHANGE_CAUSE]: setImageChangeCause(gvk.kind, name, changes),
  };
  o.metadata.generation = (o.metadata.generation ?? 1) + 1;
  if (o.kind === 'Deployment') {
    if (o.spec.paused) put(db, o);
    else rollDeployment(db, o);
  } else if (o.kind === 'StatefulSet' || o.kind === 'DaemonSet') rollControllerRevision(db, o);
  else put(db, o);
  return o;
}

// -- Undo -----------------------------------------------------------------------

function undo(db: ClusterDb, gvk: Gvk, namespace: string, name: string, revision: number) {
  const o = rolloutObject(db, gvk, namespace, name);
  if (o.kind === 'Deployment' && o.spec?.paused)
    throw new Error(`Deployment ${name} is paused; resume the rollout before rolling back`);
  let target;
  try {
    target = undoTarget(historyOf(db, o), revision);
  } catch (e) {
    throw new Error(`cannot roll back ${o.kind} ${name}: ${(e as Error).message}`);
  }
  o.spec.template = clone(target.template);
  o.metadata.annotations = { ...o.metadata.annotations };
  if (target.change_cause) o.metadata.annotations[CHANGE_CAUSE] = target.change_cause;
  else delete o.metadata.annotations[CHANGE_CAUSE];
  o.metadata.generation = (o.metadata.generation ?? 1) + 1;
  if (o.kind === 'Deployment') rollDeployment(db, o);
  else rollControllerRevision(db, o);
}

// -- Dry run --------------------------------------------------------------------

const VOLATILE = ['resourceVersion', 'generation', 'managedFields'] as const;

/** Key-order independent JSON (the server's field order is not the manifest's). */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
  );
}

function comparable(o: KubeObject) {
  const copy = clone(o);
  for (const key of VOLATILE) delete (copy.metadata as unknown as Record<string, unknown>)[key];
  return JSON.stringify(stable(copy));
}

const DNS_1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/** A few of the API server's validation rules, enough to make the review realistic. */
function validate(doc: KubeObject, gvk: Gvk): string[] {
  const problems: string[] = [];
  const name = doc.metadata?.name;
  if (name && (!DNS_1123.test(name) || name.length > 253))
    problems.push(
      `metadata.name: Invalid value: "${name}": a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character`,
    );
  const path = podSpecPath(gvk.group, gvk.kind);
  if (path) {
    const podSpec = podSpecOf(doc, path);
    const containers = (podSpec.containers as Array<Partial<Container>> | undefined) ?? [];
    if (!containers.length) problems.push(`${path}.containers: Required value`);
    containers.forEach((c, i) => {
      if (!c.name) problems.push(`${path}.containers[${i}].name: Required value`);
      if (!c.image) problems.push(`${path}.containers[${i}].image: Required value`);
    });
  }
  const replicas = doc.spec?.replicas;
  if (typeof replicas === 'number' && replicas < 0)
    problems.push(`spec.replicas: Invalid value: ${replicas}: must be greater than or equal to 0`);
  if (gvk.group === 'apps' && ROLLOUT_KINDS.has(gvk.kind)) {
    const selector = (doc.spec?.selector?.matchLabels ?? {}) as Record<string, string>;
    const labels = (doc.spec?.template?.metadata?.labels ?? {}) as Record<string, string>;
    if (Object.entries(selector).some(([k, v]) => labels[k] !== v))
      problems.push(
        'spec.template.metadata.labels: Invalid value: `selector` does not match template `labels`',
      );
  }
  return problems;
}

/** Defaults the API server fills in (a representative subset). */
function withDefaults(o: KubeObject, gvk: Gvk): KubeObject {
  const path = podSpecPath(gvk.group, gvk.kind);
  if (path) {
    const podSpec = podSpecOf(o, path);
    podSpec.restartPolicy ??= gvk.kind === 'Job' || gvk.kind === 'CronJob' ? 'Never' : 'Always';
    podSpec.dnsPolicy ??= 'ClusterFirst';
    podSpec.schedulerName ??= 'default-scheduler';
    podSpec.terminationGracePeriodSeconds ??= 30;
    podSpec.securityContext ??= {};
    for (const key of ['containers', 'initContainers'])
      for (const c of (podSpec[key] as Array<Record<string, unknown>> | undefined) ?? []) {
        const image = String(c.image ?? '');
        c.imagePullPolicy ??=
          image.endsWith(':latest') || !/:[^/]+$/.test(image) ? 'Always' : 'IfNotPresent';
        c.terminationMessagePath ??= '/dev/termination-log';
        c.terminationMessagePolicy ??= 'File';
      }
  }
  if (gvk.kind === 'Deployment') {
    o.spec.replicas ??= 1;
    o.spec.revisionHistoryLimit ??= 10;
    o.spec.progressDeadlineSeconds ??= 600;
    o.spec.strategy ??= {
      type: 'RollingUpdate',
      rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' },
    };
  }
  if (gvk.kind === 'Service' && gvk.group === '') {
    o.spec = { type: 'ClusterIP', sessionAffinity: 'None', ...o.spec };
  }
  return o;
}

function parseDocs(text: string): KubeObject[] {
  const out: KubeObject[] = [];
  YAML.parseAllDocuments(text).forEach((d, i) => {
    if (d.errors.length)
      throw new Error(`document ${i + 1} is not valid YAML: ${d.errors[0]!.message}`);
    const value = d.toJSON() as KubeObject | null;
    if (!value || typeof value !== 'object' || !Object.keys(value).length) return;
    if (value.kind === 'List' && Array.isArray(value.items))
      out.push(...(value.items as KubeObject[]));
    else out.push(value);
  });
  return out;
}

function dryRunOne(
  db: ClusterDb,
  doc: KubeObject,
  mode: ApplyMode,
  namespace: string | null,
): DryRunResult {
  const out: DryRunResult = {
    api_version: String(doc.apiVersion ?? ''),
    kind: String(doc.kind ?? ''),
    name: String(
      doc.metadata?.name ?? (doc.metadata as { generateName?: string })?.generateName ?? '',
    ),
    namespace: null,
    operation: 'create',
    live: null,
    result: null,
    error: null,
  };
  if (!doc.apiVersion) return { ...out, error: 'missing apiVersion' };
  if (!doc.kind) return { ...out, error: 'missing kind' };
  const { group } = parseApiVersion(doc.apiVersion);
  const served = apiResources(db).find((r) => r.group === group && r.kind === doc.kind);
  const gvk = served ? resolveRef(doc.apiVersion, doc.kind, [served]) : null;
  if (!gvk) return { ...out, error: `${doc.apiVersion} ${doc.kind} is not served by this cluster` };
  const meta = { ...(doc.metadata ?? {}) } as KubeObject['metadata'];
  if (served!.namespaced) meta.namespace = meta.namespace || namespace || 'default';
  else delete meta.namespace;
  doc = { ...doc, metadata: meta };
  out.namespace = meta.namespace ?? null;
  const plural = `${gvk.plural}${gvk.group ? `.${gvk.group}` : ''}`;
  const live = meta.name ? find(db, kindKey(gvk), meta.namespace ?? null, meta.name) : undefined;
  out.live = live ? clone(live) : null;
  if (mode !== 'create' && live) out.operation = 'update';
  const fail = (error: string) => ({ ...out, error });

  if (!meta.name && !(mode === 'create' && (meta as { generateName?: string }).generateName))
    return fail('missing metadata.name');
  if (mode === 'create' && live) return fail(`${plural} "${meta.name}" already exists`);
  if (mode === 'replace') {
    if (!meta.resourceVersion)
      return fail(
        'replace requires metadata.resourceVersion (reload the object and edit it again)',
      );
    if (!live) return fail(`${plural} "${meta.name}" not found`);
    if (live.metadata.resourceVersion !== meta.resourceVersion)
      return fail(
        `Operation cannot be fulfilled on ${plural} "${meta.name}": the object has been modified; please apply your changes to the latest version and try again`,
      );
  }
  const problems = validate(doc, gvk);
  if (problems.length)
    return fail(
      `${doc.kind}${gvk.group ? `.${gvk.group}` : ''} "${meta.name}" is invalid: ${problems.join(', ')}`,
    );

  const body = clone(doc);
  delete body.status;
  for (const key of ['uid', 'resourceVersion', 'generation', 'creationTimestamp', 'managedFields'])
    delete (body.metadata as unknown as Record<string, unknown>)[key];
  let result: KubeObject;
  if (live && mode === 'apply') result = mergePatch(clone(live), body) as KubeObject;
  else if (live) result = { ...body, status: clone(live.status) } as KubeObject;
  else
    result = {
      ...body,
      metadata: {
        ...body.metadata,
        name: body.metadata.name || `${(meta as { generateName?: string }).generateName}x7k2p`,
      },
    } as KubeObject;
  result.metadata = {
    ...result.metadata,
    uid: live?.metadata.uid ?? crypto.randomUUID(),
    creationTimestamp: live?.metadata.creationTimestamp ?? nowIso(),
    resourceVersion: live?.metadata.resourceVersion,
    generation: live?.metadata.generation,
  };
  // Live demo objects predate defaulting; only new objects get server defaults.
  if (!live) result = withDefaults(result, gvk);
  if (live && JSON.stringify(stable(live.spec)) !== JSON.stringify(stable(result.spec)))
    result.metadata.generation = (live.metadata.generation ?? 1) + 1;
  out.result = result;
  out.name = result.metadata.name;
  if (live) out.operation = comparable(live) === comparable(result) ? 'unchanged' : 'update';
  return out;
}

// -- Commands -----------------------------------------------------------------

register({
  rollout_history: async ({ clusterId, gvk, namespace, name }: MockArgs) => {
    await sleep(140);
    const db = getDb(clusterId);
    return structuredClone(historyOf(db, rolloutObject(db, gvk, namespace, name)));
  },
  rollout_undo: async ({ clusterId, gvk, namespace, name, revision }: MockArgs) => {
    assertWritable(clusterId);
    await sleep(220);
    undo(getDb(clusterId), gvk, namespace, name, Number(revision));
  },
  resource_set_image: async ({ clusterId, gvk, namespace, name, images }: MockArgs) => {
    assertWritable(clusterId);
    await sleep(220);
    return structuredClone(setImage(getDb(clusterId), gvk, namespace, name, images));
  },
  // Allowed on read-only clusters, like the real command.
  resource_dry_run_yaml: async ({ clusterId, yaml, mode, namespace }: MockArgs) => {
    await sleep(260);
    const db = getDb(clusterId);
    const docs = parseDocs(String(yaml));
    if (!docs.length) throw new Error('the YAML contains no objects');
    return structuredClone(docs.map((doc) => dryRunOne(db, doc, mode, namespace ?? null)));
  },
});

// A resumed Deployment rolls out a template edited while it was paused.
const patchResource = handlers.resource_patch;
if (patchResource)
  register({
    resource_patch: async (args: MockArgs) => {
      const db = getDb(args.clusterId);
      const before = find(db, kindKey(args.gvk), args.namespace, args.name);
      const wasPaused = before?.kind === 'Deployment' && before.spec?.paused === true;
      const result = (await patchResource(args)) as KubeObject;
      if (wasPaused && result.spec?.paused !== true) {
        const dep = find(db, kindKey(args.gvk), args.namespace, args.name);
        const current = list(db, 'replicasets.apps')
          .filter((rs) => rs.metadata.ownerReferences?.some((r) => r.uid === dep?.metadata.uid))
          .sort(
            (a, b) =>
              Number(b.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0) -
              Number(a.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0),
          )[0];
        if (
          dep &&
          current &&
          JSON.stringify(stripHash(current.spec.template)) !== JSON.stringify(dep.spec.template)
        )
          rollDeployment(db, dep);
      }
      return result;
    },
  });
