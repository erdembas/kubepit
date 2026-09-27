import * as i18n from '@/i18n/core';
import type { KubeObject } from '@/types';
import { asArray, asNumber, asObject, asString, field, isObject, spec } from '../accessors';
import { makeFinding, nsKey, podSpecOf, type Emit } from './context';
import type { HealthInput } from './types';

/** Unreferenced ConfigMaps and Secrets, plus the reference index shared with storage rules. */

export const SYSTEM_NAMESPACES = new Set(['kube-system', 'kube-public', 'kube-node-lease']);

/** Published into every namespace by the control plane or a mesh; never "unused". */
const WELL_KNOWN_CONFIGMAPS = new Set([
  'kube-root-ca.crt',
  'openshift-service-ca.crt',
  'istio-ca-root-cert',
  'linkerd-identity-trust-roots',
]);

const MANAGED_SECRET_TYPES = new Set([
  'kubernetes.io/service-account-token',
  'helm.sh/release.v1',
  'bootstrap.kubernetes.io/token',
]);

export interface References {
  configMaps: Set<string>;
  secrets: Set<string>;
  claims: Set<string>;
}

interface Refs {
  configMaps: string[];
  secrets: string[];
  claims: string[];
}

const SECRET_REF_KEYS = new Set([
  'secretRef',
  'secretKeyRef',
  'nodePublishSecretRef',
  'nodeStageSecretRef',
  'nodeExpandSecretRef',
  'controllerPublishSecretRef',
  'controllerExpandSecretRef',
]);

/** Walks a pod spec once and collects every ConfigMap / Secret / claim name it names. */
function collect(value: unknown, out: Refs, depth = 0): void {
  if (depth > 12) return;
  if (Array.isArray(value)) {
    for (const v of value) collect(v, out, depth + 1);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, v] of Object.entries(value)) {
    if (key === 'configMap' || key === 'configMapRef' || key === 'configMapKeyRef') {
      const name = asString(asObject(v).name);
      if (name) out.configMaps.push(name);
    } else if (key === 'secret') {
      const s = asObject(v);
      const name = asString(s.secretName) || asString(s.name);
      if (name) out.secrets.push(name);
    } else if (SECRET_REF_KEYS.has(key)) {
      const name = asString(asObject(v).name);
      if (name) out.secrets.push(name);
    } else if (key === 'secretName' && typeof v === 'string') {
      out.secrets.push(v);
    } else if (key === 'imagePullSecrets') {
      for (const s of asArray(v).filter(isObject)) if (s.name) out.secrets.push(asString(s.name));
      continue;
    } else if (key === 'persistentVolumeClaim') {
      const name = asString(asObject(v).claimName);
      if (name) out.claims.push(name);
    }
    if (typeof v === 'object' && v !== null) collect(v, out, depth + 1);
  }
}

const refCache = new WeakMap<KubeObject, Refs>();

/** References of one object's pod spec, memoized per object snapshot. */
export function podSpecReferences(obj: KubeObject): Refs {
  const hit = refCache.get(obj);
  if (hit) return hit;
  const out: Refs = { configMaps: [], secrets: [], claims: [] };
  const podSpec = podSpecOf(obj);
  if (podSpec) collect(podSpec, out);
  refCache.set(obj, out);
  return out;
}

export function collectReferences(input: HealthInput): References {
  const refs: References = { configMaps: new Set(), secrets: new Set(), claims: new Set() };
  const owners = [
    ...input.pods,
    ...input.deployments,
    ...input.statefulSets,
    ...input.daemonSets,
    ...input.jobs,
    ...input.cronJobs,
  ];
  for (const o of owners) {
    const ns = o.metadata.namespace;
    const r = podSpecReferences(o);
    for (const n of r.configMaps) refs.configMaps.add(nsKey(ns, n));
    for (const n of r.secrets) refs.secrets.add(nsKey(ns, n));
    for (const n of r.claims) refs.claims.add(nsKey(ns, n));
  }
  // StatefulSet pods mount `<template>-<set>-<ordinal>`; a pending replica still owns its claim.
  for (const sts of input.statefulSets) {
    const replicas = Math.min(asNumber(spec(sts).replicas, 1), 1_000);
    for (const t of asArray(spec(sts).volumeClaimTemplates).filter(isObject)) {
      const name = asString(asObject(t.metadata).name);
      for (let i = 0; name && i < replicas; i++)
        refs.claims.add(nsKey(sts.metadata.namespace, `${name}-${sts.metadata.name}-${i}`));
    }
  }
  for (const sa of input.serviceAccounts) {
    const ns = sa.metadata.namespace;
    for (const key of ['secrets', 'imagePullSecrets'])
      for (const s of asArray(field(sa, key)).filter(isObject))
        if (s.name) refs.secrets.add(nsKey(ns, asString(s.name)));
  }
  for (const ing of input.ingresses)
    for (const tls of asArray(spec(ing).tls).filter(isObject))
      if (tls.secretName) refs.secrets.add(nsKey(ing.metadata.namespace, asString(tls.secretName)));
  // cert-manager writes these secrets; whoever consumes them (often outside the cluster) is unknown.
  for (const cert of input.certificates)
    if (spec(cert).secretName)
      refs.secrets.add(nsKey(cert.metadata.namespace, asString(spec(cert).secretName)));
  return refs;
}

function managed(obj: KubeObject): boolean {
  return (
    SYSTEM_NAMESPACES.has(obj.metadata.namespace ?? '') || !!obj.metadata.ownerReferences?.length
  );
}

export function unusedConfigFindings(input: HealthInput, refs: References, emit: Emit) {
  for (const cm of input.configMaps) {
    if (managed(cm) || WELL_KNOWN_CONFIGMAPS.has(cm.metadata.name)) continue;
    if (refs.configMaps.has(nsKey(cm.metadata.namespace, cm.metadata.name))) continue;
    emit(makeFinding('configmap-unused', cm, i18n.t('Not referenced by any pod or workload')));
  }
  if (input.loaded.has('secrets'))
    for (const s of input.secrets) {
      if (managed(s) || MANAGED_SECRET_TYPES.has(asString(field(s, 'type')))) continue;
      if (s.metadata.name.startsWith('sh.helm.release.v1.')) continue;
      // Argo CD discovers repository and cluster secrets by label.
      if (s.metadata.labels?.['argocd.argoproj.io/secret-type']) continue;
      if (refs.secrets.has(nsKey(s.metadata.namespace, s.metadata.name))) continue;
      emit(
        makeFinding(
          'secret-unused',
          s,
          i18n.t('Not referenced by any pod, workload, service account or ingress'),
        ),
      );
    }
}
