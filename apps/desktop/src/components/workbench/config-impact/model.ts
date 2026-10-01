import { asArray, asObject, asString, get } from '@/lib/kube/accessors';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import type { Gvk, KubeObject } from '@/types';

export const IMPACT_KINDS = [
  BUILTIN.Deployment,
  BUILTIN.StatefulSet,
  BUILTIN.DaemonSet,
  BUILTIN.Pod,
  BUILTIN.ReplicaSet,
  BUILTIN.Job,
  BUILTIN.CronJob,
  BUILTIN.ReplicationController,
] as const;
export const MAX_SOURCE_OBJECTS = 500;
export const MAX_IMPACT_OBJECTS = 2_000;
export const MAX_IMPACT_CONSUMERS = 200;
export const MAX_USES_PER_OBJECT = 100;
const RESTARTABLE = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);

export interface ConfigReference {
  kind: 'ConfigMap' | 'Secret';
  name: string;
  namespace: string;
}

export interface ConfigKeyChange {
  key: string;
  operation: 'added' | 'changed' | 'removed';
}

export type UseMode = 'env' | 'envFrom' | 'volume' | 'projected' | 'subPath' | 'imagePullSecret';
export type RefreshMode = 'replace' | 'application' | 'pull';
export type ConfigImpactMode = 'changed-keys' | 'all-references';

/** References only: never contains config values, env values, or Secret data. */
export interface ConfigUse {
  mode: UseMode;
  refresh: RefreshMode;
  container: string;
  containerType: 'containers' | 'initContainers' | 'ephemeralContainers' | null;
  keys: string[];
  /** Whole-object references remain consumers even when the config is empty. */
  allKeys?: boolean;
  /** Only populated in the consumer browser, where input keys are the current inventory. */
  missingKeys?: string[];
  binding: string;
  optional: boolean;
  /** Dynamic subPathExpr cannot be resolved without inspecting environment values. */
  uncertain: boolean;
}

export interface ConfigConsumer {
  id: string;
  kind: string;
  name: string;
  namespace: string;
  uid: string;
  resourceVersion: string;
  gvk: Gvk;
  owner: { kind: string; name: string } | null;
  restartable: boolean;
  restartRequired: boolean;
  uses: ConfigUse[];
  truncated: boolean;
}

export interface ConfigImpact {
  consumers: ConfigConsumer[];
  inspected: number;
  truncated: boolean;
}

function objectPodSpec(obj: KubeObject) {
  if (obj.kind === 'Pod') return asObject(obj.spec);
  return asObject(
    get(obj, obj.kind === 'CronJob' ? 'spec.jobTemplate.spec.template.spec' : 'spec.template.spec'),
  );
}

/** Key-level references, retaining every usage (env and volume must not collapse). */
export function configUses(
  obj: KubeObject,
  target: ConfigReference,
  changedKeys: readonly string[],
  mode: ConfigImpactMode = 'changed-keys',
): { uses: ConfigUse[]; truncated: boolean } {
  if (obj.metadata.namespace !== target.namespace) return { uses: [], truncated: false };
  const pod = objectPodSpec(obj);
  const keys = [...new Set(changedKeys)].slice(0, 1_000);
  const allReferences = mode === 'all-references';
  let truncated = changedKeys.length > 1_000;
  const uses: ConfigUse[] = [];
  const bounded = (value: unknown, limit = 1_000): unknown[] => {
    const items = asArray(value);
    if (items.length > limit) truncated = true;
    return items.slice(0, limit);
  };
  const add = (use: ConfigUse) => {
    if (!use.keys.length && !use.allKeys) return;
    if (allReferences) use.missingKeys = use.keys.filter((key) => !changedKeys.includes(key));
    if (uses.length < MAX_USES_PER_OBJECT) uses.push(use);
    else truncated = true;
  };
  const volumes = bounded(pod.volumes, 100).map(asObject);
  for (const containerType of ['containers', 'initContainers', 'ephemeralContainers'] as const) {
    for (const rawContainer of bounded(pod[containerType], 100)) {
      const container = asObject(rawContainer);
      const name = asString(container.name);
      for (const rawEnv of bounded(container.env)) {
        const env = asObject(rawEnv);
        const ref = asObject(
          asObject(env.valueFrom)[target.kind === 'Secret' ? 'secretKeyRef' : 'configMapKeyRef'],
        );
        const key = asString(ref.key);
        if (ref.name === target.name && key && (allReferences || keys.includes(key)))
          add({
            mode: 'env',
            refresh: 'replace',
            container: name,
            containerType,
            keys: [key],
            binding: asString(env.name),
            optional: ref.optional === true,
            uncertain: false,
          });
      }
      for (const rawFrom of bounded(container.envFrom)) {
        const from = asObject(rawFrom);
        const ref = asObject(from[target.kind === 'Secret' ? 'secretRef' : 'configMapRef']);
        if (ref.name === target.name)
          add({
            mode: 'envFrom',
            refresh: 'replace',
            container: name,
            containerType,
            keys,
            allKeys: allReferences,
            binding: asString(from.prefix),
            optional: ref.optional === true,
            uncertain: false,
          });
      }
      for (const rawMount of bounded(container.volumeMounts, 100)) {
        const mount = asObject(rawMount);
        const volume = volumes.find((v) => v.name === mount.name);
        if (!volume) continue;
        const directField = target.kind === 'Secret' ? 'secret' : 'configMap';
        const sources = [
          { ref: asObject(volume[directField]), projected: false },
          ...bounded(asObject(volume.projected).sources, 100).map((source) => ({
            ref: asObject(asObject(source)[directField]),
            projected: true,
          })),
        ];
        for (const { ref, projected } of sources) {
          const refName = target.kind === 'Secret' && !projected ? ref.secretName : ref.name;
          if (refName !== target.name) continue;
          const items = bounded(ref.items).map(asObject);
          const subPath = asString(mount.subPath);
          const expression = asString(mount.subPathExpr);
          const candidates = allReferences
            ? items.length
              ? items.map((item) => asString(item.key)).filter(Boolean)
              : subPath
                ? [subPath]
                : keys
            : keys;
          const affected = [...new Set(candidates)].filter((key) => {
            const projectedPaths = items.length
              ? items.filter((item) => item.key === key).map((item) => asString(item.path))
              : [key];
            return projectedPaths.some(
              (path) => !subPath || path === subPath || path.startsWith(`${subPath}/`),
            );
          });
          add({
            mode: subPath || expression ? 'subPath' : projected ? 'projected' : 'volume',
            refresh: subPath || expression ? 'replace' : 'application',
            container: name,
            containerType,
            keys: affected,
            allKeys: allReferences && !items.length && !subPath,
            binding: `${asString(mount.name)} → ${asString(mount.mountPath)}${subPath || expression ? ` (${subPath || expression})` : ''}`,
            optional: ref.optional === true,
            uncertain: !!expression,
          });
        }
      }
    }
  }
  if (target.kind === 'Secret')
    for (const rawRef of bounded(pod.imagePullSecrets, 100))
      if (asObject(rawRef).name === target.name)
        add({
          mode: 'imagePullSecret',
          refresh: 'pull',
          container: '',
          containerType: null,
          keys,
          allKeys: allReferences,
          binding: target.name,
          optional: false,
          uncertain: false,
        });
  return { uses, truncated };
}

export function buildConfigImpact(
  target: ConfigReference,
  changes: readonly ConfigKeyChange[],
  objects: readonly KubeObject[],
  mode: ConfigImpactMode = 'changed-keys',
): ConfigImpact {
  const consumers: ConfigConsumer[] = [];
  const seen = new Set<string>();
  let truncated = objects.length > MAX_IMPACT_OBJECTS;
  const inspected = Math.min(objects.length, MAX_IMPACT_OBJECTS);
  for (const obj of objects.slice(0, MAX_IMPACT_OBJECTS)) {
    const builtin = IMPACT_KINDS.find(
      (k) =>
        k.kind === obj.kind && obj.apiVersion === (k.group ? `${k.group}/${k.version}` : k.version),
    );
    if (!builtin) continue;
    const result = configUses(
      obj,
      target,
      changes.map((c) => c.key),
      mode,
    );
    truncated ||= result.truncated;
    if (!result.uses.length) continue;
    const id = `${obj.kind}/${obj.metadata.namespace}/${obj.metadata.name}/${obj.metadata.uid ?? ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (consumers.length >= MAX_IMPACT_CONSUMERS) {
      truncated = true;
      continue;
    }
    const owner = obj.metadata.ownerReferences?.find((ref) => ref.controller);
    consumers.push({
      id,
      kind: obj.kind,
      name: obj.metadata.name,
      namespace: target.namespace,
      uid: obj.metadata.uid ?? '',
      resourceVersion: obj.metadata.resourceVersion ?? '',
      gvk: toGvk(builtin),
      owner: owner ? { kind: owner.kind, name: owner.name } : null,
      restartable: RESTARTABLE.has(obj.kind),
      restartRequired: result.uses.some((use) => use.refresh === 'replace'),
      uses: result.uses,
      truncated: result.truncated,
    });
  }
  return { consumers, inspected, truncated };
}

/** Preconditions are included in the mutation itself, closing the GET → PATCH race. */
export function reviewedMetadata(obj: KubeObject): { uid: string; resourceVersion: string } | null {
  return obj.metadata.uid && obj.metadata.resourceVersion
    ? { uid: obj.metadata.uid, resourceVersion: obj.metadata.resourceVersion }
    : null;
}

export function restartPatch(obj: KubeObject, timestamp: string): Record<string, unknown> | null {
  const metadata = reviewedMetadata(obj);
  if (!metadata || !RESTARTABLE.has(obj.kind) || !get(obj, 'spec.template.spec')) return null;
  return {
    metadata,
    spec: {
      template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': timestamp } } },
    },
  };
}
