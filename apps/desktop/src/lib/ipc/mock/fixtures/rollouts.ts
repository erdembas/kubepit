import type { ContainerImage, KubeObject, RolloutRevision } from '@/types';
import { currentReplicaSet } from './controllers';
import { list, ownedBy, put, type ClusterDb } from './db';
import { emitEvent } from './events';
import { reconcile, spawnPod, terminatePod } from './lifecycle';
import type { PodTemplate } from './pods';
import { between, DAY, hexId, HOUR, iso, meta, obj, pick, seeded, type Rand } from './util';

/**
 * Rollout history for the demo backend: seeded revisions with realistic
 * image bumps and change-causes, the history listing the real backend
 * builds (`rollout.rs`), and the controller behaviour behind set image and
 * undo (new or reused ReplicaSet / ControllerRevision, pods replaced).
 */

export const REVISION = 'deployment.kubernetes.io/revision';
export const CHANGE_CAUSE = 'kubernetes.io/change-cause';
const HASH = 'pod-template-hash';
const CR_HASH = 'controller-revision-hash';

type Json = Record<string, unknown>;
type Container = { name: string; image: string; env?: unknown[]; resources?: Json };

const alive = (p: KubeObject) => !p.metadata.deletionTimestamp;

function containers(template: PodTemplate, init = false): Container[] {
  return ((init ? template.spec.initContainers : template.spec.containers) as Container[]) ?? [];
}

export function stripHash(template: unknown, label = HASH): PodTemplate {
  const t = structuredClone(template ?? {}) as PodTemplate & { $patch?: string };
  delete t.$patch;
  if (t.metadata?.labels) {
    const { [label]: _dropped, ...labels } = t.metadata.labels;
    t.metadata = { ...t.metadata, labels };
  }
  return t;
}

const sameTemplate = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// -- Seeding ------------------------------------------------------------------

/** `2.14.3` → `2.14.2`, `v1.32.0` → `v1.31.4`; `null` when the tag is not a version. */
function olderTag(tag: string, rand: Rand): string | null {
  const m = /^(v?)(\d+)\.(\d+)(?:\.(\d+))?(.*)$/.exec(tag);
  if (!m) return null;
  const [, v, major, minor, patch, rest] = m;
  let [a, b, c] = [Number(major), Number(minor), patch === undefined ? null : Number(patch)];
  if (c !== null && c > 0) c -= 1;
  else if (b > 0) {
    b -= 1;
    if (c !== null) c = between(rand, 2, 7);
  } else if (a > 0) {
    a -= 1;
    b = between(rand, 4, 12);
  } else return null;
  return `${v}${a}.${b}${c === null ? '' : `.${c}`}${rest}`;
}

function withTag(image: string, tag: string) {
  const colon = image.lastIndexOf(':');
  return colon > image.lastIndexOf('/') ? `${image.slice(0, colon)}:${tag}` : `${image}:${tag}`;
}

function tagOf(image: string) {
  const colon = image.lastIndexOf(':');
  return colon > image.lastIndexOf('/') ? image.slice(colon + 1) : '';
}

function repoOf(image: string) {
  const colon = image.lastIndexOf(':');
  return colon > image.lastIndexOf('/') ? image.slice(0, colon) : image;
}

const CI = ['ci', 'github-actions', 'argocd', 'flux'] as const;

/**
 * One step back in history: returns the older template and the change-cause
 * of the step that led from it to `template`.
 */
function previous(
  kind: string,
  name: string,
  template: PodTemplate,
  rand: Rand,
): { template: PodTemplate; cause: string | null } {
  const older = structuredClone(template);
  const main = containers(older);
  const roll = rand();
  const sidecar = main[1];
  const target = roll < 0.18 && sidecar ? sidecar : main[0];
  const tag = target ? olderTag(tagOf(target.image), rand) : null;
  if (target && tag && roll < 0.82) {
    const repo = repoOf(target.image);
    const newer = target.image;
    for (const c of [...containers(older), ...containers(older, true)])
      if (repoOf(c.image) === repo) c.image = withTag(c.image, tag);
    const who = pick(rand, CI);
    const cause =
      who === 'argocd'
        ? `argocd: sync to ${hexId(rand, 7)} (${repo.split('/').pop()} ${tagOf(newer)})`
        : who === 'flux'
          ? null
          : rand() < 0.5
            ? `kubectl set image ${kind.toLowerCase()}/${name} ${target.name}=${newer}`
            : `${who}: deploy ${tagOf(newer)} (build #${between(rand, 1200, 9800)})`;
    return { template: older, cause };
  }
  // A configuration change: the newer revision toggled a log level override.
  const first = main[0];
  if (first) {
    const env = (first.env ?? []) as Array<{ name: string }>;
    first.env = env.some((e) => e.name === 'LOG_LEVEL')
      ? env.filter((e) => e.name !== 'LOG_LEVEL')
      : [...env, { name: 'LOG_LEVEL', value: 'debug' }];
    if (!first.env.length) delete first.env;
    return { template: older, cause: `kubectl edit ${kind.toLowerCase()}/${name}` };
  }
  return { template: older, cause: null };
}

function setCause(o: KubeObject, cause: string | null) {
  const annotations = { ...o.metadata.annotations };
  if (cause) annotations[CHANGE_CAUSE] = cause;
  else delete annotations[CHANGE_CAUSE];
  o.metadata.annotations = annotations;
}

function withHashLabel(template: PodTemplate, label: string, hash: string): PodTemplate {
  return {
    ...template,
    metadata: { ...template.metadata, labels: { ...template.metadata.labels, [label]: hash } },
  };
}

/** Older ReplicaSets get the templates that led up to the current one. */
function seedDeployment(db: ClusterDb, dep: KubeObject, rand: Rand) {
  const revision = (rs: KubeObject) => Number(rs.metadata.annotations?.[REVISION] ?? 0);
  const sets = ownedBy(db, 'replicasets.apps', dep).sort((a, b) => revision(b) - revision(a));
  const causes: Array<string | null> = sets.map(() => null);
  let template = stripHash(dep.spec.template);
  for (let i = 1; i < sets.length; i++) {
    const step = previous(dep.kind, dep.metadata.name, template, rand);
    causes[i - 1] = step.cause;
    template = step.template;
    const rs = sets[i]!;
    rs.spec.template = withHashLabel(template, HASH, rs.metadata.labels?.[HASH] ?? '');
  }
  sets.forEach((rs, i) => {
    setCause(rs, causes[i] ?? null);
    put(db, rs);
  });
  setCause(dep, causes[0] ?? null);
  put(db, dep);
}

/** 1–4 ControllerRevisions per StatefulSet / DaemonSet, spread over its age. */
function seedControllerRevisions(db: ClusterDb, o: KubeObject, rand: Rand) {
  const count = between(rand, 1, 4);
  const created = Date.parse(o.metadata.creationTimestamp ?? iso(Date.now() - 30 * DAY));
  const span = Math.max(HOUR, Date.now() - created);
  const steps: Array<{ template: PodTemplate; cause: string | null }> = [
    { template: stripHash(o.spec.template, CR_HASH), cause: null },
  ];
  for (let i = 1; i < count; i++) {
    const step = previous(o.kind, o.metadata.name, steps[i - 1]!.template, rand);
    steps[i - 1]!.cause = step.cause;
    steps.push({ template: step.template, cause: null });
  }
  const names: string[] = [];
  steps.forEach((step, i) => {
    const age = Math.round(((i + 0.5) / (count + 0.5)) * span);
    const cr = controllerRevision(o, step.template, count - i, step.cause, age, rand);
    put(db, cr);
    names.push(cr.metadata.name);
  });
  setCause(o, steps[0]!.cause);
  if (o.kind === 'StatefulSet')
    o.status = { ...o.status, currentRevision: names[0], updateRevision: names[0] };
  put(db, o);
}

function controllerRevision(
  owner: KubeObject,
  template: PodTemplate,
  revision: number,
  cause: string | null,
  age: number,
  rand: Rand,
): KubeObject {
  const hash = hexId(rand, 10);
  return obj(
    'apps/v1',
    'ControllerRevision',
    meta({
      name: `${owner.metadata.name}-${hash}`,
      namespace: owner.metadata.namespace,
      age,
      labels: { ...template.metadata.labels, [CR_HASH]: hash },
      annotations: cause ? { [CHANGE_CAUSE]: cause } : {},
      owner,
    }),
    { revision, data: { spec: { template: { ...structuredClone(template), $patch: 'replace' } } } },
  );
}

/** Post-build pass: realistic history for every Deployment, StatefulSet and DaemonSet. */
export function buildRolloutHistory(db: ClusterDb) {
  const rand = seeded(`${db.id}:rollouts`);
  for (const dep of list(db, 'deployments.apps')) seedDeployment(db, dep, rand);
  for (const o of [...list(db, 'statefulsets.apps'), ...list(db, 'daemonsets.apps')])
    seedControllerRevisions(db, o, rand);
}

// -- History ------------------------------------------------------------------

function images(template: PodTemplate): ContainerImage[] {
  return [
    ...containers(template).map((c) => ({ container: c.name, image: c.image, init: false })),
    ...containers(template, true).map((c) => ({ container: c.name, image: c.image, init: true })),
  ];
}

function entry(o: KubeObject, revision: number, template: PodTemplate): RolloutRevision {
  return {
    revision,
    name: o.metadata.name,
    created: o.metadata.creationTimestamp ?? null,
    change_cause: o.metadata.annotations?.[CHANGE_CAUSE] || null,
    images: images(template),
    template: template as unknown as Record<string, unknown>,
    replicas: null,
    ready_replicas: null,
    current: false,
  };
}

/** Same result shape and rules as `rollout_history` in kubepit-core. */
export function historyOf(db: ClusterDb, o: KubeObject): RolloutRevision[] {
  let out: RolloutRevision[];
  let isCurrent: (r: RolloutRevision) => boolean;
  if (o.kind === 'Deployment') {
    const current = Number(o.metadata.annotations?.[REVISION] ?? NaN);
    out = ownedBy(db, 'replicasets.apps', o)
      .filter((rs) => rs.metadata.annotations?.[REVISION] !== undefined)
      .map((rs) => ({
        ...entry(rs, Number(rs.metadata.annotations![REVISION]), stripHash(rs.spec.template)),
        replicas: Number(rs.status?.replicas ?? 0),
        ready_replicas: Number(rs.status?.readyReplicas ?? 0),
      }));
    isCurrent = (r) => r.revision === current;
  } else {
    out = ownedBy(db, 'controllerrevisions.apps', o).map((cr) =>
      entry(
        cr,
        Number(cr.revision),
        stripHash((cr.data as { spec?: { template?: unknown } })?.spec?.template, CR_HASH),
      ),
    );
    const update = o.status?.updateRevision as string | undefined;
    const live = stripHash(o.spec.template, CR_HASH);
    isCurrent = out.some((r) => r.name === update)
      ? (r) => r.name === update
      : (r) => sameTemplate(r.template, live);
  }
  out.sort((a, b) => b.revision - a.revision);
  const index = out.findIndex(isCurrent);
  if (out.length) out[index >= 0 ? index : 0]!.current = true;
  return out;
}

/** `rollout_undo` target selection (`0` = previous), with the backend's messages. */
export function undoTarget(history: RolloutRevision[], revision: number): RolloutRevision {
  const current = history.find((r) => r.current);
  const target =
    revision === 0
      ? history.find((r) => !r.current && (!current || r.revision < current.revision))
      : history.find((r) => r.revision === revision);
  if (!target)
    throw new Error(
      revision === 0
        ? 'there is no previous revision to roll back to'
        : `revision ${revision} not found in the rollout history`,
    );
  if (target.current)
    throw new Error(`revision ${target.revision} is already the current revision`);
  if (current && sameTemplate(current.template, target.template))
    throw new Error(`the current pod template already matches revision ${target.revision}`);
  return target;
}

// -- Controllers ----------------------------------------------------------------

/**
 * The Deployment controller after a template change: reuse the ReplicaSet
 * with an identical template (rollbacks) or create one, give it the next
 * revision, scale it up and the previous one down.
 */
export function rollDeployment(db: ClusterDb, dep: KubeObject) {
  const revision = (rs: KubeObject) => Number(rs.metadata.annotations?.[REVISION] ?? 0);
  const sets = ownedBy(db, 'replicasets.apps', dep);
  const old = currentReplicaSet(db, dep);
  const next = Math.max(0, ...sets.map(revision)) + 1;
  const cause = dep.metadata.annotations?.[CHANGE_CAUSE] ?? null;
  const replicas = Number(dep.spec.replicas ?? 1);
  let rs = sets.find((s) => sameTemplate(stripHash(s.spec.template), dep.spec.template));
  if (rs) {
    rs.metadata.annotations = { ...rs.metadata.annotations, [REVISION]: String(next) };
    setCause(rs, cause);
    rs.spec = { ...rs.spec, replicas };
    put(db, rs);
  } else {
    const hash = hexId(db.rand, 10);
    const template = structuredClone(dep.spec.template) as PodTemplate;
    template.metadata = {
      ...template.metadata,
      labels: { ...template.metadata.labels, [HASH]: hash },
    };
    rs = put(db, {
      apiVersion: 'apps/v1',
      kind: 'ReplicaSet',
      metadata: {
        name: `${dep.metadata.name}-${hash}`,
        namespace: dep.metadata.namespace,
        uid: '',
        creationTimestamp: iso(Date.now()),
        labels: template.metadata.labels,
        annotations: {
          [REVISION]: String(next),
          'deployment.kubernetes.io/desired-replicas': String(replicas),
          ...(cause ? { [CHANGE_CAUSE]: cause } : {}),
        },
        ownerReferences: [
          {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            name: dep.metadata.name,
            uid: dep.metadata.uid,
            controller: true,
          },
        ],
      },
      spec: {
        replicas,
        selector: { matchLabels: { ...dep.spec.selector?.matchLabels, [HASH]: hash } },
        template,
      },
      status: {},
    });
  }
  dep.metadata.annotations = { ...dep.metadata.annotations, [REVISION]: String(next) };
  put(db, dep);
  const target = rs;
  emitEvent(db, {
    target: dep,
    type: 'Normal',
    reason: 'ScalingReplicaSet',
    message: `Scaled up replica set ${target.metadata.name} from ${target.status?.replicas ?? 0} to ${replicas}`,
    firstAgo: 0,
    component: 'deployment-controller',
  });
  reconcile(db, target);
  if (!old || old.metadata.uid === target.metadata.uid) return;
  window.setTimeout(() => {
    if (!list(db, 'replicasets.apps').some((s) => s.metadata.uid === old.metadata.uid)) return;
    const from = Number(old.status?.replicas ?? 0);
    old.spec = { ...old.spec, replicas: 0 };
    put(db, old);
    reconcile(db, old);
    emitEvent(db, {
      target: dep,
      type: 'Normal',
      reason: 'ScalingReplicaSet',
      message: `Scaled down replica set ${old.metadata.name} from ${from} to 0`,
      firstAgo: 0,
      component: 'deployment-controller',
    });
  }, 3200);
}

/**
 * The StatefulSet / DaemonSet controller after a template change: record
 * (or reuse) a ControllerRevision, then replace the pods one by one.
 */
export function rollControllerRevision(db: ClusterDb, o: KubeObject) {
  const revisions = ownedBy(db, 'controllerrevisions.apps', o);
  const next = Math.max(0, ...revisions.map((r) => Number(r.revision))) + 1;
  const cause = o.metadata.annotations?.[CHANGE_CAUSE] ?? null;
  const live = stripHash(o.spec.template, CR_HASH);
  let cr = revisions.find((r) =>
    sameTemplate(
      stripHash((r.data as { spec: { template: unknown } }).spec.template, CR_HASH),
      live,
    ),
  );
  if (cr) {
    cr.revision = next;
    put(db, cr);
  } else {
    cr = put(db, controllerRevision(o, live, next, cause, 0, db.rand));
  }
  if (o.kind === 'StatefulSet')
    o.status = { ...o.status, currentRevision: cr.metadata.name, updateRevision: cr.metadata.name };
  put(db, o);
  const pods = ownedBy(db, 'pods', o).filter(alive);
  pods.forEach((pod, i) => {
    window.setTimeout(() => {
      if (!list(db, 'pods').some((p) => p.metadata.uid === pod.metadata.uid)) return;
      terminatePod(db, pod, () => {
        if (
          !list(db, o.kind === 'StatefulSet' ? 'statefulsets.apps' : 'daemonsets.apps').some(
            (x) => x.metadata.uid === o.metadata.uid,
          )
        )
          return;
        spawnPod(db, o, o.spec.template, {
          namespace: o.metadata.namespace!,
          ...(o.kind === 'StatefulSet'
            ? { name: pod.metadata.name }
            : { node: String(pod.spec?.nodeName ?? '') || undefined }),
        });
      });
    }, i * 3500);
  });
}
