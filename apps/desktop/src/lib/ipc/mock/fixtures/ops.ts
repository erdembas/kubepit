import YAML from 'yaml';
import * as i18n from '@/i18n/core';
import { kindKey, resolveRef } from '@/lib/kube/catalog';
import type { ApplyMode, Gvk, KubeObject, PatchType } from '@/types';
import { syncOwner } from './controllers';
import { drop, find, helmDetail, helmKey, list, put, type ClusterDb } from './db';
import { emitEvent } from './events';
import { helmSecrets, syncHelmSecrets } from './helm';
import {
  deleteCascade,
  ownerOf,
  reconcile,
  rolloutRestart,
  runJob,
  spawnPod,
  terminatePod,
} from './lifecycle';
import type { PodTemplate } from './pods';
import { clone, mergePatch, nowIso, suffix } from './util';

/** Mutating demo commands. Each mirrors what the real controller would do. */

function notFound(gvk: Gvk, name: string): never {
  throw new Error(`${gvk.plural}${gvk.group ? `.${gvk.group}` : ''} "${name}" not found`);
}

export function getObject(db: ClusterDb, gvk: Gvk, namespace: string | null, name: string) {
  const o = find(db, kindKey(gvk), gvk.namespaced ? namespace : null, name);
  if (!o) notFound(gvk, name);
  return o;
}

export function deleteObject(db: ClusterDb, gvk: Gvk, namespace: string | null, name: string) {
  const o = getObject(db, gvk, namespace, name);
  switch (o.kind) {
    case 'Pod': {
      const owner = ownerOf(db, o);
      terminatePod(
        db,
        o,
        () => owner && owner.kind !== 'Job' && owner.kind !== 'Node' && reconcile(db, owner),
      );
      return;
    }
    case 'Namespace': {
      o.metadata.deletionTimestamp = nowIso();
      o.status = { ...o.status, phase: 'Terminating' };
      put(db, o);
      window.setTimeout(() => {
        for (const table of db.kinds.values())
          for (const child of [...table.values()])
            if (child.metadata.namespace === o.metadata.name) drop(db, child);
        drop(db, o);
      }, 2500);
      return;
    }
    case 'CronJob':
      for (const job of list(db, 'jobs.batch').filter(
        (j) => j.metadata.ownerReferences?.[0]?.uid === o.metadata.uid,
      ))
        deleteCascade(db, job);
      drop(db, o);
      return;
    default:
      deleteCascade(db, o);
  }
}

export function scaleObject(
  db: ClusterDb,
  gvk: Gvk,
  namespace: string,
  name: string,
  replicas: number,
) {
  const o = getObject(db, gvk, namespace, name);
  if (!['Deployment', 'StatefulSet', 'ReplicaSet', 'ReplicationController'].includes(o.kind))
    throw new Error(`${o.kind} does not support the scale subresource`);
  const from = Number(o.spec?.replicas ?? 1);
  o.spec = { ...o.spec, replicas };
  put(db, o);
  if (o.kind === 'Deployment')
    emitEvent(db, {
      target: o,
      type: 'Normal',
      reason: 'ScalingReplicaSet',
      message: `Scaled ${replicas > from ? 'up' : 'down'} replica set ${o.metadata.name} from ${from} to ${replicas}`,
      firstAgo: 0,
      component: 'deployment-controller',
    });
  reconcile(db, o);
}

export function restartObject(db: ClusterDb, gvk: Gvk, namespace: string, name: string) {
  const o = getObject(db, gvk, namespace, name);
  if (!['Deployment', 'StatefulSet', 'DaemonSet'].includes(o.kind))
    throw new Error(`rollout restart is not supported for ${o.kind}`);
  rolloutRestart(db, o);
}

function jsonPatch(target: unknown, ops: Array<{ op: string; path: string; value?: unknown }>) {
  const doc = clone(target) as Record<string, unknown>;
  for (const op of ops) {
    const parts = op.path
      .split('/')
      .slice(1)
      .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    const last = parts.pop();
    let cur: Record<string, unknown> | unknown[] = doc;
    for (const part of parts) {
      const next: unknown = Array.isArray(cur) ? cur[Number(part)] : cur[part];
      if (typeof next !== 'object' || next === null) {
        if (op.op === 'remove') break;
        const created = {};
        if (Array.isArray(cur)) cur[Number(part)] = created;
        else cur[part] = created;
        cur = created;
      } else cur = next as Record<string, unknown>;
    }
    if (last === undefined) continue;
    if (Array.isArray(cur)) {
      const idx = last === '-' ? cur.length : Number(last);
      if (op.op === 'remove') cur.splice(idx, 1);
      else if (op.op === 'add') cur.splice(idx, 0, op.value);
      else cur[idx] = op.value;
    } else if (op.op === 'remove') delete cur[last];
    else cur[last] = op.value;
  }
  return doc;
}

export function patchObject(
  db: ClusterDb,
  gvk: Gvk,
  namespace: string | null,
  name: string,
  patch: unknown,
  type: PatchType,
) {
  const o = getObject(db, gvk, namespace, name);
  const before = JSON.stringify(o.spec);
  const next = (
    type === 'json'
      ? jsonPatch(o, patch as Array<{ op: string; path: string; value?: unknown }>)
      : mergePatch(o, patch)
  ) as KubeObject;
  // The API server enforces UID immutability and resourceVersion preconditions.
  // Check before touching the demo store, including through merge patches.
  if (
    next.metadata?.uid !== o.metadata.uid ||
    next.metadata?.resourceVersion !== o.metadata.resourceVersion
  )
    throw new Error(
      i18n.t('The resource changed or was replaced. Refresh before applying the patch.'),
    );
  const restarted =
    next.spec?.template?.metadata?.annotations?.['kubectl.kubernetes.io/restartedAt'];
  const previousRestart =
    o.spec?.template?.metadata?.annotations?.['kubectl.kubernetes.io/restartedAt'];
  next.metadata = {
    ...next.metadata,
    uid: o.metadata.uid,
    name: o.metadata.name,
    namespace: o.metadata.namespace,
  };
  if (JSON.stringify(next.spec) !== before)
    next.metadata.generation = (o.metadata.generation ?? 1) + 1;
  const table = db.kinds.get(kindKey(gvk));
  table?.delete(o.metadata.uid);
  put(db, next);
  if (
    restarted &&
    restarted !== previousRestart &&
    ['Deployment', 'StatefulSet', 'DaemonSet'].includes(next.kind) &&
    next.spec?.paused !== true &&
    next.spec?.updateStrategy?.type !== 'OnDelete'
  )
    rolloutRestart(db, next);
  if (next.spec?.replicas !== o.spec?.replicas) reconcile(db, next);
  if (o.kind === 'Node' && next.spec?.unschedulable !== o.spec?.unschedulable)
    cordonNode(db, next.metadata.name, !!next.spec?.unschedulable);
  return next;
}

export function cordonNode(db: ClusterDb, name: string, unschedulable: boolean) {
  const node = find(db, 'nodes', null, name);
  if (!node) throw new Error(`nodes "${name}" not found`);
  const taints = ((node.spec?.taints as Array<{ key: string }> | undefined) ?? []).filter(
    (t) => t.key !== 'node.kubernetes.io/unschedulable',
  );
  if (unschedulable)
    taints.push({
      key: 'node.kubernetes.io/unschedulable',
      effect: 'NoSchedule',
      timeAdded: nowIso(),
    } as { key: string });
  node.spec = {
    ...node.spec,
    unschedulable: unschedulable || undefined,
    taints: taints.length ? taints : undefined,
  };
  put(db, node);
  emitEvent(db, {
    target: node,
    type: 'Normal',
    reason: unschedulable ? 'NodeNotSchedulable' : 'NodeSchedulable',
    message: `Node ${name} status is now: ${unschedulable ? 'NodeNotSchedulable' : 'NodeSchedulable'}`,
    firstAgo: 0,
    component: 'kubelet',
    host: name,
  });
}

export function drainNode(db: ClusterDb, name: string) {
  cordonNode(db, name, true);
  const pods = list(db, 'pods').filter(
    (p) => p.spec?.nodeName === name && !p.metadata.deletionTimestamp,
  );
  let delay = 0;
  for (const pod of pods) {
    const owner = ownerOf(db, pod);
    if (owner?.kind === 'DaemonSet' || owner?.kind === 'Node') continue;
    delay += 250;
    window.setTimeout(() => {
      emitEvent(db, {
        target: pod,
        type: 'Normal',
        reason: 'Evicted',
        message: `Evicted pod ${pod.metadata.name} from node ${name}`,
        firstAgo: 0,
        component: 'kubectl-drain',
      });
      terminatePod(db, pod, () => owner && owner.kind !== 'Job' && reconcile(db, owner));
    }, delay);
  }
}

export function triggerCronJob(db: ClusterDb, namespace: string, name: string) {
  const cj = find(db, 'cronjobs.batch', namespace, name);
  if (!cj) throw new Error(`cronjobs.batch "${name}" not found`);
  return runJob(db, cj, `${name}-manual-${suffix(db.rand)}`).metadata.name;
}

// -- Apply --------------------------------------------------------------------

export function applyYaml(
  db: ClusterDb,
  text: string,
  mode: ApplyMode,
  namespace: string | null,
): KubeObject[] {
  const docs = YAML.parseAllDocuments(text).map((d) => {
    if (d.errors.length) throw new Error(d.errors[0]!.message);
    return d.toJSON() as KubeObject | null;
  });
  const out: KubeObject[] = [];
  for (const doc of docs) {
    if (!doc) continue;
    if (!doc.apiVersion || !doc.kind || !doc.metadata?.name)
      throw new Error('Every document needs apiVersion, kind and metadata.name.');
    const gvk = resolveRef(doc.apiVersion, doc.kind);
    if (!gvk) throw new Error(`no matches for kind "${doc.kind}" in version "${doc.apiVersion}"`);
    const crd = list(db, 'customresourcedefinitions.apiextensions.k8s.io').find(
      (c) => c.spec?.names?.kind === doc.kind,
    );
    const namespaced = crd ? crd.spec?.scope === 'Namespaced' : gvk.namespaced;
    if (namespaced) doc.metadata.namespace = doc.metadata.namespace || namespace || 'default';
    else delete doc.metadata.namespace;
    const key = [...db.kinds.keys()].find((k) => k === kindKey(gvk)) ?? kindKey(gvk);
    const existing = find(db, key, doc.metadata.namespace ?? null, doc.metadata.name);
    if (existing && mode === 'create')
      throw new Error(`${gvk.plural} "${doc.metadata.name}" already exists`);
    if (existing) {
      const next = (mode === 'replace' ? { ...doc } : mergePatch(existing, doc)) as KubeObject;
      next.metadata = {
        ...existing.metadata,
        ...doc.metadata,
        uid: existing.metadata.uid,
        creationTimestamp: existing.metadata.creationTimestamp,
      };
      const templateChanged =
        JSON.stringify(existing.spec?.template) !== JSON.stringify(next.spec?.template);
      if (JSON.stringify(existing.spec) !== JSON.stringify(next.spec))
        next.metadata.generation = (existing.metadata.generation ?? 1) + 1;
      db.kinds.get(key)?.delete(existing.metadata.uid);
      put(db, next);
      if (['Deployment', 'StatefulSet', 'DaemonSet'].includes(next.kind) && templateChanged)
        rolloutRestart(db, next);
      else if (next.spec?.replicas !== existing.spec?.replicas) reconcile(db, next);
      out.push(next);
      continue;
    }
    doc.metadata = { ...doc.metadata, uid: '', creationTimestamp: nowIso() };
    const created = put(db, doc);
    afterCreate(db, created);
    out.push(created);
  }
  return out;
}

function afterCreate(db: ClusterDb, o: KubeObject) {
  if (o.kind === 'Namespace') {
    o.status = { phase: 'Active' };
    o.spec = { finalizers: ['kubernetes'], ...o.spec };
    put(db, o);
  } else if (o.kind === 'Deployment') {
    o.spec = { replicas: 1, ...o.spec };
    o.metadata.annotations = {
      ...o.metadata.annotations,
      'deployment.kubernetes.io/revision': '0',
    };
    put(db, o);
    rolloutRestart(db, o);
  } else if (o.kind === 'StatefulSet' || o.kind === 'DaemonSet' || o.kind === 'ReplicaSet') {
    reconcile(db, o);
  } else if (o.kind === 'Pod') {
    drop(db, o);
    const template: PodTemplate = {
      metadata: { labels: o.metadata.labels ?? {} },
      spec: o.spec ?? {},
    };
    spawnPod(db, null, template, {
      namespace: o.metadata.namespace ?? 'default',
      name: o.metadata.name,
    });
  } else if (o.kind === 'Job') {
    const template = o.spec?.template as PodTemplate;
    if (template)
      spawnPod(db, o, template, {
        namespace: o.metadata.namespace!,
        job: true,
        onDone: () => syncOwner(db, o),
      });
  }
}

// -- Helm ---------------------------------------------------------------------

function helmRecord(db: ClusterDb, namespace: string, name: string) {
  const rec = db.helm.get(helmKey(namespace, name));
  if (!rec) throw new Error(`release: not found`);
  return rec;
}

export function helmRollback(db: ClusterDb, namespace: string, name: string, revision: number) {
  const rec = helmRecord(db, namespace, name);
  const target = rec.history.find((r) => r.revision === revision);
  if (!target) throw new Error(`release has no ${revision} version`);
  const current = rec.history[rec.history.length - 1]!;
  current.status = 'superseded';
  rec.history.push({
    ...target,
    revision: current.revision + 1,
    status: 'deployed',
    updated: nowIso(),
    description: `Rollback to ${revision}`,
  });
  rec.values.push(rec.values[revision - 1] ?? rec.values[rec.values.length - 1] ?? '');
  syncHelmSecrets(db, namespace, name);
  return helmDetail(rec);
}

export function helmUpgradeValues(db: ClusterDb, namespace: string, name: string, values: string) {
  YAML.parse(values);
  const rec = helmRecord(db, namespace, name);
  const current = rec.history[rec.history.length - 1]!;
  current.status = 'superseded';
  rec.history.push({
    ...current,
    revision: current.revision + 1,
    status: 'deployed',
    updated: nowIso(),
    description: 'Upgrade complete',
  });
  rec.values.push(values);
  syncHelmSecrets(db, namespace, name);
}

export function helmUninstall(db: ClusterDb, namespace: string, name: string) {
  helmRecord(db, namespace, name);
  db.helm.delete(helmKey(namespace, name));
  for (const s of helmSecrets(db, namespace, name)) drop(db, s);
}
