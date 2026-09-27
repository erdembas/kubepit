import { asArray, asObject, asString, isObject, type JsonObject } from '../accessors';
import type { EdgeKind } from './model';

/**
 * Objects a pod spec references by name: ConfigMaps and Secrets (volumes,
 * projected volumes, envFrom, env valueFrom, imagePullSecrets), claims
 * (persistentVolumeClaim and generic ephemeral volumes), the service account
 * and the node. Used for pods and for pod templates of idle workloads.
 */

export interface PodSpecRef {
  kind: 'ConfigMap' | 'Secret' | 'PersistentVolumeClaim' | 'ServiceAccount' | 'Node';
  name: string;
  edge: EdgeKind;
}

/**
 * The CA bundle every service-account token volume projects
 * (`kube-api-access-*`); linking it would tie every pod to one ConfigMap.
 */
const INJECTED_CA = new Set(['kube-root-ca.crt', 'openshift-service-ca.crt']);

function containersOf(spec: JsonObject): JsonObject[] {
  return [
    ...asArray(spec.initContainers),
    ...asArray(spec.containers),
    ...asArray(spec.ephemeralContainers),
  ].filter(isObject);
}

/**
 * References of a pod spec. `podName` names generic ephemeral volume claims
 * (`<pod>-<volume>`); pass null for templates.
 */
export function podSpecRefs(specValue: unknown, podName: string | null): PodSpecRef[] {
  const spec = asObject(specValue);
  const out: PodSpecRef[] = [];
  const seen = new Set<string>();
  const add = (kind: PodSpecRef['kind'], name: string, edge: EdgeKind) => {
    if (!name) return;
    const key = `${kind}/${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, name, edge });
  };

  for (const v of asArray(spec.volumes).filter(isObject)) {
    if (isObject(v.configMap)) add('ConfigMap', asString(v.configMap.name), 'mounts');
    if (isObject(v.secret)) add('Secret', asString(v.secret.secretName), 'mounts');
    if (isObject(v.persistentVolumeClaim))
      add('PersistentVolumeClaim', asString(v.persistentVolumeClaim.claimName), 'claims');
    if (isObject(v.ephemeral) && podName)
      add('PersistentVolumeClaim', `${podName}-${asString(v.name)}`, 'claims');
    if (isObject(v.projected)) {
      const sources = asArray(v.projected.sources).filter(isObject);
      const tokenVolume = sources.some((s) => isObject(s.serviceAccountToken));
      for (const s of sources) {
        if (isObject(s.configMap)) {
          const name = asString(s.configMap.name);
          if (!(tokenVolume && INJECTED_CA.has(name))) add('ConfigMap', name, 'mounts');
        }
        if (isObject(s.secret)) add('Secret', asString(s.secret.name), 'mounts');
      }
    }
  }

  for (const c of containersOf(spec)) {
    for (const from of asArray(c.envFrom).filter(isObject)) {
      if (isObject(from.configMapRef)) add('ConfigMap', asString(from.configMapRef.name), 'env');
      if (isObject(from.secretRef)) add('Secret', asString(from.secretRef.name), 'env');
    }
    for (const env of asArray(c.env).filter(isObject)) {
      const valueFrom = asObject(env.valueFrom);
      if (isObject(valueFrom.configMapKeyRef))
        add('ConfigMap', asString(valueFrom.configMapKeyRef.name), 'env');
      if (isObject(valueFrom.secretKeyRef))
        add('Secret', asString(valueFrom.secretKeyRef.name), 'env');
    }
  }

  for (const s of asArray(spec.imagePullSecrets).filter(isObject))
    add('Secret', asString(s.name), 'pull-secret');

  add(
    'ServiceAccount',
    asString(spec.serviceAccountName) || asString(spec.serviceAccount) || 'default',
    'identity',
  );
  add('Node', asString(spec.nodeName), 'runs-on');
  return out;
}
